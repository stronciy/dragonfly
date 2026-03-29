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
- `order.started` — заказ начат исполнителем (customer)
- `order.completed` — заказ завершён исполнителем (customer)
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
- **Returns:** `201 { user: { id, name, email, role, createdAt } }`
- **Side effects:** создаёт user с role=`customer` и customerProfile

### POST `/api/v1/auth/login`
- **Auth:** public
- **Body:**
```json
{
  "email": "string (email, trim, lowercase)",
  "password": "string"
}
```
- **Returns:** `200 { accessToken, user: { id, name, email, role } }`
- **Side effects:** выставляет httpOnly cookie `refreshToken` (path: `/api/v1/auth`, maxAge: 7 дней)

### POST `/api/v1/auth/refresh`
- **Auth:** refresh cookie
- **Returns:** `200 { accessToken }`
- **Errors:** `401` если токен отсутствует, невалиден или отозван

### POST `/api/v1/auth/logout`
- **Auth:** refresh cookie
- **Returns:** `200 {}`
- **Side effects:** отзывает refreshToken в БД, очищает cookie

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
  - `status` (optional) — `draft | published | accepted | pending_deposit | requires_confirmation | confirmed | started | completed | arbitration | cancelled`
  - `group` (optional) — `all | active | closed | expired`
  - `excludeExpired` (optional, boolean)
  - `limit`, `offset`
- **Returns:** `200 { items: [{ id, title, status, areaHa, locationLabel, addressLabel, regionName, location: { lat, lng, locationLabel, addressLabel, regionName }, dateFrom, dateTo, budget, acceptedAt, depositDeadline, depositAmount, escrowAmount, createdAt }], page: { limit, offset, total } }`
- **Notes:**
  - `group=active`: статусы `draft, published, accepted, requires_confirmation, pending_deposit, confirmed, started, arbitration`
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
- **Allowed order status:** `draft | published`
- **Returns:** `200 { deleted: true, orderId }`
- **Side effects:** удаляет `order_matches`, отправляет `marketplace.match_removed`, `order.deleted`

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
  - при `accepted=true`: создаёт Review (если есть rating), обновляет рейтинг исполнителя, отправляет Push исполнителю
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
- **Side effects:** ставит `arbitration`, удаляет `order_matches`, создаёт `orderStatusEvent`

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
  "status": "active" | "completed"
}
```
- **Allowed transitions:**
  - `accepted → active`
  - `active → completed`
- **Returns:** `200 { order: { id, status } }`
- **Side effects:**
  - при `active`: отправляет Push заказчику "Виконавець почав роботу"
  - при `completed`: отправляет Push заказчику "Виконавець завершив роботу", удаляет `order_matches`
  - создаёт `orderStatusEvent`
  - отправляет `order.status_changed` WebSocket

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
- **Preconditions:** существует запись в `order_matches` для данного performer
- **Returns:** `200 { order }`

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
- `accepted` — принят исполнителем (legacy, для обратной совместимости)
- `pending_deposit` — ожидается депозит (зарезервирован)
- `requires_confirmation` — ожидает подтверждения заказчиком (12ч таймер)
- `confirmed` — сделка подтверждена, оба депозита оплачены
- `started` — в работе (статус устанавливается исполнителем через `/status`)
- `completed` — завершён исполнителем (ожидает подтверждения заказчиком)
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
- `customer` — заказчик услуг
- `performer` — исполнитель услуг

### Rate limiting
- `POST /orders/quote`: 100/min per IP (или 500/min для аутентифицированного пользователя)
