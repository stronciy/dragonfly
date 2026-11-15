# Dragonfly Backend

Next.js API + WebSocket server for the Dragonfly agri-tech marketplace.

Standalone project (не монорепо). Усі залежності та спільний код — всередині цього проєкту.

## Quick start

```bash
npm install
npm run prisma:generate   # Prisma Client → generated/prisma + mirror у node_modules/.prisma/client
npm run dev               # = node server.js (Next.js + WebSocket + Redis presence)
```

**Доступ:** `http://localhost:3000` · WebSocket: `ws://localhost:3000/ws` · Health: `http://localhost:3000/api/v1/health`.

Потрібні запущені сервіси: PostgreSQL (за замовчуванням `localhost:5432`) та Redis (`REDIS_URL`).

## Email / SMTP

Листи (код відновлення пароля адміністратора, повідомлення адміністратора користувачу) ідуть через SMTP:

```bash
SMTP_HOST=mail.dragonfly.ua
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=noreply@dragonfly.ua
SMTP_PASS="..."                       # пароль поштового ящика
MAIL_FROM="Dragonfly <noreply@dragonfly.ua>"
```

Для порту `465` обов'язково `SMTP_SECURE=true` (implicit TLS). Для `587` — `false` + STARTTLS.
Якщо SMTP не задано, відновлення пароля адміністратора повертає помилку, а листи
адміністратора користувачам не надсилаються.

## Commands

```bash
npm run dev          # node server.js (production-like: Next.js + WS)
npm run dev:next     # тільки Next.js dev (БЕЗ WebSocket)
npm run build        # next build → .next/
npm run start        # node server.js (production)
npm run lint         # next lint
npm run prisma:generate
npm run db:deploy    # prisma migrate deploy
npm run db:status
npm run db:reset     # --force (ВИДАЛЯЄ ДАНІ)
npm test             # = tsx --test tests/unit/*.test.ts
```

## Структура

```
src/app/api/v1/        # 45 route handlers (Next.js App Router)
src/lib/               # auth, middleware, apiResponse, errors, prisma, deposit,
                       # orderStatus, matching, pagination, uploads, validators, cookies
src/queues/            # BullMQ v5 — 4 черги (enqueue з API)
src/realtime/          # Redis pub/sub (domain-events-v1) + WebSocket presence
src/services/          # ExpoPush, LiqPay, Stripe, deposit, ratings, arbitration, earlyStart, notify
src/shared.ts          # barrel → імпорт як "@/shared"
prisma/                # schema.prisma + migrations/
prisma.config.ts       # Prisma 7 (experimental.externalTables=true)
middleware.ts          # CORS + rate-limit + idempotency
server.js              # Custom server: Next.js + WebSocket
```

Спільний код (lib/prisma, lib/errors, lib/deposit, lib/orderStatus, lib/matching, queues, realtime, services) — **дубльований** окремо в `worker/`-проєкті. Зміни в цих файлах треба переносити в обидва проєкти вручну.

## Telegram-сповіщення адміністраторів

Події платформи (реєстрації, замовлення, оплати, запити на виведення, арбітраж) надсилаються адміністраторам у Telegram.

- `src/instrumentation.ts` запускає опитування (`src/lib/adminNotifications/poller.ts`) кожні 15 с. Джерела — таблиці БД з курсорами (`admin_event_cursors`), тому події не губляться при перезапуску і не потребують змін у маршрутах.
- Тип події додається в `src/lib/adminNotifications/catalog.ts` і в `sources.ts`. Копія каталогу для UI не потрібна: панель отримує список з API.
- Вибірка зберігається в `admin_notification_settings` (за замовчуванням увімкнено все). Змінити можна в панелі («Сповіщення») або в боті командою `/settings`.
- Опитування запускається тільки коли задано `TELEGRAM_BOT_TOKEN`.

Змінні середовища:

- `TELEGRAM_BOT_TOKEN` — токен від @BotFather.
- `TELEGRAM_BOT_USERNAME` — імʼя бота без `@` (для посилання прив'язки).
- `TELEGRAM_WEBHOOK_SECRET` — довільний рядок (1–256 символів `A-Za-z0-9_-`), перевіряється в заголовку вебхука.
- `ADMIN_PANEL_URL` — адреса адмін-панелі для посилань у повідомленнях (необов'язково).

Підключення вебхука (один раз після деплою):

```bash
curl -sS "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://api.dragonfly.ua/api/v1/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["message","callback_query"]'
```

Команди бота: `/start КОД` (прив'язка), `/settings` (кнопки вибірки), `/stop` (відключити), `/help`.

Обмеження: опитування працює в одному екземплярі бекенду. При горизонтальному масштабуванні потрібен лок (наприклад, Redis `SET NX`).

## Prisma

Prisma 7 + `@prisma/adapter-pg` (driver adapter, НЕ engine). Схема: `prisma/schema.prisma`, output `../generated/prisma` → `generated/prisma/`. `npm run prisma:generate` також створює симлінк `node_modules/.prisma/client → ../../generated/prisma`, щоб `import { Prisma } from "@prisma/client"` бачив типи.

**Не вимикай** `experimental.externalTables` в `prisma.config.ts` — потрібен для raw-SQL міграцій.

## Деплой

Docker/CI тимчасово видалені (переписуються). Два окремі deployment: `dragonfly` (цей бекенд) і `workerdragonfly` (воркер) на CapRover.

Див. `AGENTS.md` — архітектура, патерни, gotchas.
