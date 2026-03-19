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

### POST `/api/v1/orders/quote`
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
  - `serviceTypeId` должен существовать в БД (иначе `404 Service type not found`)

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
- Returns: `201 { order }`
- Side effects:
  - при `status=published` enqueue `match-new-order`

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
- Returns: `204 {}`
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

### POST `/api/v1/marketplace/orders/:orderId/deposits/performer-intent`
- Auth: Bearer
- Role: `performer`
- Body:
```json
{ "method": "card" }
```
- Returns: `200 { paymentIntent }`

### POST `/api/v1/payments/:paymentIntentId/confirm`
- Auth: Bearer (владелец payment)
- Body:
```json
{ "providerPayload": {} }
```
- Returns: `200 { payment, order? }`
- Side effects:
  - синхронизирует статус PaymentIntent со Stripe
  - создаёт/обновляет `escrow_locks`
  - при наличии escrow у обеих сторон переводит заказ в `confirmed` и чистит `order_matches`

## Marketplace (performer)

### GET `/api/v1/marketplace/orders`
- Auth: Bearer
- Role: `performer`
- Query:
  - `limit`, `offset`
  - `serviceCategoryId`, `serviceSubCategoryId` (optional)
  - `distanceKmMax` (optional)
  - `sort = distance | price | date` (optional)
- Returns: `200 { items[], page }`

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
