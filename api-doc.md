# API v1 (Mobile)

Base URL (dev): `http://localhost:3000/api/v1`

## Auth

### Authorization header
- Все защищённые эндпоинты требуют заголовок: `Authorization: Bearer <accessToken>`
- `accessToken` выдаётся в `POST /auth/login` и обновляется через `POST /auth/refresh` (refresh хранится в httpOnly cookie).

### Response envelope
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

### POST `/auth/register`
- Body:
```json
{ "name": "User", "email": "user@example.com", "password": "Test1234" }
```
- Returns: `201 { user }`
- Notes:
  - создаёт user с ролью `customer` + customerProfile

### POST `/auth/login`
- Body:
```json
{ "email": "user@example.com", "password": "Test1234" }
```
- Returns: `200 { accessToken, user }`
- Sets cookie: `refreshToken` (httpOnly, path `/api/v1/auth`)

### POST `/auth/refresh`
- Auth: refresh cookie `refreshToken`
- Returns: `200 { accessToken }`

### POST `/auth/logout`
- Auth: refresh cookie `refreshToken`
- Returns: `200 {}`
- Side effects: refresh token в БД помечается revoked, cookie очищается

### GET `/auth/me`
- Auth: Bearer
- Returns: `200 { user }`

## Users

### GET `/users/me`
- Auth: Bearer
- Returns: `200 { user }`

### PATCH `/users/me`
- Auth: Bearer
- Body (любое поле из списка, минимум одно):
```json
{ "name": "New Name", "phone": "+380...", "email": "new@example.com" }
```
- Returns: `200 { user }`
- Notes: email уникален (409 если занят)

### PATCH `/users/me/role`
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
  - создаёт профайл customer/performer если отсутствует

## Catalog

### GET `/catalog/services`
- Auth: public
- Returns: `200 { categories[] }`
- Типовой ответ:
```json
{
  "categories": [
    {
      "serviceCategoryId": "spraying",
      "serviceCategoryName": "Опрыскивание",
      "subcategories": [
        {
          "serviceSubCategoryId": "pesticide",
          "serviceSubCategoryName": "Опрыскивание (СЗР)",
          "types": [
            { "serviceTypeId": "type-a", "serviceTypeName": "..." }
          ]
        }
      ]
    }
  ]
}
```

### GET `/catalog/crops`
- Auth: public
- Returns: `200 { crops[] }`

## Notifications

### GET `/notifications`
- Auth: Bearer
- Query:
  - `limit` (1..100, default 20)
  - `offset` (default 0)
  - `unreadOnly` (boolean)
- Returns: `200 { items[], page }`

### PATCH `/notifications/:notificationId/read`
- Auth: Bearer
- Returns: `200 { notification: { id, readAt } }`

## Billing

### GET `/billing/summary`
- Auth: Bearer
- Role: `customer`
- Returns: `200 { summary }`

### GET `/performer/billing/summary`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { summary }`

## Fields (customer)

### GET `/fields`
- Auth: Bearer
- Role: `customer`
- Query: `limit`, `offset`
- Returns: `200 { items[], page }`

### POST `/fields`
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

### GET `/fields/:fieldId`
- Auth: Bearer
- Role: `customer`
- Returns: `200 { field }`

### PATCH `/fields/:fieldId`
- Auth: Bearer
- Role: `customer`
- Body: любое из полей `POST /fields` (минимум одно)
- Returns: `200 { field }`

### DELETE `/fields/:fieldId`
- Auth: Bearer
- Role: `customer`
- Returns: `204 {}`

## Orders (customer)

### GET `/orders`
- Auth: Bearer
- Role: `customer`
- Query:
  - `status` (один из OrderStatus)
  - `group` = `all | active | closed`
  - `limit`, `offset`
- Returns: `200 { items[], page }`

### POST `/orders/quote`
- Auth: Bearer
- Role: `customer`
- Body:
```json
{
  "serviceCategoryId": "spraying",
  "serviceSubCategoryId": "pesticide",
  "serviceTypeId": "type-a",
  "areaHa": 120.5
}
```
- Returns: `200 { quote }`
- Notes:
  - требует существующий `serviceTypeId` в БД (иначе 404)

### POST `/orders`
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
  "status": "published"
}
```
- Returns: `201 { order: { id, status, createdAt } }`
- Side effects:
  - если статус `published` → enqueue job `match-new-order`

### GET `/orders/:orderId`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Returns: `200 { order }` + `timeline[]`

### PATCH `/orders/:orderId`
- Auth: Bearer
- Role: `customer` (owner)
- Allowed status: только `draft` или `published`
- Body: любые поля из `POST /orders` + optional `status: draft|published`
- Side effects:
  - при `draft → published` enqueue `match-new-order`

### DELETE `/orders/:orderId`
- Auth: Bearer
- Role: `customer` (owner)
- Allowed status: только `draft` или `published`
- Returns: `204 {}`
- Side effects: удаляет `order_matches` для этого заказа

### PATCH `/orders/:orderId/cancel`
- Auth: Bearer
- Role: `customer` (owner)
- Body:
```json
{ "reason": "optional" }
```
- Returns: `200 { order: { id, status } }`
- Side effects:
  - `status = cancelled`
  - удаляет `order_matches`
  - освобождает escrow locks со статусом `locked` (ставит `released`)

## Marketplace (performer)

### GET `/marketplace/orders`
- Auth: Bearer
- Role: `performer`
- Query:
  - `limit`, `offset`
  - `serviceCategoryId` (optional)
  - `serviceSubCategoryId` (optional)
  - `distanceKmMax` (optional)
  - `sort` = `distance | price | date`
- Returns: `200 { items[], page }`
- Notes: это лента из `order_matches`, формируется воркерами

### GET `/marketplace/orders/:orderId`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { order }`
- Notes:
  - доступно только если у исполнителя есть match на этот заказ

## Performer settings

### GET `/performer/settings`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { settings }`

### PUT `/performer/settings`
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
- Side effects:
  - upsert performer_profile + performer_settings
  - replace performer_services
  - enqueue `match-new-executor`

## Deposits / Payments (Stripe)

> Требует `STRIPE_SECRET_KEY` в окружении API-сервера. Логика оплаты реальная (Stripe test mode).

### POST `/marketplace/orders/:orderId/deposits/performer-intent`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{ "method": "card" }
```
- Returns: `200 { paymentIntent: { id, clientSecret, ... } }`
- Notes:
  - создаёт PaymentIntent в Stripe
  - создаёт запись `payments` в БД со статусом `requires_action`

### POST `/orders/:orderId/deposits/customer-intent`
- Auth: Bearer
- Role: `customer` (owner)
- Allowed order status: `accepted`
- Body:
```json
{ "method": "card" }
```
- Returns: `200 { paymentIntent, order }`

### POST `/payments/:paymentIntentId/confirm`
- Auth: Bearer (владелец payment)
- Body:
```json
{ "providerPayload": {} }
```
- Returns: `200 { payment, order? }`
- Side effects:
  - получает status из Stripe
  - обновляет `payments.status`
  - upsert `escrow_locks` по роли плательщика (`customer` или `performer`)
  - если у order уже `accepted` и есть оба escrow lock → переводит order в `confirmed` и чистит `order_matches`

### POST `/marketplace/orders/:orderId/accept`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{ "paymentIntentId": "<db_payment_id>" }
```
- Preconditions:
  - order `published`
  - payment `succeeded` (после `/payments/:id/confirm`)
  - escrow lock `performer` существует и `locked`
- Returns: `200 { order: { id, status }, agreementId }`
- Side effects:
  - перевод order в `accepted`
  - выставляет `depositDeadline = now + 12h`
  - чистит `order_matches`

## Order status (performer)

### PATCH `/orders/:orderId/status`
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
- Side effects:
  - при `completed` создаёт/обновляет `agreement` и чистит `order_matches`

## Reports (performer)

### GET `/orders/:orderId/report`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Returns: `200 { report: { items[] } }`

### POST `/orders/:orderId/report/media`
- Auth: Bearer
- Role: `performer` (assigned)
- Content-Type: `multipart/form-data`
- Form fields:
  - `file` (required)
  - `caption` (optional)
- Returns: `201 { media }`
- Notes:
  - сейчас `url` хранится как `data:` URL (base64) для простого тестирования

### POST `/orders/:orderId/report/submit`
- Auth: Bearer
- Role: `performer` (assigned)
- Returns: `200 { report }`

## Arbitration

### POST `/orders/:orderId/arbitration`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Body:
```json
{ "reason": "text", "evidenceMediaIds": [] }
```
- Returns: `200 { order, case }`
- Side effects:
  - переводит order в `arbitration`
  - чистит `order_matches`
  - создаёт `arbitration_cases` (если ещё нет)

### POST `/orders/:orderId/arbitration/media`
- Auth: Bearer
- Role: `customer` (owner) или `performer` (assigned)
- Content-Type: `multipart/form-data`
- Form fields:
  - `file` (required)
- Returns: `201 { media }`

## Performer (work / wallet / payouts)

### GET `/performer/active-work`
- Auth: Bearer
- Role: `performer`
- Returns: `200 { activeWork }`

### GET `/performer/wallet/reserve-transactions`
- Auth: Bearer
- Role: `performer`
- Query: `limit`, `offset`
- Returns: `200 { items[], page }`

### GET `/performer/wallet/completed-works`
- Auth: Bearer
- Role: `performer`
- Query: `limit`, `offset`
- Returns: `200 { items[], page }`

### GET `/performer/payouts`
- Auth: Bearer
- Role: `performer`
- Query: `limit`, `offset`, `status`
- Returns: `200 { items[], page }`

### POST `/performer/payouts/withdraw-intent`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{ "amount": 100, "method": "card", "destination": "test-card" }
```
- Returns: `200 { withdrawIntent }`

### POST `/performer/payouts/:withdrawIntentId/confirm`
- Auth: Bearer
- Role: `performer` (owner)
- Returns: `200 { payout }`

## Devices / Push tokens

### POST `/devices/push-tokens`
- Auth: Bearer
- Body:
```json
{ "expoPushToken": "ExponentPushToken[...]", "platform": "android", "deviceId": "optional", "appVersion": "optional" }
```
- Returns: `201 { device }`

### DELETE `/devices/push-tokens/:deviceId`
- Auth: Bearer
- Returns: `204 {}`

