# AGENTS.md — dragonfly backend

Український agri-tech маркетплейс: замовник (customer) публікує замовлення на сільгосп-послугу, виконавець (performer) з покриттям за радіусом приймає його. Web (Next.js) + Mobile (Expo/React Native) + WebSocket realtime.

Це **автономний проєкт** (не монорепо). Увесь спільний код (`lib/prisma`, `lib/errors`, `lib/deposit`, `lib/orderStatus`, `lib/matching`, `queues`, `realtime`, `services`, `prisma`) живе **всередині** цього проєкту. Той самий спільний код **дубльований** у сусідньому проєкті `worker/` — зміни в спільних файлах треба переносити в обидва проєкти вручну. Усе, що імпортувалось як `@dragonfly/core`, тепер імпортується як `@/shared` (barrel `src/shared.ts`).

## Quick start

```bash
# Команди виконуються з КОРЕНЯ цього проєкту (backend/).
# Сервіси мають бути запущені (PostgreSQL на :5432, Redis)
npm install
npm run prisma:generate   # Prisma Client → generated/prisma + mirror node_modules/.prisma/client

npm run dev               # = node server.js (Next.js + WebSocket + Redis presence)
npm run dev:next          # тільки Next.js (БЕЗ WebSocket — тільки для frontend розробки)

# Тести
npm test                  # = tsx --test tests/unit/*.test.ts (з source, без компіляції)
```

**Доступ:** `http://localhost:3000` (LAN: `http://192.168.0.136:3000`). **WebSocket:** `ws://localhost:3000/wws` або `ws://localhost:3000/api/v1/ws`. Health: `http://localhost:3000/api/v1/health`.

**CORS allowlist** у двох місцях — додай свій LAN IP, якщо відрізняється від `192.168.0.136`:
- `middleware.ts` рядки 5–12 (для API)
- `next.config.ts` рядки 5–16 (для Next.js dev)

## Required env vars

Усі читаються з `process.env` напряму (НЕ через `.env` в runtime — тільки через `dotenv` в `server.js`/`prisma.config.ts`).

| Змінна | Обов'язкова? | Призначення |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL connection string. Якщо не встановлено в `prisma.config.ts` — fallback на `localhost:5432/postgres`. У проді обов'язково. |
| `REDIS_URL` | ✅ (для realtime/queue/middleware) | BullMQ + WebSocket presence + middleware. Graceful degradation — див. нижче. |
| `JWT_ACCESS_SECRET` | ✅ | HS256 секрет для access token (15 хв). |
| `JWT_REFRESH_SECRET` | ✅ | HS256 секрет для refresh token (7 днів). |
| `EXPO_ACCESS_TOKEN` | optional | Для Expo Push. Якщо порожній або невалідний формат — Expo працює без нього, але з warning. |
| `LIQPAY_PUBLIC_KEY` / `LIQPAY_PRIVATE_KEY` / `LIQPAY_SANDBOX` | коли використовується LiqPay | `LIQPAY_SANDBOX=true` вмикає sandbox endpoint. |
| `STRIPE_SECRET_KEY` | коли використовується Stripe | Сервіс кидає 503 якщо не встановлено. |
| `PORT` | optional | default `3000` |
| `NODE_ENV` | optional | `production` вмикає secure cookies, вимикає verbose logging |
| `HEALTHCHECK_TOKEN` | optional | Якщо встановлено — `GET /api/v1/health?detailed=1` вимагає header `x-health-token` |
| `PUSH_SKIP_IF_ONLINE` | optional | `true` — не надсилати Expo Push, якщо користувач зараз онлайн через WebSocket |

## Architecture

### Layout

```
src/
  app/
    api/v1/                  # 45 route handlers (Next.js App Router, всі під /api/v1)
    layout.tsx, page.tsx     # default Next.js boilerplate — НЕ редагуй (домен UI на mobile)
    globals.css
  lib/
    auth/                    # requireAuth, rbac, tokens (jose JWT)
    middleware/              # idempotency, retryAfter (rate-limit) — використовуються в middleware.ts
    apiResponse.ts           # ok()/fail() envelope
    cookies.ts               # refresh-token cookie helpers
    errors.ts                # ApiError + retryable flag
    deposit.ts               # deposit helpers
    orderStatus.ts           # state machine helpers
    matching.ts              # serviceTypeMatches, formatOrderDateRange
    pagination.ts            # Zod schema + helpers
    prisma.ts                # singleton PrismaClient (з @prisma/adapter-pg)
    uploads.ts               # multipart reader → data URL (≤10MB)
    validators.ts            # EDRPOU, UA IBAN (mod-97 checksum)
  queues/                    # BullMQ v5 — 4 черги (connection/jobs/queues) — enqueue з API
  realtime/                  # Redis pub/sub (channel: domain-events-v1) + presence
  services/                  # ExpoPush, LiqPay, Stripe, deposit, ratings, arbitration, earlyStart, notify
  shared.ts                  # barrel — усе, що імпортується як "@/shared"
prisma/
  schema.prisma              # 17 моделей, 2 enum-и (UserRole, TaxSystem)
  migrations/                # 26 міграцій (з них 20260329214130_30_march — major refactor)
  migration_lock.toml        # provider = "postgresql"
generated/prisma/            # Prisma Client output (генерується, .gitignore)
services-tree.ts             # каталог послуг (validateSpecs/getCategoryById тощо), імпорт `@/../services-tree`
scripts/                     # e2e_*.mjs, seed_demo.mjs, check-endpoints.js
tests/unit/                  # node:test + tsx (з source)
middleware.ts                # Next.js middleware: CORS + rate-limit + idempotency
server.js                    # Custom Node server: Next.js + WebSocket + Redis presence
prisma.config.ts             # Prisma 7 config з experimental.externalTables=true
next.config.ts               # allowedDevOrigins (LAN IP)
tsconfig.json                # paths "@/*" → src/*
```

### Key facts an agent would miss

1. **Custom server (`server.js`) — НЕ `next dev`.** `npm run dev` запускає `node server.js`, який піднімає Next.js всередині custom HTTP сервера і додає WebSocket upgrade handler на `/ws` і `/api/v1/ws`. Це єдиний спосіб отримати WebSocket realtime.

2. **Prisma Client з driver adapter.** Це **Prisma 7** з `@prisma/adapter-pg` (НЕ старий engine-based client). Схема: `prisma/schema.prisma` з `output = "../generated/prisma"` → `generated/prisma`. У `src/lib/prisma.ts` імпорт `../../generated/prisma/client`. Деякі файли імпортують `Prisma` (типи) з `@prisma/client` — тому `npm run prisma:generate` створює **симлінк** `node_modules/.prisma/client → ../../generated/prisma`, щоб TS бачила один тип. **Не видаляй симлінк вручну.**

3. **`experimental: { externalTables: true }`** в `prisma.config.ts` — критично. Дозволяє робити raw SQL migrations (seed data, manual `CREATE TABLE` як в `20260329_create_legal_profiles_table`) без втрати Prisma tracking. Не вимикай.

4. **Build artifact:** `npm run build` → `next build` → `.next/`. Тести НЕ компілюються — `npm test` запускає `tsx --test tests/unit/*.test.ts` безпосередньо з TypeScript-джерела (tsx резолвить `@/*` aliases та relative імпорти з source-локації, тому deep-relative `../../generated/prisma/client` працює коректно).

5. **Graceful degradation на відсутній `REDIS_URL`.** Якщо `REDIS_URL` не встановлено:
   - `idempotencyMiddleware` / `retryAfterMiddleware` (в `middleware.ts`) — пропускають запит (warning у dev)
   - `realtime/publishDomainEvent` — логують warning, не публікують
   - `realtime/presence` — повертає порожні результати
   - **BullMQ queues** (enqueue з API) — кидають помилку при спробі enqueue

6. **Auth flow:**
   - Access token: `Authorization: Bearer <jwt>` (15 хв, HS256, payload: `{userId, email, role}`)
   - Refresh token: httpOnly cookie `refreshToken` з `path=/api/v1/auth`, `maxAge=7d`, `secure` тільки в production. У DB зберігається SHA-256 хеш (НЕ оригінал), див. `RefreshToken.tokenHash`.
   - Logout: `POST /api/v1/auth/logout` ревокає хеш в DB і чистить cookie.
   - `requireUser()` робить DB lookup — користувач вилучається щоразу з `prisma.user.findUnique` (lightweight select).

7. **WebSocket flow:** server.js auth'ить JWT на upgrade → зберіває `ws.userId`/`ws.role` → підписується на Redis channel `domain-events-v1` → пушить `ws.send(message)` коли `event.targets.userIds` містить його userId. **Клієнти НЕ підписуються на конкретні orderId** — routing завжди по userId. Refresh presence кожні 30с через ping/pong. У dev можна передавати токен через query `?token=<jwt>`.

8. **Service IDs — ієрархічні рядки ("1.2.3").** Категорія = `"1"`, підкатегорія = `"1.2"`, тип = `"1.2.3"`. `PerformerService.serviceId` зберігає будь-який з цих рівнів. Matching у workers шукає по 4 правилах (type → subcategory → category → parent через `split_part`).

9. **PostGIS ВИДАЛЕНО** (міграція `20260320202020_remove_postgis`). Всі geo-обчислення — Haversine в raw SQL (`acos(cos(radians(lat1)) * cos(radians(lat2)) * ...)`). Індексів на (lat,lng) немає — кандидат для оптимізації.

10. **Order status state machine (string, не enum):**
    `draft → published → accepted → requires_confirmation → confirmed → started → completed → arbitration | cancelled`
    - `requires_confirmation` має поле `depositDeadline` (12 год). Scheduler (`depositDeadlineTimeout.scheduler.ts`, у worker) кожні 5 хв перевіряє прострочені.
    - Якщо `accepted`/`requires_confirmation` з `depositDeadline < now` → `expiredOrders.worker` → `cancelled` (refund).
    - Якщо `requires_confirmation` з `depositDeadline < now` → `depositDeadlineTimeout.worker` → `published` (release performer, повернути в біржу).
    - `specs` — JSONB на order, validated через `services-tree.ts` `validateSpecs()` (див. `POST /api/v1/orders`).

11. **No soft-delete на бізнес-сутностях.** Тільки `Device.revokedAt` і `RefreshToken.revokedAt` (revoke, не delete). User/Order/Field — фізичне видалення через CASCADE.

12. **Pagination pattern:** `parsePagination(url)` повертає `{limit, offset}` (limit 1–100, default 20), `makePage(limit, offset, total)` повертає `{limit, offset, hasMore}`. Використовуй у всіх list endpoints.

13. **Error envelope:** ВСІ помилки через `fail(req, err)` з `ApiError`. Коди: `VALIDATION_ERROR`(400), `UNAUTHORIZED`(401), `FORBIDDEN`(403), `NOT_FOUND`(404), `CONFLICT`(409), `SERVICE_UNAVAILABLE`(503, retryable), `GATEWAY_TIMEOUT`(504, retryable), `BAD_GATEWAY`(502, non-retryable), `INTERNAL_ERROR`(500). Response має `x-error-retryable` header. Retryable помилки також додають `retry-after: 60`.

14. **Деплой.** Docker/CI **тимчасово видалені** (переписуються). Два окремі deployment на CapRover: `dragonfly` (цей бекенд) і `workerdragonfly` (воркер, окремий проєкт у `../worker`).

## Patterns

### Додавання нового API endpoint

```ts
// src/app/api/v1/<group>/<action>/route.ts
import { z } from "zod";
import { ok, fail, getRequestId } from "@/lib/apiResponse";
import { ApiError, prisma } from "@/shared";
import { requireUser } from "@/lib/auth/requireAuth";

const schema = z.object({ /* ... */ });

export async function POST(req: Request) {
  try {
    const user = await requireUser(req);             // throws 401 on missing/invalid Bearer
    if (user.role !== "customer")                    // role check
      throw new ApiError(403, "FORBIDDEN", "Customer role required");
    const body = schema.parse(await req.json());     // Zod → 400 on invalid
    const result = await prisma.$transaction([...]); // завжди через $transaction для multi-write
    return ok(req, { result }, { status: 201, message: "Created" });
  } catch (err) {
    if (err instanceof z.ZodError)
      return fail(req, new ApiError(400, "VALIDATION_ERROR", "...", err.flatten()));
    return fail(req, err);
  }
}
```

**Dynamic params:** Next.js 15 — `ctx: { params: Promise<{ id: string }> }`, **await** перед використанням.

**File uploads:** Додай `export const runtime = "nodejs";` (formData() не працює на edge). Використовуй `readFormFileAsDataUrl()` з `@/lib/uploads` (≤10MB, base64 inline, без S3).

### Додавання нового BullMQ job

> ⚠️ Черги визначені в цьому проєкті (`src/queues/`), але **workers запускаються в окремому проєкті `worker/`**. Додавання job = зміна в ОБИХ проєктах (спільний код дубльований).

1. Додай queue getter в `src/queues/queues.ts` (lazy singleton pattern).
2. Додай `enqueue<Name>` helper в `src/queues/jobs.ts` (з `jobId` для дедупу).
3. Додай `start<Name>Worker()` в `worker/src/workers/`, експортуй з `worker/src/workers/run.ts`.
4. Скопій змінений `src/queues/*` в `worker/src/queues/*` (дубль).
5. Не запускай worker у Next.js процесі — це окремий deployment target.

### Realtime з боку route handler

```ts
import { publishDomainEvent } from "@/shared";
await publishDomainEvent({
  type: "order.status_changed",
  requestId: getRequestId(req),
  targets: { userIds: [user.id, ...(performerId ? [performerId] : [])] },
  data: { orderId, fromStatus, toStatus },
});
```

Event types — в `src/realtime/domainEvents.ts` (16 типів, кожен з `version: "1.0"`). Якщо додаєш новий — додай union у `DomainEventType`.

### Validators (UA-specific)

`@/lib/validators`:
- `validateEdrpou("12345678")` — 8-10 цифр, повертає boolean
- `validateUAIban(iban)` — повний mod-97 checksum для `UA` IBAN
- `normalizeUAIban(iban)` — strip spaces, uppercase

## Testing

```bash
npm test   # = tsx --test tests/unit/*.test.ts
```

**Coverage:** `tests/unit/{validators,middleware,matching,errors,orderStatus,deposit,depositService}.test.ts`. Використовується вбудований `node:test` + `assert/strict` (без jest/vitest). Тести імпортують `../../src/shared` (barrel) і запускаються **безпосередньо з TypeScript** через `tsx` — тому не треба компіляції в `dist-tests`.

## Lint / typecheck

```bash
npm run lint                 # next lint
```

Окремої typecheck команди немає. Next.js typecheck відбувається всередині `npm run build`. Для швидкого tsc: `npx tsc --noEmit`.

## Database

PostgreSQL. Schema: `public` (без multi-schema). Через Prisma 7 + driver adapter.

```bash
npm run db:deploy     # prisma migrate deploy --config prisma.config.ts
npm run db:status
npm run db:reset      # --force — ВИДАЛЯЄ ДАНІ
```

`prisma.config.ts` лежить у корені проєкту; команди запускаються звідти, тому шляхи `prisma/schema.prisma` валідні. Обов'язково через `--config prisma.config.ts` (Prisma 7).

**17 моделей** (повний список — в `prisma/schema.prisma`). Основні:
- `User` (3 1:1 профілі: `CustomerProfile`, `PerformerProfile`, `LegalProfile`)
- `Order` + `OrderStatusEvent` (audit log) + `OrderMatch` (performer matching, unique на `[performerUserId, orderId]`)
- `ServiceCategory` → `ServiceSubcategory` → `ServiceType` (composite PK `[subcategoryId, id]`)
- `RefreshToken` (зберігає SHA-256, не оригінал), `Device` (Expo push tokens, `revokedAt` soft-revoke)
- `Notification` (in-app inbox, `readAt` mark-read)
- `Review` (performer ratings, `avgRating`/`reviewCount` denormalized на `PerformerProfile`)

**Стратегія ID:** всі CUID (`@default(cuid())`), жодних integers. Naming: `@@map("snake_case")` + `@map` на колонках.

**2 enum-и** (`UserRole`, `TaxSystem`). 7 інших enums (OrderStatus, EscrowStatus, тощо) були видалені в `20260329214130_30_march` — тепер це `String` колонки зі state machine на app-рівні. Якщо додаєш новий status — онови routes, workers, і docs.

**Push notification flow:**
1. `POST /api/v1/devices/push-tokens` реєструє Expo token
2. Workers (`matchNewOrder`, `expiredOrders`, `depositDeadlineTimeout`, route handlers) викликають `expoPush.sendBatch()`
3. Service автоматично ревокає невалідні токени (через `Expo.isExpoPushToken` + receipt handling)
4. Якщо `PUSH_SKIP_IF_ONLINE=true` — пуш не надсилається якщо user online в WebSocket presence

## Gotchas

- **Default `app/page.tsx` — Next.js boilerplate.** Не видаляй (Next.js вимагає root page). Реальний UI — на mobile.
- **Two `legal-profile` routes deprecated:** `customer/legal-profile` і `performer/legal-profile` — використовуй `/users/me/legal-profile` (unified).
- **`endpoints.md` НЕ синхронний з кодом.** Відсутні: `performer/active-work`, `performer/wallet/*`, `orders/[id]/report/*`, `orders/[id]/arbitration/media`, `devices/push-tokens/*`. Застарілі: `marketplace/orders/:orderId`, `billing/summary` — задокументовані, але не імплементовані.
- **Auth у WebSocket:** у dev можна `?token=<jwt>`, у prod — тільки `Authorization: Bearer`. Клієнти з mobile мають передавати header.
- **Health endpoint** має два режими: `GET /api/v1/health` (без auth, тільки DB+Redis ping) і `?detailed=1` (повний schema check, потребує `HEALTHCHECK_TOKEN` у production).
- **`next.config.ts` `allowedDevOrigins`** — без цього Next.js 15 блокує LAN запити (CORS-like). Завжди додавай свій IP.
- **Міграції 26 шт, дублікати імен:** `20260319*`, `20260329*`, `20260329214130_30_march` — фінальна "great simplification". НЕ перейменовуй старі, навіть якщо виглядають дивно (Prisma заблокує).
- **No `server-only` guard** в коді. Lib файли (`prisma.ts`, `auth/*`, `queues/*`) технічно можуть імпортуватись в edge runtime — обережно з новими залежностями.
- **Дубльований спільний код:** `src/lib/{prisma,errors,deposit,orderStatus,matching}.ts`, `src/queues/**`, `src/realtime/**`, `src/services/**`, `prisma/**` — **також існують в `../worker/src/**`**. Будь-яка зміна тут має бути скопійована в worker (і навпаки). Barrel: `src/shared.ts` (тут) ↔ `worker/src/shared.ts` (там, імпорт `../shared`).
- **Структурні файли (НЕ редагуй без розуміння наслідків):** `prisma.config.ts`, `tsconfig.json`, `middleware.ts`, `next.config.ts`, `server.js`, `services-tree.ts`, `src/shared.ts`.
