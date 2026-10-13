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
- **Auth:** `Authorization: Bearer <accessToken>` (JWT access token)
- **URL:**
  - dev: `ws://localhost:<PORT>/ws`
  - prod: `wss://<host>/ws`
- **Назначение:** realtime-сигналы об изменениях заказов/биржи/статусов, чтобы клиент мог обновлять экраны без ручного refresh.
- **Важно:**
  - WebSocket используется только как "сигнал" (at-least-once не гарантируется). Клиент после события делает refetch (refetch-on-focus остаётся обязательным).
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

#### События
- `order.created` — создан заказ (customer)
- `order.updated` — изменены поля заказа (customer, performer если назначен)
- `order.deleted` — заказ удалён (customer, performer если назначен)
- `order.status_changed` — смена статуса (customer + performer)
- `order.accepted` — заказ принят исполнителем (customer + performer)
- `order.confirmed` — оба депозита оплачены (customer + performer)
- `order:accepted` / `order:confirmed` — алиасы для фронта (customer + performer)
- `deposit.performer_paid` — исполнитель оплатил депозит (customer + performer)
- `deposit.customer_paid` — замовник оплатил депозит (customer + performer)
- `deposit.customer_required` — требуется депозит замовника (customer)
- `deposit.customer_part2_required` — при ≥30% прогресса открыт этап второй части гарантійної суми замовника (customer)
- `deposit.customer_part2_paid` — замовник оплатил вторую часть гарантійної суми (customer + performer)
- `deposit.timeout` — дедлайн депозита истёк, заказ вернулся в биржу (performer)
- `order.expired` — заказ отменён из-за неоплаты депозита исполнителем (performer)
- `payment:required` — алиас для фронта, требуется оплата замовника (customer)
- `escrow.changed` — изменение эскроу-блокировки (customer + performer)
- `order.en_route` — исполнитель выехал к полю (customer)
- `order.started` — заказ начат исполнителем (customer)
- `order.completed` — заказ завершён исполнителем (customer)
- `order.progress_updated` — новый отчёт о прогрессе работ (customer)
- `order.payment_paused` — работа на паузе: замовник не внес вторую часть гарантійної суми в дедлайн (customer + performer)
- `order.payment_resumed` — вторая часть внесена, пауза снята (customer + performer)
- `marketplace.match_added` — заказ стал доступен исполнителю (performer)
- `marketplace.match_removed` — заказ больше не доступен исполнителю (performer)
- `agreement.assigned` — исполнитель назначен / заказ принят (customer + performer)

#### Push fallback (когда приложение в фоне/закрыто)
- Для `marketplace.match_added` пуш отправляется только если пользователь offline (нет активного WS presence).
- Для критичных статусов (например `accepted`/депозиты) клиенту всё равно нужно полагаться на push + refetch при открытии экрана.
- Для `deposit.performer_paid` и `deposit.customer_required` пуш отправляется всегда + дублируется в БД уведомлений.

---

## Auth

### POST `/api/v1/auth/register`
- **Auth:** public
- **Body:**
```json
{
  "name": "string (min 1, trim)",
  "email": "string (email, trim, lowercase)",
  "password": "string (min 6)"
}
```
- **Returns:** `201 { user: { id, name, email, role, createdAt }, accessToken, refreshToken }`
- **Side effects:** создаёт user с role=`customer` и customerProfile; выставляет httpOnly cookie `refreshToken`

### POST `/api/v1/auth/login`
- **Auth:** public
- **Body:**
```json
{
  "email": "string (email, trim, lowercase)",
  "password": "string"
}
```
- **Returns:** `200 { accessToken, user: { id, name, email, role }, refreshToken }`
- **Side effects:** bumps `sessionVersion` (единая активная сессия), ревокает прочие refresh-токены, выставляет httpOnly cookie `refreshToken` (path: `/api/v1/auth`, maxAge: 7 дней)

### POST `/api/v1/auth/refresh`
- **Auth:** refresh cookie
- **Returns:** `200 { accessToken }`
- **Errors:** `401` если токен отсутствует, невалиден или отозван

### POST `/api/v1/auth/logout`
- **Auth:** refresh cookie
- **Returns:** `200 {}`
- **Side effects:** отзывает refreshToken в БД, очищает cookie

### POST `/api/v1/auth/forgot-password`
- **Auth:** public
- **Body:**
```json
{
  "email": "string (email, trim, lowercase)"
}
```
- **Returns:** `200 {}` (message: `Якщо email існує, код надіслано`) — всегда одинаковый ответ, без user enumeration
- **Behavior:** если user существует — инвалидирует прежние неиспользованные коды, генерирует 6-значный код (valid 15 min), сохраняет его SHA-256 и отправляет письмом
- **Rate limit:** строже глобального — 5 запросов / 15 мин на IP, 3 / 15 мин на email (при превышении молча пропускает отправку, всё равно `200`)

### POST `/api/v1/auth/reset-password`
- **Auth:** public
- **Body:**
```json
{
  "email": "string (email, trim, lowercase)",
  "code": "string (6 digits)",
  "newPassword": "string (min 8, ≥1 uppercase, ≥1 digit)"
}
```
- **Returns:** `200 {}` (message: `Пароль оновлено`)
- **Errors:** `400 VALIDATION_ERROR` при невалидном body; `400 INVALID_CODE` (единое сообщение `Невірний або прострочений код`) когда код отсутствует/просрочен/неверный либо attempts ≥ 5
- **Side effects:** обновляет passwordHash (bcrypt, cost 12), помечает код использованным, ревокает все refresh-токены, bump `sessionVersion` (инвалидирует действующие access-токены)

### GET `/api/v1/auth/me`
- **Auth:** Bearer
- **Returns:** `200 { user }`

---

## Users

### GET `/api/v1/users/me`
- **Auth:** Bearer
- **Returns:** `200 { user: { id, name, email, phone, role, createdAt } }`

### PATCH `/api/v1/users/me`
- **Auth:** Bearer
- **Body:** (минимум одно поле)
```json
{
  "name": "string (min 1, trim)",
  "phone": "string (5-32)",
  "email": "string (email, trim, lowercase)"
}
```
- **Returns:** `200 { user: { id, name, email, phone, role, createdAt } }`
- **Notes:** email должен быть уникальным

### PATCH `/api/v1/users/me/role`
- **Auth:** Bearer
- **Body:**
```json
{
  "role": "customer" | "performer"
}
```
- **Returns:** `200 { user: { id, role } }`
- **Side effects:** создаёт customerProfile/performerProfile, если отсутствует

---

## Catalog

### GET `/api/v1/catalog/services`
- **Auth:** public
- **Returns:** `200 { categories: [{ serviceCategoryId, serviceCategoryName, iconKey, subcategories: [{ serviceSubCategoryId, serviceSubCategoryName, iconKey, types: [{ serviceTypeId, serviceTypeName }] }] }] }`

### GET `/api/v1/catalog/crops`
- **Auth:** public
- **Returns:** `200 { crops: [{ id, name, iconKey }] }`

---

## Notifications

### GET `/api/v1/notifications`
- **Auth:** Bearer
- **Query:**
  - `limit` (default 20, max 100)
  - `offset` (default 0)
  - `unreadOnly` (optional, boolean)
  - `type` (optional) — `system | order | deposit | marketplace | arbitration | payout`
  - `role` (optional) — `customer | performer` (фильтр по data.role)
- **Returns:** `200 { items: [{ id, title, message, type, data, createdAt, readAt, orderId? }], page: { limit, offset, total } }`
- **Notes:**
  - `items[].data` может содержать `orderId` для deeplink
  - `items[].orderId` — вынесен отдельно (если был в `data.orderId`)
  - Фильтрация по ролям: если в `data.role` не совпадает с `role` query, сообщение не возвращается

### PATCH `/api/v1/notifications/:notificationId/read`
- **Auth:** Bearer
- **Returns:** `200 { notification: { id, readAt } }`
- **Side effects:** устанавливает `readAt = now` если не было прочитано

---

## Billing

### GET `/api/v1/billing/summary`
- **Auth:** Bearer
- **Role:** `customer`
- **Returns:** `200 { summary }`

### GET `/api/v1/performer/billing/summary`
- **Auth:** Bearer
- **Role:** `performer`
- **Returns:** `200 { summary: { completedTotal, reservedTotal, currency } }`

---

## Fields

### GET `/api/v1/fields`
- **Auth:** Bearer
- **Role:** `customer`
- **Query:** `limit`, `offset`
- **Returns:** `200 { items: [{ id, name, areaHa, addressLabel, centroid: { lat, lng }, points, createdAt }], page: { limit, offset, total } }`

### POST `/api/v1/fields`
- **Auth:** Bearer
- **Role:** `customer`
- **Body:**
```json
{
  "name": "string (min 1)",
  "areaHa": "number (> 0)",
  "addressLabel": "string (min 1, optional)",
  "lat": "number (-90 to 90, optional)",
  "lng": "number (-180 to 180, optional)",
  "points": "any (optional)"
}
```
- **Returns:** `201 { field }`

### GET `/api/v1/fields/:fieldId`
- **Auth:** Bearer
- **Role:** `customer` (owner)
- **Returns:** `200 { field }`

### PATCH `/api/v1/fields/:fieldId`
- **Auth:** Bearer
- **Role:** `customer` (owner)
- **Body:** любое поле из `POST /fields` (минимум одно)
- **Returns:** `200 { field }`

### DELETE `/api/v1/fields/:fieldId`
- **Auth:** Bearer
- **Role:** `customer` (owner)
- **Returns:** `204 {}`

---

## Orders (customer)

### GET `/api/v1/orders`
- **Auth:** Bearer
- **Role:** `customer`
- **Query:**
  - `status` (optional) — `draft | published | accepted | requires_confirmation | confirmed | started | completed | arbitration | cancelled`
  - `group` (optional) — `all | active | closed | expired`
  - `excludeExpired` (optional, boolean)
  - `limit`, `offset`
- **Returns:** `200 { items: [{ id, title, status, serviceCategoryId, serviceSubCategoryId, serviceTypeId, areaHa, locationLabel, addressLabel, regionName, location: { lat, lng, locationLabel, addressLabel, regionName }, dateFrom, dateTo, budget, acceptedAt, depositDeadline, depositAmount, escrowAmount, createdAt }], page: { limit, offset, total } }`
- **Notes:**
  - `group=active`: статусы `draft, published, accepted, requires_confirmation, confirmed, started, arbitration`
  - `group=closed`: статусы `completed, cancelled`
  - `group=expired`: `requires_confirmation` или `accepted` с `depositDeadline < now`

### POST `/api/v1/orders/quote`
- **Auth:** Bearer
- **Role:** `customer`
- **Body:**
```json
{
  "serviceCategoryId": "string (trim, min 1)",
  "serviceSubCategoryId": "string (trim, min 1)",
  "serviceTypeId": "string (trim, min 1) | null",
  "areaHa": "number (> 0)",
  "location": "{ lat, lng, regionName } (optional)",
  "dateFrom": "string (datetime, optional)",
  "dateTo": "string (datetime, optional)"
}
```
- **Returns:** `200 { quote: { amount, currency, breakdown: [{ label, amount }], validUntil } }`
- **Errors:**
  - `400` — `serviceTypeId` требуется для подкатегории с типами
  - `404` — категория/подкатегория/тип не найдены

### POST `/api/v1/orders`
- **Auth:** Bearer
- **Role:** `customer`
- **Body:**
```json
{
  "serviceCategoryId": "string (trim, min 1)",
  "serviceSubCategoryId": "string (trim, min 1)",
  "serviceTypeId": "string (trim, min 1) | null",
  "areaHa": "number (> 0)",
  "dateFrom": "string (datetime) | null (optional)",
  "dateTo": "string (datetime) | null (optional)",
  "location": "{ lat, lng, addressLabel, regionName (optional) }",
  "comment": "string (max 5000, optional)",
  "budget": "number (> 0)",
  "status": "draft | published (optional, default: published)"
}
```
- **Returns:** `201 { order: { id, status, createdAt } }`
- **Side effects:** при `status=published` enqueue `match-new-order`

### GET `/api/v1/orders/:orderId`
- **Auth:** Bearer
- **Role:** `customer` (owner) или `performer` (assigned)
- **Returns:** `200 { order: { id, status, serviceCategoryId, serviceSubCategoryId, serviceTypeId, areaHa, location: { lat, lng, locationLabel, addressLabel, regionName }, dateFrom, dateTo, budget, acceptedAt, depositDeadline, comment, timeline: [{ status, at, note }] } }`

### PATCH `/api/v1/orders/:orderId`
- **Auth:** Bearer
- **Role:** `customer` (owner)
- **Allowed order status:** `draft | published`
- **Body:** любое поле из `POST /orders` + optional `status: draft|published` (минимум одно поле)
- **Returns:** `200 { order: { id, status } }`
- **Side effects:**
  - при `draft → published` enqueue `match-new-order`
  - при `published → !published` удаляет `order_matches`, отправляет `marketplace.match_removed`

### DELETE `/api/v1/orders/:orderId`
- **Auth:** Bearer
- **Role:** `customer` (owner)
- **Allowed order status:** `draft | published | cancelled`
- **Returns:** `200 { deleted: true, orderId }`
- **Side effects:** удаляет `order_matches` (каскад чистит `payment_intents`/`escrow_locks`), отправляет `marketplace.match_removed`, `order.deleted`

### PATCH `/api/v1/orders/:orderId/cancel`
- **Auth:** Bearer
- **Role:** `customer` (owner)
- **Body:**
```json
{
  "reason": "string (max 2000, optional)"
}
```
- **Allowed cancel:** `draft, published` (всегда), `requires_confirmation, accepted` (если просрочено или нет performer)
- **Returns:** `200 { order: { id, status: "cancelled" } }`
- **Side effects:**
  - ставит `cancelled`
  - удаляет `order_matches`
  - отправляет Push исполнителю (если был назначен)
  - отправляет `order.status_changed`

### POST `/api/v1/orders/:orderId/confirm-completion`
- **Auth:** Bearer
- **Role:** `customer`
- **Body:**
```json
{
  "accepted": "boolean",
  "comment": "string (max 1000, optional)",
  "rating": "number (1-5, optional)"
}
```
- **Preconditions:** `order.status = completed`
- **Returns:** 
  - если `accepted=true`: `200 { order: { id, status: "completed" }, review: { rating, comment } | null }`
  - если `accepted=false`: `200 { order: { id, status: "arbitration" } }`
- **Side effects:**
  - при `accepted=true`: создаёт Review (если есть rating), обновляет рейтинг исполнителя, escrow-блокировки переводит в `released` (выплата разблокирована), отправляет Push исполнителю
  - при `accepted=false`: ставит `arbitration`, отправляет Push исполнителю

---

## Order Report / Arbitration

### GET `/api/v1/orders/:orderId/report`
- **Auth:** Bearer
- **Role:** `customer` (owner) или `performer` (assigned)
- **Returns:** `200 { report: { items: [{ id, data, createdAt }] } }`

### POST `/api/v1/orders/:orderId/report/media`
- **Auth:** Bearer
- **Role:** `performer` (assigned)
- **Allowed order status:** `confirmed | started | arbitration`
- **Content-Type:** `multipart/form-data`
- **Form:**
  - `file` (required)
  - `caption` (optional)
- **Returns:** `201 { media: { id, createdAt } }`

### POST `/api/v1/orders/:orderId/report/submit`
- **Auth:** Bearer
- **Role:** `performer` (assigned)
- **Returns:** `200 { report: { orderId, status: "submitted" } }`

### POST `/api/v1/orders/:orderId/arbitration`
- **Auth:** Bearer
- **Role:** `customer` (owner) или `performer` (assigned)
- **Body:**
```json
{
  "reason": "string (3-5000)",
  "evidenceMediaIds": "string[] (optional)"
}
```
- **Returns:** `200 { order: { id, status: "arbitration" }, case: { id, status, createdAt } }`
- **Side effects:** ставит `arbitration`, удаляет `order_matches`, создаёт `orderStatusEvent`, уведомляет вторую сторону (push + inbox) и шлёт `order.status_changed`

### POST `/api/v1/orders/:orderId/refuse`
- **Auth:** Bearer
- **Role:** `performer` (assigned)
- **Allowed order status:** `accepted | requires_confirmation | confirmed`
- **Body:**
```json
{
  "reason": "string (3-2000)"
}
```
- **Returns:** `200 { order: { id, status: "published" }, forfeited: boolean }`
- **Side effects:** возвращает заказ в `published` (снимает исполнителя, сбрасывает дедлайн), удаляет `order_matches`, ставит событие в `order_status_events`, перевыставляет в очередь `match-new-order`, escrow исполнителя — `released`, а если замовник уже оплатил (`confirmed`) — `forfeited` (штраф за вину), уведомляет замовника (push + inbox) и шлёт `order.status_changed`

### POST `/api/v1/orders/:orderId/arbitration/media`
- **Auth:** Bearer
- **Role:** `customer` (owner) или `performer` (assigned)
- **Preconditions:** `order.status = arbitration`
- **Content-Type:** `multipart/form-data`
- **Form:** `file` (required)
- **Returns:** `201 { media: { id, createdAt } }`

---

## Order Status (performer)

### PATCH `/api/v1/orders/:orderId/status`
- **Auth:** Bearer
- **Role:** `performer` (assigned)
- **Body:**
```json
{
  "status": "started" | "completed"
}
```
- **Allowed transitions:**
  - `confirmed → en_route`
  - `en_route → started`
  - `confirmed → started`
  - `started → completed`
- **Returns:** `200 { order: { id, status } }`
- **Side effects:**
  - при `en_route`: отправляет `order.en_route` WebSocket
  - при `started`: отправляет Push замовнику "Виконавець почав роботу"
  - при `completed`: ставит `completedAt`, отправляет Push замовнику "Виконавець завершив роботу", удаляет `order_matches`
  - создаёт `orderStatusEvent`
  - отправляет `order.status_changed` + `order.en_route` / `order.started` / `order.completed` WebSocket

### GET `/api/v1/orders/:orderId/progress`
- **Auth:** Bearer (замовник-владелец или назначенный исполнитель)
- **Returns:** `200 { progress: [{ id, percent, comment, createdAt, media: [{ id, url, mimeType, name, createdAt }] }] }`

### POST `/api/v1/orders/:orderId/progress`
- **Auth:** Bearer
- **Role:** `performer` (assigned)
- **Preconditions:** статус `started` И заказ не на паузе (`paymentPaused = false`)
- **Body:** multipart form — `percent` (optional, целое 0–100), `comment` (optional, ≤2000), `files` (≤5 фото; нужен `comment` или хотя бы одно фото)
- **Errors:** `409 CONFLICT` — статус не `started`, ИЛИ прогресс призупинено (замовник не внес вторую часть гарантійної суми после авто-паузы `order.payment_paused`)
- **Side effects:** создаёт `work_progress_update` (+ media), уведомляет замовника и шлёт `order.progress_updated`. При `percent >= 30` идемпотентно открывает этап второй части гарантійної суми замовника: атомарно ставит `customerPart2Deadline = now + PART2_DEADLINE_HOURS` и создаёт part-2 `paymentIntent` ровно один раз (повторные ≥30% отчёты — no-op; latch на `customerPart2Deadline IS NULL`), шлёт `deposit.customer_part2_required` + уведомления обеим сторонам
- **Returns:** `201 { progress: { id } }`

---

## Marketplace (performer)

### GET `/api/v1/marketplace/orders`
- **Auth:** Bearer
- **Role:** `performer`
- **Query:**
  - `limit`, `offset`
  - `serviceCategoryId` (optional)
  - `serviceSubCategoryId` (optional)
  - `distanceKmMax` (optional)
  - `sort` (optional) — `distance | price | date`
- **Returns:** `200 { items: [{ id, orderId, title, serviceCategoryId, serviceSubCategoryId, serviceTypeId, areaHa, durationDays, price, budget, currency, dateFrom, dateTo, locationLabel, addressLabel, regionName, location: { lat, lng, locationLabel, addressLabel, regionName }, status, createdAt }], page: { limit, offset, total } }`
- **Notes:** список формируется из `order_matches` (заказы доступные этому исполнителю)

### GET `/api/v1/marketplace/orders/:orderId`
- **Auth:** Bearer
- **Role:** `performer`
- **Preconditions:** существует запись в `order_matches` для данного performer ИЛИ `order.performerUserId` равен ему (детали после accept/оплаты)
- **Returns:** `200 { order: { id, status, serviceCategoryId, serviceSubCategoryId, serviceTypeId, areaHa, dateFrom, dateTo, budget, priceUah, currency, locationLabel, addressLabel, regionName, location: { lat, lng, addressLabel, regionName }, comment, acceptedAt, depositDeadline, depositAmount, depositUah, deposit: { performerDepositAmount, amount, currency }, performerUserId, createdAt } }`

---

## Deposits & Payments (escrow 30%, поэтапно)

Гарантійна сума = 30% от бюджета (`DEPOSIT_RATE = 0.3`), вносится каждой стороной. Исполнитель вносит полную сумму сразу (`part 1`); замовник — поэтапно 30/70: `part 1` (30% от его гарантійної суми) при подтверждении заказа, `part 2` (70%, остаток) — этап открывается при ≥30% прогресса работ (см. `POST /orders/:orderId/progress`).
Подтверждение оплаты идемпотентно: повторный `confirm` с тем же `paymentIntentId` возвращает текущий статус без повторного перехода.

### POST `/api/v1/marketplace/orders/:orderId/deposits/performer-intent`
- **Auth:** Bearer
- **Role:** `performer`
- **Body:** `{ method?: "card" | "apple-pay" | "google-pay" | "bank-transfer", wallet?: string, resultUrl?: string }`
- **Side effects (атомарно):** claim заказа условным `UPDATE ... WHERE status = 'published'` → `accepted` (`performerUserId`, `acceptedAt`, `depositDeadline = now + 12h`); повторный вызов тем же исполнителем возвращает существующий pending intent; чужой claim → `409 CONFLICT`
- **Events:** `agreement.assigned`, `order.status_changed` (`published → accepted`), `order.accepted`, `order:accepted` + Push замовнику
- **Returns:** `200 { paymentIntent: { id, orderId, role, amount, currency, status, data, signature, checkoutUrl, liqpay: { data, signature, checkoutUrl, checkout: { data, signature } } } }`

### POST `/api/v1/orders/:orderId/deposits/customer-intent`
- **Auth:** Bearer
- **Role:** `customer` (владелец заказа)
- **Preconditions:** статус `requires_confirmation | accepted`, назначен исполнитель, `depositDeadline` не прошёл
- **Body:** `{ method?, wallet?, resultUrl? }` (как выше)
- **Events:** `deposit.customer_required`
- **Returns:** `200 { paymentIntent: {...} }` (формат как выше)

### POST `/api/v1/payments/:paymentIntentId/confirm`
- **Auth:** Bearer (замовник для `role=customer`, назначенный исполнитель для `role=performer`)
- **Body:** `{ providerPayload: { provider: "liqpay", data: string, signature: string } }`
- **Side effects:** проверка LiqPay-подписи; guarded-переход (`accepted → requires_confirmation` для performer с ресетом дедлайна +12ч; `requires_confirmation → confirmed` для customer со снятием дедлайна); создание `escrow_locks` (upsert по `(orderId, role)`); `orderStatusEvent`. Для part-2 интента замовника (`part: 2`): статус НЕ меняется — эскроу замовника дополняется до полных 30% (сумма его оплаченных интентов), снимаются `customerPart2Deadline` и `paymentPaused` (resume); оплатить part-2 можно только пока заказ `started`, иначе `409 CONFLICT`
- **Events (performer):** `deposit.performer_paid`, `escrow.changed`, `order.status_changed`, `deposit.customer_required`, `payment:required` + Push замовнику
- **Events (customer, part 1):** `deposit.customer_paid`, `escrow.changed`, `order.status_changed`, `order.confirmed`, `order:confirmed` + Push исполнителю
- **Events (customer, part 2):** `deposit.customer_part2_paid`, `escrow.changed`, `order.payment_resumed` + уведомления обеим сторонам
- **Returns:** `200 { order: { id, status }, paymentIntent: { id, status } }`

### POST `/api/v1/payments/:paymentIntentId/liqpay/callback`
- **Auth:** none (подпись LiqPay)
- **Body:** form (`data`, `signature`) или JSON `{ data, signature }`
- **Side effects:** тот же идемпотентный путь, что и `confirm`
- **Returns:** `200 { order: { id, status }, paymentIntent: { id, status } }`

---

## Performer Settings

### GET `/api/v1/performer/settings`
- **Auth:** Bearer
- **Role:** `performer`
- **Returns:** `200 { settings: { baseLocationLabel, baseCoordinate: { lat, lng }, coverage: { mode, radiusKm }, services: [{ serviceCategoryId, serviceSubCategoryId, serviceTypeId }] } | null }`

### PUT `/api/v1/performer/settings`
- **Auth:** Bearer
- **Role:** `performer`
- **Body:** (минимум одно поле)
```json
{
  "baseLocationLabel": "string (min 1) | null",
  "baseCoordinate": "{ lat, lng } (optional)",
  "coverage": "{ mode: 'radius'|'country', radiusKm: number (0-500) | null } (optional)",
  "services": "[{ serviceCategoryId, serviceSubCategoryId, serviceTypeId }] (min 1, optional)"
}
```
- **Returns:** `200 { ok: true }`
- **Side effects:** enqueue `match-new-executor` при изменении services/coverage/baseCoordinate

---

## Performer Active Work

### GET `/api/v1/performer/active-work`
- **Auth:** Bearer
- **Role:** `performer`
- **Returns:** `200 { items: [{ orderId, id, status, title, areaHa, locationLabel, budget, currency, acceptedAt, depositDeadline, customer: { id, name, phone }, createdAt, updatedAt }], active_work: [...], totalCount }`
- **Notes:** возвращает заказы со статусами `confirmed, started, completed, arbitration` + `requires_confirmation/accepted` с `depositDeadline >= now`

---

## Unified Legal Profile (Customer/Performer)

Єдиний ендпоінт для управління юридичними даними користувача, незалежно від ролі.
Дані зберігаються в єдиній таблиці `LegalProfile` і доступні в обох ролях.

### GET `/api/v1/users/me/legal-profile`
- **Auth:** Bearer
- **Role:** `customer` | `performer`
- **Returns:** `200 { legalProfile: { companyName, edrpou, iban, vatPayer, legalAddress, updatedAt } }`

### PATCH `/api/v1/users/me/legal-profile`
- **Auth:** Bearer
- **Role:** `customer` | `performer`
- **Body:** (будь-яке поле, часткове оновлення)
```json
{
  "companyName": "string (2-120) | null",
  "edrpou": "string (8-10 digits) | null",
  "iban": "string (UA IBAN 29 chars, MOD-97) | null",
  "legalAddress": "string (5-255) | null",
  "vatPayer": "boolean"
}
```
- **Returns:** `200 { legalProfile: { companyName, edrpou, iban, vatPayer, legalAddress, updatedAt } }`
- **Note:** Дані оновлюються в єдиній таблиці `LegalProfile` і одразу доступні в обох ролях.

---

## Performer Legal Profile

**Deprecated:** Використовуйте `/api/v1/users/me/legal-profile`

### GET `/api/v1/performer/legal-profile`
- **Auth:** Bearer
- **Role:** `performer`
- **Returns:** `200 { legalProfile: { companyName, edrpou, iban, vatPayer, legalAddress, updatedAt } }`

### PATCH `/api/v1/performer/legal-profile`
- **Auth:** Bearer
- **Role:** `performer`
- **Body:**
```json
{
  "companyName": "string (2-120) | null",
  "edrpou": "string (8-10 digits) | null",
  "iban": "string (UA IBAN 29 chars, MOD-97) | null",
  "legalAddress": "string (5-255) | null",
  "vatPayer": "boolean"
}
```
- **Returns:** `200 { legalProfile: { companyName, edrpou, iban, vatPayer, legalAddress, updatedAt } }`

---

## Performer Rating / Reviews

### GET `/api/v1/performer/rating`
- **Auth:** Bearer
- **Role:** `performer`
- **Returns:** `200 { rating: { avg, count, breakdown: { "1": n, "2": n, "3": n, "4": n, "5": n } } }`

### GET `/api/v1/performer/reviews`
- **Auth:** Bearer
- **Role:** `performer`
- **Query:** `limit`, `offset`
- **Returns:** `200 { items: [{ id, orderId, author: { id, name }, rating, text, createdAt }], page: { limit, offset, total } }`

---

## Performer Wallet

### GET `/api/v1/performer/wallet/reserve-transactions`
- **Auth:** Bearer
- **Role:** `performer`
- **Query:** `limit`, `offset`
- **Returns:** `200 { items: [Notification[]], page: { limit, offset, total } }`

### GET `/api/v1/performer/wallet/completed-works`
- **Auth:** Bearer
- **Role:** `performer`
- **Query:** `limit`, `offset`
- **Returns:** `200 { items: [{ orderId, title, amount, currency, locationLabel, completedAt }], page: { limit, offset, total } }`

---

## Customer Legal Profile

**Deprecated:** Використовуйте `/api/v1/users/me/legal-profile`

### GET `/api/v1/customer/legal-profile`
- **Auth:** Bearer
- **Role:** `customer`
- **Returns:** `200 { legalProfile: { companyName, edrpou, iban, vatPayer, legalAddress, updatedAt } }`

### PATCH `/api/v1/customer/legal-profile`
- **Auth:** Bearer
- **Role:** `customer`
- **Body:**
```json
{
  "companyName": "string (2-120) | null",
  "edrpou": "string (8-10 digits) | null",
  "iban": "string (UA IBAN 29 chars, MOD-97) | null",
  "legalAddress": "string (5-255) | null",
  "vatPayer": "boolean"
}
```
- **Returns:** `200 { legalProfile: { companyName, edrpou, iban, vatPayer, legalAddress, updatedAt } }`

---

## Customer Crop Stats

### GET `/api/v1/customer/crop-stats`
- **Auth:** Bearer
- **Role:** `customer`
- **Query:** `season` (optional, default текущий год)
- **Returns:** `200 { season, items: [{ cropId, cropName, areaHa, yieldT }] }`

---

## Customer Stats

### GET `/api/v1/customers/:customerId/stats`
- **Auth:** Bearer
- **Role:** `customer` (только свой customerId)
- **Returns:** `200 { stats: { completedSum, inProgressSum, activeCount, completedCount } }`
- **Notes:**
  - `completedSum`: сумма `completed` заказов
  - `inProgressSum`: сумма `confirmed, started, arbitration` заказов
  - `activeCount`: количество активных заказов (включая `draft, published, requires_confirmation, accepted` если не просрочены)
  - `completedCount`: количество `completed` заказов
  - Исключает `cancelled` и просроченные (`requires_confirmation/accepted` с `depositDeadline < now`)

---

## Security 2FA

### GET `/api/v1/security/2fa`
- **Auth:** Bearer
- **Returns:** `200 { twoFactor: { enabled, method, enabledAt } }`

### POST `/api/v1/security/2fa/setup`
- **Auth:** Bearer
- **Returns:** `200 { setup: { otpauthUrl, secret, qrCodeSvg } }`

### POST `/api/v1/security/2fa/enable`
- **Auth:** Bearer
- **Body:**
```json
{
  "secret": "string",
  "code": "string (6-8 digits)"
}
```
- **Returns:** `200 { twoFactor: { enabled: true, method: "totp", enabledAt } }`

### POST `/api/v1/security/2fa/disable`
- **Auth:** Bearer
- **Body:**
```json
{
  "code": "string (6-8 digits)"
}
```
- **Returns:** `200 { twoFactor: { enabled: false } }`

---

## Security Biometrics

### GET `/api/v1/security/biometrics`
- **Auth:** Bearer
- **Returns:** `200 { biometrics: { enabled } }`

### PATCH `/api/v1/security/biometrics`
- **Auth:** Bearer
- **Body:**
```json
{
  "enabled": "boolean"
}
```
- **Returns:** `200 { biometrics: { enabled } }`

---

## Devices / Push Tokens

### POST `/api/v1/devices/push-tokens`
- **Auth:** Bearer
- **Body:**
```json
{
  "expoPushToken": "string (min 10)",
  "platform": "ios" | "android",
  "deviceId": "string (optional)",
  "appVersion": "string (optional)"
}
```
- **Returns:** `201 { device: { id, expoPushToken, platform, createdAt } }`
- **Side effects:** upsert (обновляет существующий токен или создаёт новый)

### DELETE `/api/v1/devices/push-tokens/:deviceId`
- **Auth:** Bearer
- **Returns:** `204 {}`
- **Side effects:** устанавливает `revokedAt = now`

---

## Health Check

### GET `/api/v1/health`
- **Auth:** public
- **Query:** `detailed` (optional, `1|true|yes`)
- **Headers:** `x-health-token` (required для `detailed=1` в production)
- **Returns:** `200 { status, uptimeSec, checks: { db, redis, migrations?, schema? } }`
- **Notes:**
  - `detailed=1` возвращает информацию о миграциях и схеме БД
  - в production требуется `x-health-token` header

---

## Статусы заказов (полный список)

- `draft` — черновик
- `published` — опубликован, виден в бирже
- `accepted` — принят исполнителем (ставится атомарным claim в performer-intent)
- `requires_confirmation` — ожидает депозита замовника (12ч таймер; просрочка → возврат в `published`)
- `confirmed` — сделка подтверждена, оба депозита оплачены
- `started` — в работе (статус устанавливается исполнителем через `/status`); может быть на паузе (`paymentPaused`) из-за неоплаты второй части гарантійної суми — на паузе отчёты о прогрессе отклоняются `409`, поздняя оплата part-2 снимает паузу (`order.payment_resumed`)
- `completed` — завершён исполнителем (ожидает подтверждения замовником)
- `arbitration` — арбитраж
- `cancelled` — отменён

---

## Примечания

### Валидации IBAN
- Украинский IBAN: 29 символов, формат `UAkk bbbb bbcc cccc cccc cccc c`
- Проверка контрольной суммы: MOD-97

### Валидации EDRPOU
- 8-10 цифр

### Ролевая модель
- `customer` — замовник услуг
- `performer` — исполнитель услуг

### Rate limiting
- `POST /orders/quote`: 100/min per IP (или 500/min для аутентифицированного пользователя)
