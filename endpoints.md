# Endpoints (актуально по коду)

Базовый префикс: `/api/v1`

## Формат ответов

Успех:
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {},
  "message": "OK",
  "timestamp": "2026-03-17T20:00:00.000Z",
  "requestId": "uuid"
}
```

Ошибка:
```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "error": { "type": "Error", "details": {} },
  "message": "Request validation failed",
  "timestamp": "2026-03-17T20:00:00.000Z",
  "requestId": "uuid"
}
```

## Realtime (WebSocket + Push fallback)

### WebSocket `GET /ws`
- Назначение: realtime-сигналы об изменениях заказов/биржи/статусов, чтобы клиент мог обновлять экраны без ручного refresh.
- Auth: `Authorization: Bearer <accessToken>` (JWT access token)
- URL:
  - dev: `ws://localhost:<PORT>/ws`
  - prod: `wss://<host>/ws`
- Важно:
  - WebSocket используется только как “сигнал” (at-least-once не гарантируется). Клиент после события делает refetch (refetch-on-focus остаётся обязательным).
  - Сервер не поддерживает подписку на произвольный `orderId`. Роутинг событий делается по `userId` (получатели определяются сервером).

#### Формат сообщений (server → client)
```json
{
  "eventId": "uuid",
  "type": "order.updated",
  "version": "1.0",
  "timestamp": "2026-03-19T10:30:00Z",
  "requestId": "uuid",
  "targets": { "userIds": ["usr_..."] },
  "data": { "orderId": "cmmx...", "status": "published" }
}
```

#### События (минимальный набор)
- `order.created` — создан заказ (customer)
- `order.updated` — изменены поля заказа (customer, performer если назначен)
- `order.deleted` — заказ удалён (customer, performer если назначен)
- `order.status_changed` — смена статуса (customer + performer)
- `marketplace.match_added` — заказ стал доступен исполнителю (performer)
- `marketplace.match_removed` — заказ больше не доступен исполнителю (performer)
- `agreement.assigned` — исполнитель назначен / заказ принят (customer + performer)
- `escrow.changed` — зарезервирован/изменён escrow (если будет эмититься)

#### Push fallback (когда приложение в фоне/закрыто)
- Для `marketplace.match_added` пуш отправляется только если пользователь offline (нет активного WS presence).
- Для критичных статусов (например `accepted`/депозиты) клиенту всё равно нужно полагаться на push + refetch при открытии экрана.

## Auth

### POST `/api/v1/auth/register`
- Auth: public
- Body:
```json
{ "name": "User", "email": "user@example.com", "password": "Test1234" }
```
- Returns: `201 { user }`

### POST `/api/v1/auth/login`
- Auth: public
- Body:
```json
{ "email": "user@example.com", "password": "Test1234" }
```
- Returns: `200 { accessToken, user }`
- Side effects:
  - выставляет httpOnly cookie `refreshToken` (path: `/api/v1/auth`)

### POST `/api/v1/auth/refresh`
- Auth: refresh cookie
- Returns: `200 { accessToken }`

### POST `/api/v1/auth/logout`
- Auth: refresh cookie
- Returns: `200 {}`

### GET `/api/v1/auth/me`
- Auth: Bearer
- Returns: `200 { user }`

## Users

### GET `/api/v1/users/me`
- Auth: Bearer
- Returns: `200 { user }`

### PATCH `/api/v1/users/me`
- Auth: Bearer
- Body: любые поля (минимум одно):
```json
{ "name": "New Name", "phone": "+380...", "email": "new@example.com" }
```
- Returns: `200 { user }`

### PATCH `/api/v1/users/me/role`
- Auth: Bearer
- Body:
```json
{ "role": "customer" }
```
или
```json
{ "role": "performer" }
```
- Returns: `200 { user: { id, role } }`
- Side effects:
  - создаёт customerProfile/performerProfile, если отсутствует

## Catalog

### GET `/api/v1/catalog/services`
- Auth: public
- Returns: `200 { categories[] }`

### GET `/api/v1/catalog/crops`
- Auth: public
- Returns: `200 { crops[] }`

## Notifications

### GET `/api/v1/notifications`
- Auth: Bearer
- Query:
  - `limit` (default 20, max 100)
  - `offset` (default 0)
  - `unreadOnly` (optional boolean)
- Returns: `200 { items[], page }`
- Notes:
  - `items[].data` может содержать `orderId` для deeplink/обновления экрана
  - `items[].orderId` — вынесен отдельно (если был в `data.orderId`)

### PATCH `/api/v1/notifications/:notificationId/read`
- Auth: Bearer
- Returns: `200 { notification: { id, readAt } }`

## Billing

### GET `/api/v1/billing/summary`
- Auth: Bearer
- Role: `customer`
- Returns: `200 { summary }`

### GET `/api/v1/performer/billing/summary`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { summary }`

## Fields

### GET `/api/v1/fields`
- Auth: Bearer
- Role: `customer`
- Query: `limit`, `offset`
- Returns: `200 { items[], page }`

### POST `/api/v1/fields`
- Auth: Bearer
- Role: `customer`
- Body:
```json
{
  "name": "Field #1",
  "areaHa": 120.5,
  "regionName": "Lviv",
  "geometry": null,
  "centroid": { "lat": 49.84, "lng": 24.03 }
}
```
- Returns: `201 { field }`

### GET `/api/v1/fields/:fieldId`
- Auth: Bearer
- Role: `customer` (owner)
- Returns: `200 { field }`

### PATCH `/api/v1/fields/:fieldId`
- Auth: Bearer
- Role: `customer` (owner)
- Body: любое поле из `POST /fields` (минимум одно)
- Returns: `200 { field }`

### DELETE `/api/v1/fields/:fieldId`
- Auth: Bearer
- Role: `customer` (owner)
- Returns: `204 {}`

## Orders (customer)

### GET `/api/v1/orders`
- Auth: Bearer
- Role: `customer`
- Query:
  - `status` (optional)
  - `group` = `all | active | closed` (optional)
  - `limit`, `offset`
- Returns: `200 { items[], page }`
- Notes:
  - Адрес в ответах всегда дублируется:
    - `location.addressLabel`/`location.regionName` (для UI)
    - fallback: `locationLabel`/`regionName` (legacy)

### POST `/api/v1/orders/quote`
- Auth: Bearer
- Role: `customer`
- Rate limit: 100/min per IP (or 500/min for authenticated user if global rule applies)
- Headers:
  - `Authorization: Bearer <accessToken>`
  - `Content-Type: application/json`
- Body:
```json
{
  "serviceCategoryId": "spraying",
  "serviceSubCategoryId": "pesticide",
  "serviceTypeId": "type-a",
  "areaHa": 120.5
}
```
- Fields:
  - `serviceCategoryId` (string, required) — ID категории услуги (trim, не пустая строка)
  - `serviceSubCategoryId` (string, required) — ID подкатегории услуги (trim, не пустая строка)
  - `serviceTypeId` (string | null, required) — ID типа услуги в рамках `serviceSubCategoryId` или `null` для подкатегорий без типов
  - `areaHa` (number, required) — площадь в гектарах (> 0, разумный верхний лимит, например ≤ 20000)
- Notes:
  - Если получаете `404 Service type not found`, проверьте доступные значения через `GET /api/v1/catalog/services`
  - Если подкатегория не имеет типов (в каталоге `types: []`), отправляйте `serviceTypeId: null`
  - Для тестов в dev засеяны типы (serviceCategoryId/serviceSubCategoryId/serviceTypeId):
    - `plowing/deep/standard`, `plowing/deep/reinforced`, `plowing/shallow/light`
    - `cultivation/pre_sowing/shallow`, `cultivation/pre_sowing/deep`
    - `cultivation/inter_row` (подкатегория без типов → отправляйте `serviceTypeId: null`)
    - `sowing/grains/wheat`, `sowing/grains/barley`, `sowing/grains/corn`, `sowing/technical/sunflower`, `sowing/technical/rapeseed`
    - `harvesting/combine/grains`, `harvesting/combine/corn`
- Returns: `200 { quote }`
- Response:
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "quote": {
      "amount": 48000,
      "currency": "UAH",
      "breakdown": [{ "label": "Base", "amount": 48000 }],
      "validUntil": "2026-03-19T10:30:00Z"
    }
  },
  "message": "Quote calculated",
  "timestamp": "2026-03-19T10:30:00Z",
  "requestId": "req_123abc"
}
```
- Errors:
  - `400 VALIDATION_ERROR` — некорректный формат, `areaHa <= 0`, отсутствуют поля, тип обязателен, но не передан и т.п.
  - `404 NOT_FOUND` — `serviceTypeId` указан, но не существует → `Service type not found`
  - `401 UNAUTHORIZED` — нет/невалидный токен
  - `503 INTERNAL_ERROR` — цена не настроена (`Pricing not configured`)
  - `500 INTERNAL_ERROR` — необработанная ошибка расчёта

### POST `/api/v1/orders`
- Auth: Bearer
- Role: `customer`
- Body:
```json
{
  "serviceCategoryId": "spraying",
  "serviceSubCategoryId": "pesticide",
  "serviceTypeId": "type-a",
  "areaHa": 120.5,
  "dateFrom": null,
  "dateTo": null,
  "location": { "lat": 49.8397, "lng": 24.0297, "addressLabel": "Test Location", "regionName": "Lviv" },
  "comment": "Text",
  "budget": 10000,
  "status": "draft"
}
```
- Dates:
  - `dateFrom`, `dateTo` должны быть `null` или ISO 8601 datetime строкой с таймзоной
  - Examples: `"2026-03-19T10:30:00Z"`, `"2026-03-19T12:30:00+02:00"`
- Returns: `201 { order }`
- Side effects:
  - при `status=published` enqueue `match-new-order` (асинхронный поиск подходящих исполнителей + push-уведомления)

### GET `/api/v1/orders/:orderId`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Returns: `200 { order }` (включая `timeline`)

### PATCH `/api/v1/orders/:orderId`
- Auth: Bearer
- Role: `customer` (owner)
- Allowed order status: `draft | published`
- Body: любые поля из `POST /orders` + optional `status: draft|published`
- Returns: `200 { order }`
- Side effects:
  - при `draft → published` enqueue `match-new-order`

### DELETE `/api/v1/orders/:orderId`
- Auth: Bearer
- Role: `customer` (owner)
- Allowed order status: `draft | published`
- Returns: `200 { deleted: true, orderId }`
- Side effects: удаляет `order_matches` по orderId

### PATCH `/api/v1/orders/:orderId/cancel`
- Auth: Bearer
- Role: `customer` (owner)
- Body:
```json
{ "reason": "optional" }
```
- Returns: `200 { order: { id, status } }`
- Side effects:
  - ставит `cancelled`
  - удаляет `order_matches`
  - освобождает `escrow_locks` (ставит `released`)

## Deposits / Payments

### POST `/api/v1/orders/:orderId/deposits/customer-intent`
- Auth: Bearer
- Role: `customer` (owner)
- Allowed order status: `accepted`
- Body:
```json
{ "method": "card" }
```
- Returns: `200 { paymentIntent, order }`
- Notes:
  - `paymentIntent.orderId` — это `order_id` для LiqPay (нужно использовать его в провайдере)
  - `server_url` в LiqPay data указывает на `/api/v1/payments/liqpay/webhook`
  - `result_url` по умолчанию `/<home>` (можно переопределить на стороне клиента, если нужен deeplink)

### POST `/api/v1/marketplace/orders/:orderId/deposits/performer-intent`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{ "method": "card" }
```
- Returns: `200 { paymentIntent }`
- Notes:
  - `paymentIntent.orderId` — это `order_id` для LiqPay
  - `server_url` в LiqPay data указывает на `/api/v1/payments/liqpay/webhook`
  - `result_url` по умолчанию `/<home>`

### POST `/api/v1/payments/:paymentIntentId/confirm`
- Auth: Bearer (владелец payment)
- Body:
```json
{
  "providerPayload": {
    "provider": "liqpay",
    "data": "base64(...)",
    "signature": "base64(...)"
  }
}
```
- Returns: `200 { payment, order? }`
- Side effects:
  - валидирует подпись LiqPay
  - обновляет Payment по `liqpay.status`
  - создаёт/обновляет `escrow_locks`
  - при наличии escrow у обеих сторон переводит заказ в `confirmed` и чистит `order_matches`

### POST `/api/v1/payments/liqpay/webhook`
- Auth: public (server-to-server)
- Content-Type: `application/x-www-form-urlencoded` (LiqPay стандарт) или JSON
- Body (form):
  - `data` (string, base64 JSON)
  - `signature` (string, base64)
- Returns: `200 { received: true }`
- Notes:
  - endpoint проверяет подпись и обновляет `payments`/`escrow_locks` аналогично confirm
  - `order_id` внутри LiqPay должен быть равен `providerIntentId` из `paymentIntent` ответа intent

## Сделка / статусы заказа (логика, которую должно поддерживать приложение)

Ниже описан целевой бизнес‑процесс “двойного залога” (10% + 10%) и то, как это должно выглядеть на уровне API/клиента.

### Статусы (целевая интерпретация)
- `published` — “Открыт” (виден в бирже, доступен для принятия).
- `requires_confirmation` — “Ожидает подтверждения заказчиком” (исполнитель забронировал заказ, идёт 12ч таймер).
- `confirmed` — “Сделка подтверждена / средства заблокированы” (после оплаты заказчиком; дальше можно стартовать работу).
- `started` — “В работе”.
- `completed` — “Завершён” (работа принята/закрыта).
- `arbitration` — “Арбитраж”.
- `cancelled` — “Отменён”.

Текущее состояние в коде:
- При бронировании сейчас используется статус `accepted` (а не `requires_confirmation`).
- Статусы `pending_deposit` и `requires_confirmation` в коде почти не используются и требуют внедрения по процессу ниже.

### Этап 1 — Инициация сделки (действие исполнителя)
Цель: забронировать заказ и заморозить 10% залога исполнителя.

**Как должно быть в API**
- Клиент сначала создаёт/подтверждает платёж залога исполнителя:
  - `POST /api/v1/marketplace/orders/:orderId/deposits/performer-intent` → LiqPay checkout data/signature.
  - Оплата подтверждается через:
    - webhook `POST /api/v1/payments/liqpay/webhook` (server_url), и/или
    - `POST /api/v1/payments/:paymentIntentId/confirm` (fallback, если нужно).
- После того как `payment.status = succeeded` и создан `escrow_lock` для роли `performer`,
  клиент вызывает:
  - `POST /api/v1/marketplace/orders/:orderId/accept { paymentIntentId }`

**Что должен сделать клиент**
- Обрабатывать гонку:
  - Если пришёл `409 Order already accepted` → показать “Заказ уже забронирован”.
- После успеха:
  - Удалить заказ из биржи (или refetch по WS событию `marketplace.match_removed`).
  - Перейти на экран “Ожидаем подтверждения заказчиком”, показать `depositDeadline` (12ч).

**Что нужно изменить/добавить на бэкенде, чтобы соответствовать бизнес‑процессу 1:1**
- Изменить `POST /marketplace/orders/:id/accept`:
  - Вместо статуса `accepted` выставлять `requires_confirmation`.
  - Обязательные поля: `acceptedAt`, `depositDeadline = now + 12h`.
  - Отправлять уведомление заказчику (push/email) “Исполнитель забронировал… подтвердите в течение 12 часов”.
- Добавить проверки “профиль исполнителя не заблокирован” (если будет флаг блокировки профиля).
- Если планируется “баланс” платформы (wallet/ledger), а не только внешний провайдер:
  - Ввести “доступный баланс” и “заморозку (hold)” 10% с баланса исполнителя.
  - Тогда `performer-intent` может стать внутренней операцией, а не платёж у провайдера.

### Этап 2 — Реакция заказчика (в течение 12 часов)

#### Вариант A — заказчик подтверждает (успех)
Цель: внести 100% стоимости заказа + 10% страхового депозита заказчика.

**Как должно быть в API**
- `POST /api/v1/orders/:orderId/deposits/customer-intent` должен создавать оплату на сумму:
  - `amount = 1.0 * budget + 0.1 * budget`
- Подтверждение оплаты (webhook/confirm) должно:
  - создать/обновить `escrow_lock` для роли `customer`
  - перевести заказ в статус “В работе”:
    - либо сразу `started`
    - либо в `confirmed`, а старт отдельной кнопкой исполнителя

**Что нужно изменить/добавить на бэкенде**
- Сейчас `customer-intent` создаёт оплату только на 10% — нужно увеличить до `110%`.
- Определиться и зафиксировать контракт статусов:
  - вариант 1: `requires_confirmation → started` сразу после оплаты заказчика
  - вариант 2: `requires_confirmation → confirmed` и отдельный `PATCH /orders/:id/status started` от исполнителя
- Уведомления:
  - исполнителю: “Заказчик подтвердил оплату. Можете начинать”.

#### Вариант B — заказчик бездействует (тайм‑аут)
Цель: по истечении 12 часов автоматически отменить бронирование и вернуть залог исполнителю.

**Что нужно добавить на бэкенде**
- Фоновый job/cron, который:
  - находит заказы со статусом `requires_confirmation` и `depositDeadline < now`
  - выполняет протокол отмены:
    - переводит заказ обратно в `published` (или в `cancelled` — по бизнес правилу)
    - снимает брони: удаляет/пересоздаёт `order_matches` (или enqueue `match-new-order`)
    - “разблокирует” escrow залога исполнителя (обновляет `escrow_locks` статус)
    - пишет `order_status_events` (“Неподтвержденное бронирование”)
    - отправляет уведомление исполнителю и заказчику
- Важно: сейчас такого фонового процесса нет.

### Этап 3 — Завершение/санкции/арбитраж
Сейчас в API есть:
- `PATCH /api/v1/orders/:orderId/status` (исполнитель) — `confirmed → started → completed`
- `POST /api/v1/orders/:orderId/arbitration` — открыть арбитраж (ставит `arbitration`)

**Что нужно добавить на бэкенде для полного соответствия**
- “Подтвердить выполнение” со стороны заказчика:
  - endpoint вида `POST /api/v1/orders/:orderId/complete/confirm` (customer)
  - переводит в `completed` и запускает распределение денег
- Распределение средств:
  - выплатить исполнителю 100% (минус комиссия, если нужна)
  - вернуть 10% залога исполнителю
  - вернуть 10% залога заказчику
- “Срыв сроков исполнителем”:
  - endpoint расторжения по вине исполнителя
  - удержание 10% залога исполнителя (в пользу заказчика или платформы)
- Арбитражное решение:
  - admin endpoints для решения кейса и распределения 120% по правилам
  - фиксация решения в истории/логах/уведомлениях

### Требования к клиенту (чтобы соответствовать процессу)
- Всегда реагировать на `409` при принятии заказа (гонка исполнителей).
- При `requires_confirmation` (или текущем `accepted`) показывать таймер `depositDeadline`.
- Блокировать редактирование заказа заказчиком после брони (бэкенд уже запрещает редактирование вне `draft|published`).
- Делать refetch по событиям WS:
  - `marketplace.match_removed`, `order.status_changed`, `agreement.assigned`, `escrow.changed` (когда начнём эмитить).

## Marketplace (performer)

### GET `/api/v1/marketplace/orders`
- Auth: Bearer
- Role: `performer`
- Notes:
  - Список формируется на основе таблицы `order_matches` (создаётся асинхронно воркерами `match-new-order` и `match-new-executor`)
  - Заказ не попадёт в список, если не выполнены критерии матчинга (география и специализация)
- Query:
  - `limit`, `offset`
  - `serviceCategoryId`, `serviceSubCategoryId` (optional)
  - `distanceKmMax` (optional)
  - `sort = distance | price | date` (optional)
- Returns: `200 { items[], page }`
- Item fields (актуально по коду):
  - `id` (orderId)
  - `orderId` (дубль id)
  - `title`, `locationLabel`, `regionName`
  - `serviceCategoryId`, `serviceSubCategoryId`, `serviceTypeId`
  - `areaHa`, `price`, `budget`, `currency`
  - `distanceKm`
  - `dateFrom`, `dateTo`
  - `location: { lat, lng, locationLabel, addressLabel, regionName }`
  - `status`, `createdAt`

### GET `/api/v1/marketplace/orders/:orderId`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { order }`
- Notes: доступно только если есть запись в `order_matches` для данного performer

### POST `/api/v1/marketplace/orders/:orderId/accept`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{ "paymentIntentId": "db_payment_id" }
```
- Preconditions:
  - order `published`
  - существует запись в `order_matches` для данного performer (заказ доступен этому исполнителю)
  - payment `succeeded`
  - escrow lock `performer` существует и `locked`
- Returns: `200 { order, agreementId }`
- Side effects:
  - ставит `accepted`
  - задаёт `depositDeadline = now + 12h`
  - чистит `order_matches`

## Performer settings

### GET `/api/v1/performer/settings`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { settings }`

### PUT `/api/v1/performer/settings`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{
  "baseLocationLabel": "Test Base",
  "baseCoordinate": { "lat": 49.8397, "lng": 24.0297 },
  "coverage": { "mode": "radius", "radiusKm": 50 },
  "services": [
    { "serviceCategoryId": "spraying", "serviceSubCategoryId": "pesticide", "serviceTypeId": "type-a" }
  ]
}
```
- Returns: `200 { ok: true }`
- Side effects: enqueue `match-new-executor`

## Work / Report / Arbitration

### GET `/api/v1/performer/active-work`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { activeWork | null }`

### PATCH `/api/v1/orders/:orderId/status`
- Auth: Bearer
- Role: `performer` (assigned)
- Body:
```json
{ "status": "started" }
```
или
```json
{ "status": "completed" }
```
- Allowed transitions:
  - `confirmed → started`
  - `started → completed`
- Returns: `200 { order: { id, status } }`

### GET `/api/v1/orders/:orderId/report`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Returns: `200 { report }`

### POST `/api/v1/orders/:orderId/report/media`
- Auth: Bearer
- Role: `performer` (assigned)
- Content-Type: `multipart/form-data`
- Form:
  - `file` (required)
  - `caption` (optional)
- Returns: `201 { media }`

### POST `/api/v1/orders/:orderId/report/submit`
- Auth: Bearer
- Role: `performer` (assigned)
- Returns: `200 { report }`

### POST `/api/v1/orders/:orderId/arbitration`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Body:
```json
{ "reason": "text", "evidenceMediaIds": [] }
```
- Returns: `200 { order, case }`

### POST `/api/v1/orders/:orderId/arbitration/media`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Content-Type: `multipart/form-data`
- Form: `file` (required)
- Returns: `201 { media }`

## Agreements

### GET `/api/v1/agreements`
- Auth: Bearer
- Query:
  - `status = active | completed` (optional)
  - `limit`, `offset`
- Returns: `200 { items[], page }`

### GET `/api/v1/agreements/:agreementId`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Returns: `200 { agreement }`

## Performer wallet / payouts

### GET `/api/v1/performer/wallet/reserve-transactions`
- Auth: Bearer
- Role: `performer`
- Query: `limit`, `offset`
- Returns: `200 { items[], page }`

### GET `/api/v1/performer/wallet/completed-works`
- Auth: Bearer
- Role: `performer`
- Query: `limit`, `offset`
- Returns: `200 { items[], page }`

### GET `/api/v1/performer/payouts`
- Auth: Bearer
- Role: `performer`
- Query: `limit`, `offset`, `status` (optional)
- Returns: `200 { items[], page }`

### POST `/api/v1/performer/payouts/withdraw-intent`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{ "amount": 100, "method": "card", "destination": "test-card" }
```
- Returns: `200 { withdrawIntent }`

### POST `/api/v1/performer/payouts/:withdrawIntentId/confirm`
- Auth: Bearer
- Role: `performer` (owner)
- Returns: `200 { payout }`

## Customer settings

### GET `/api/v1/customer/legal-profile`
- Auth: Bearer
- Role: `customer`
- Returns: `200 { legalProfile }`

### PATCH `/api/v1/customer/legal-profile`
- Auth: Bearer
- Role: `customer`
- Назначение: одним запросом сохранить всю “Юридична інформація” из Settings.
- Body (отправляем всегда весь набор полей; пустые значения отправлять как `null`, не пустой строкой):
```json
{
  "companyName": "ФОП Петренко І.В.",
  "edrpou": "12345678",
  "iban": "UA213223130000026007233566001",
  "legalAddress": "м. Полтава, вул. ...",
  "vatPayer": true
}
```
- Пример очистки данных:
```json
{
  "companyName": null,
  "edrpou": null,
  "iban": null,
  "legalAddress": null,
  "vatPayer": false
}
```
- Валидации:
  - `companyName`: string|null, trim, min 2 max 120 (если не null)
  - `edrpou`: string|null, trim, только цифры, длина 8–10 (если не null)
  - `iban`: string|null, trim+upper, UA IBAN (29 символов), checksum MOD-97 (если не null)
  - `legalAddress`: string|null, trim, min 5 max 255 (если не null)
  - `vatPayer`: boolean (обязательное поле)
- Returns: `200 { legalProfile }`

### GET `/api/v1/customer/crop-stats`
- Auth: Bearer
- Role: `customer`
- Query:
  - `season` (optional, default текущий год)
- Returns: `200 { season, items[] }`

## Performer settings

### GET `/api/v1/performer/rating`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { rating }`

### GET `/api/v1/performer/reviews`
- Auth: Bearer
- Role: `performer`
- Query: `limit`, `offset`
- Returns: `200 { items[], page }`

## Security

### GET `/api/v1/security/2fa`
- Auth: Bearer
- Role: any
- Returns: `200 { twoFactor }`

### POST `/api/v1/security/2fa/setup`
- Auth: Bearer
- Role: any
- Returns: `200 { setup }`

### POST `/api/v1/security/2fa/enable`
- Auth: Bearer
- Role: any
- Body:
```json
{ "setupId": "string", "code": "123456" }
```
- Returns: `200 { twoFactor }`

### POST `/api/v1/security/2fa/disable`
- Auth: Bearer
- Role: any
- Body:
```json
{ "code": "123456" }
```
- Returns: `200 { twoFactor }`

### GET `/api/v1/security/biometrics`
- Auth: Bearer
- Role: any
- Returns: `200 { biometrics }`

### PATCH `/api/v1/security/biometrics`
- Auth: Bearer
- Role: any
- Body:
```json
{ "enabled": true }
```
- Returns: `200 { biometrics }`

## Devices

### POST `/api/v1/devices/push-tokens`
- Auth: Bearer
- Body:
```json
{ "expoPushToken": "ExponentPushToken[...]", "platform": "android", "deviceId": "optional", "appVersion": "optional" }
```
- Returns: `201 { device }`

### DELETE `/api/v1/devices/push-tokens/:deviceId`
- Auth: Bearer
- Returns: `204 {}`

additional description