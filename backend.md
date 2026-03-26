# ТЕХНІЧНЕ ЗАВДАННЯ: Виправлення помилки performerProfile.upsert()

## ❌ Критична помилка

```
PATCH /api/v1/users/me/role

ERROR: Invalid `prisma.performerProfile.upsert()` invocation:
The column `(not available)` does not exist in the current database.
```

**Проблема:** Бекенд намагається створити/оновити `performerProfile` через `upsert()`, але структура таблиці в БД не відповідає коду Prisma.

---

## 1. АНАЛІЗ ПРОБЛЕМИ

### 1.1. Endpoint що викликає помилку

**Request:**
```http
PATCH /api/v1/users/me/role
Authorization: Bearer <token>
Content-Type: application/json

{
  "role": "performer"
}
```

**Очікуваний Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "user": {
      "id": "usr_xxx",
      "role": "performer"
    }
  },
  "message": "Role updated",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

**Side Effect:** Автоматичне створення `performerProfile` якщо відсутній

### 1.2. Причина помилки

Бекенд код використовує `prisma.performerProfile.upsert()` з полями які **не існують** в поточній схемі бази даних.

**Ймовірний код бекенду:**
```typescript
await prisma.performerProfile.upsert({
  where: { userId: user.id },
  update: { /* поля */ },
  create: {
    userId: user.id,
    baseLocationLabel: data.baseLocationLabel,  // ❌ колонки немає в БД
    baseLatitude: data.baseCoordinate?.lat,     // ❌ колонки немає в БД
    baseLongitude: data.baseCoordinate?.lng,    // ❌ колонки немає в БД
    coverageMode: data.coverage?.mode,          // ❌ колонки немає в БД
    coverageRadiusKm: data.coverage?.radiusKm,  // ❌ колонки немає в БД
    // ... інші поля
  }
});
```

---

## 2. ВИМОГИ ДО БАЗИ ДАНИХ

### 2.1. Необхідна схема Prisma

**Файл:** `prisma/schema.prisma`

```prisma
// Модель User (перевірити наявність)
model User {
  id                String             @id @default(cuid())
  email             String             @unique
  name              String
  password          String
  role              String             @default("customer") // "customer" | "performer"
  createdAt         DateTime           @default(now())
  updatedAt         DateTime           @updatedAt
  
  performerProfile  PerformerProfile?
  customerProfile   CustomerProfile?
  // ... інші relations
}

// ✅ ОБОВ'ЯЗКОВО: Модель PerformerProfile
model PerformerProfile {
  id                  String             @id @default(cuid())
  userId              String             @unique
  user                User               @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  // Налаштування виконавця (Performer Settings)
  baseLocationLabel   String?
  baseLatitude        Float?
  baseLongitude       Float?
  coverageMode        String?            @default("radius")
  coverageRadiusKm    Int?               @default(50)
  
  // Послуги
  services            PerformerService[]
  
  // Юридичний профіль (вбудований)
  companyName         String?
  edrpou              String?
  iban                String?
  legalAddress        String?
  vatPayer            Boolean            @default(false)
  
  // Рейтинги
  avgRating           Float              @default(0)
  reviewCount         Int                @default(0)
  
  createdAt           DateTime           @default(now())
  updatedAt           DateTime           @updatedAt
  
  @@index([userId])
  @@index([baseLatitude, baseLongitude])
}

// ✅ ОБОВ'ЯЗКОВО: Модель PerformerService
model PerformerService {
  id                  String           @id @default(cuid())
  performerProfileId  String
  performerProfile    PerformerProfile @relation(fields: [performerProfileId], references: [id], onDelete: Cascade)
  
  serviceCategoryId   String
  serviceSubCategoryId String
  serviceTypeId       String?
  
  createdAt           DateTime         @default(now())
  
  @@unique([performerProfileId, serviceCategoryId, serviceSubCategoryId, serviceTypeId])
  @@index([performerProfileId])
}

// ✅ ОПЦІОНАЛЬНО: Модель PerformerReview (якщо потрібні відгуки)
model PerformerReview {
  id              String           @id @default(cuid())
  orderId         String           @unique
  performerId     String
  performer       PerformerProfile @relation(fields: [performerId], references: [id], onDelete: Cascade)
  
  customerId      String
  customerName    String
  
  rating          Int
  comment         String?
  
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt
  
  @@index([performerId])
}
```

### 2.2. SQL Міграція

**Файл:** `prisma/migrations/20260326_add_performer_profile_tables/migration.sql`

```sql
-- CreateTable: performer_profile
CREATE TABLE IF NOT EXISTS "performer_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "baseLocationLabel" TEXT,
    "baseLatitude" DOUBLE PRECISION,
    "baseLongitude" DOUBLE PRECISION,
    "coverageMode" TEXT DEFAULT 'radius',
    "coverageRadiusKm" INTEGER DEFAULT 50,
    "companyName" TEXT,
    "edrpou" TEXT,
    "iban" TEXT,
    "legalAddress" TEXT,
    "vatPayer" BOOLEAN NOT NULL DEFAULT false,
    "avgRating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,
    
    CONSTRAINT "performer_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable: performer_service
CREATE TABLE IF NOT EXISTS "performer_service" (
    "id" TEXT NOT NULL,
    "performerProfileId" TEXT NOT NULL,
    "serviceCategoryId" TEXT NOT NULL,
    "serviceSubCategoryId" TEXT NOT NULL,
    "serviceTypeId" TEXT,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    
    CONSTRAINT "performer_service_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "performer_profile_userId_key" 
    ON "performer_profile"("userId");

CREATE INDEX IF NOT EXISTS "performer_profile_userId_idx" 
    ON "performer_profile"("userId");

CREATE INDEX IF NOT EXISTS "performer_profile_location_idx" 
    ON "performer_profile"("baseLatitude", "baseLongitude");

CREATE INDEX IF NOT EXISTS "performer_service_performerProfileId_idx" 
    ON "performer_service"("performerProfileId");

CREATE UNIQUE INDEX IF NOT EXISTS "performer_service_unique" 
    ON "performer_service"(
        "performerProfileId", 
        "serviceCategoryId", 
        "serviceSubCategoryId", 
        "serviceTypeId"
    );

-- AddForeignKey
ALTER TABLE "performer_profile" 
    ADD CONSTRAINT "performer_profile_userId_fkey" 
    FOREIGN KEY ("userId") 
    REFERENCES "user"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE;

ALTER TABLE "performer_service" 
    ADD CONSTRAINT "performer_service_performerProfileId_fkey" 
    FOREIGN KEY ("performerProfileId") 
    REFERENCES "performer_profile"("id") 
    ON DELETE CASCADE 
    ON UPDATE CASCADE;
```

---

## 3. API ENDPOINTS

### 3.1. PATCH `/api/v1/users/me/role`

**Призначення:** Зміна ролі користувача + автоматичне створення профілю

**Auth:** Bearer token  
**Role:** будь-яка

**Request:**
```json
{
  "role": "performer"
}
```

**Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "user": {
      "id": "usr_xxx",
      "role": "performer"
    }
  },
  "message": "Role updated successfully",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

**Логіка роботи (Псевдокод):**

```typescript
async function updateUserRole(userId: string, newRole: string) {
  // 1. Оновлюємо роль в User
  const updatedUser = await prisma.user.update({
    where: { id: userId },
    data: { role: newRole }
  });
  
  // 2. Якщо role = performer, створюємо performerProfile
  if (newRole === 'performer') {
    await prisma.performerProfile.upsert({
      where: { userId: userId },
      update: {}, // Пусте оновлення, профіль вже існує
      create: {
        userId: userId,
        coverageMode: 'radius',
        coverageRadiusKm: 50,
        vatPayer: false,
        avgRating: 0,
        reviewCount: 0
        // ❗ НЕ передавати поля яких немає в БД!
      }
    });
  }
  
  // 3. Якщо role = customer, створюємо customerProfile
  if (newRole === 'customer') {
    await prisma.customerProfile.upsert({
      where: { userId: userId },
      update: {},
      create: {
        userId: userId
        // ... дефолтні значення
      }
    });
  }
  
  return updatedUser;
}
```

**❗ Критично важливо:**
- Перевірити що всі поля в `create` та `update` існують в схемі Prisma
- НЕ використовувати вкладені об'єкти типу `baseCoordinate: { lat, lng }` — розділяти на `baseLatitude`, `baseLongitude`
- НЕ використовувати вкладені об'єкти типу `coverage: { mode, radiusKm }` — розділяти на `coverageMode`, `coverageRadiusKm`

---

### 3.2. GET `/api/v1/performer/settings`

**Призначення:** Отримання налаштувань виконавця

**Auth:** Bearer token  
**Role:** `performer`

**Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "settings": {
      "baseLocationLabel": "Полтава, база №1",
      "baseCoordinate": {
        "lat": 49.8397,
        "lng": 24.0297
      },
      "coverage": {
        "mode": "radius",
        "radiusKm": 50
      },
      "services": [
        {
          "serviceCategoryId": "spraying",
          "serviceSubCategoryId": "pesticide",
          "serviceTypeId": "type-a"
        }
      ]
    }
  },
  "message": "Settings retrieved",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

**Логіка формування відповіді:**

```typescript
const profile = await prisma.performerProfile.findUnique({
  where: { userId: user.id },
  include: { services: true }
});

// ❗ Трансформуємо плоскі поля в об'єкти для фронтенду
return {
  settings: {
    baseLocationLabel: profile.baseLocationLabel,
    baseCoordinate: {
      lat: profile.baseLatitude,
      lng: profile.baseLongitude
    },
    coverage: {
      mode: profile.coverageMode,
      radiusKm: profile.coverageRadiusKm
    },
    services: profile.services.map(s => ({
      serviceCategoryId: s.serviceCategoryId,
      serviceSubCategoryId: s.serviceSubCategoryId,
      serviceTypeId: s.serviceTypeId
    }))
  }
};
```

---

### 3.3. PUT `/api/v1/performer/settings`

**Призначення:** Збереження налаштувань виконавця

**Auth:** Bearer token  
**Role:** `performer`

**Request:**
```json
{
  "baseLocationLabel": "Полтава, база №1",
  "baseCoordinate": {
    "lat": 49.8397,
    "lng": 24.0297
  },
  "coverage": {
    "mode": "radius",
    "radiusKm": 75
  },
  "services": [
    {
      "serviceCategoryId": "spraying",
      "serviceSubCategoryId": "pesticide",
      "serviceTypeId": "type-a"
    }
  ]
}
```

**❗ Критично важливо:**
Бекенд має **розділити** вкладені об'єкти на плоскі поля перед збереженням:

```typescript
async function updatePerformerSettings(userId: string, data: any) {
  // 1. Розділяємо вкладені об'єкти на плоскі поля
  const updateData = {
    baseLocationLabel: data.baseLocationLabel,
    baseLatitude: data.baseCoordinate?.lat,
    baseLongitude: data.baseCoordinate?.lng,
    coverageMode: data.coverage?.mode,
    coverageRadiusKm: data.coverage?.radiusKm
  };
  
  // 2. Оновлюємо профіль
  await prisma.performerProfile.update({
    where: { userId },
    data: updateData
  });
  
  // 3. Оновлюємо послуги (видалити старі + додати нові)
  if (data.services) {
    await prisma.performerService.deleteMany({
      where: { performerProfile: { userId } }
    });
    
    await prisma.performerService.createMany({
      data: data.services.map(s => ({
        performerProfileId: userId,
        serviceCategoryId: s.serviceCategoryId,
        serviceSubCategoryId: s.serviceSubCategoryId,
        serviceTypeId: s.serviceTypeId
      }))
    });
  }
  
  // 4. Enqueue match-new-executor для оновлення матчів
  await enqueueMatchNewExecutor(userId);
  
  return { ok: true };
}
```

**Валідація:**
- `baseLatitude`: Float, діапазон [-90, 90]
- `baseLongitude`: Float, діапазон [-180, 180]
- `coverageMode`: string, enum `["radius", "custom"]`
- `coverageRadiusKm`: integer, min 1, max 500
- `services[].serviceCategoryId`: string, trim, min 1
- `services[].serviceSubCategoryId`: string, trim, min 1
- `services[].serviceTypeId`: string | null

**Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": { "ok": true },
  "message": "Settings updated",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

---

### 3.4. GET `/api/v1/performer/legal-profile`

**Призначення:** Отримання юридичного профілю

**Auth:** Bearer token  
**Role:** `performer`

**Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "legalProfile": {
      "companyName": "ФОП Петренко І.В.",
      "edrpou": "1234567890",
      "iban": "UA213223130000026007233566001",
      "legalAddress": "м. Полтава, вул. Шевченка, 1",
      "vatPayer": true
    }
  },
  "message": "Legal profile retrieved",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

**Логіка:**
```typescript
const profile = await prisma.performerProfile.findUnique({
  where: { userId: user.id },
  select: {
    companyName: true,
    edrpou: true,
    iban: true,
    legalAddress: true,
    vatPayer: true
  }
});

if (!profile) {
  return res.status(404).json({ 
    success: false, 
    code: 'NOT_FOUND',
    message: 'Legal profile not found'
  });
}

return {
  legalProfile: {
    companyName: profile.companyName,
    edrpou: profile.edrpou,
    iban: profile.iban,
    legalAddress: profile.legalAddress,
    vatPayer: profile.vatPayer
  }
};
```

---

### 3.5. PATCH `/api/v1/performer/legal-profile`

**Призначення:** Оновлення юридичного профілю

**Auth:** Bearer token  
**Role:** `performer`

**Request:**
```json
{
  "companyName": "ФОП Петренко І.В.",
  "edrpou": "1234567890",
  "iban": "UA213223130000026007233566001",
  "legalAddress": "м. Полтава, вул. Шевченка, 1",
  "vatPayer": true
}
```

**Валідація:**
- `companyName`: string | null, trim, 2-120 символів
- `edrpou`: string | null, тільки цифри, 8-10 символів
- `iban`: string | null, UA IBAN (29 символів), перевірка MOD-97
- `legalAddress`: string | null, trim, 5-255 символів
- `vatPayer`: boolean (обов'язкове)

**Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "legalProfile": {
      "companyName": "ФОП Петренко І.В.",
      "edrpou": "1234567890",
      "iban": "UA213223130000026007233566001",
      "legalAddress": "м. Полтава, вул. Шевченка, 1",
      "vatPayer": true
    }
  },
  "message": "Legal profile updated",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

---

### 3.6. GET `/api/v1/performer/rating`

**Auth:** Bearer token  
**Role:** `performer`

**Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "rating": {
      "avg": 4.8,
      "count": 24
    }
  },
  "message": "Rating retrieved",
  "timestamp": "2026-03-26T10:00:00.000Z"
}
```

---

### 3.7. GET `/api/v1/performer/reviews`

**Auth:** Bearer token  
**Role:** `performer`

**Query:** `limit=20`, `offset=0`

**Response 200:**
```json
{
  "success": true,
  "code": "SUCCESS",
  "data": {
    "items": [
      {
        "id": "rev_xxx",
        "orderId": "cmm_xxx",
        "customerName": "ТОВ Агро-Лідер",
        "rating": 5,
        "comment": "Чудова робота!",
        "createdAt": "2026-03-20T10:00:00.000Z"
      }
    ],
    "page": {
      "limit": 20,
      "offset": 0,
      "total": 24
    }
  }
}
```

---

## 4. ПЛАН ВИКОНАННЯ

### Крок 1: Діагностика

```bash
# 1. Перевірити поточну схему Prisma
cat prisma/schema.prisma

# 2. Перевірити наявність міграцій
ls prisma/migrations/

# 3. Перевірити структуру БД
npx prisma db pull  # отримати актуальну схему з БД
npx prisma generate # перегенерувати клієнт
```

### Крок 2: Виправлення схеми

1. [ ] Додати модель `PerformerProfile` в `schema.prisma`
2. [ ] Додати модель `PerformerService` в `schema.prisma`
3. [ ] Перевірити що всі поля відповідають коду бекенду

### Крок 3: Створення міграції

```bash
npx prisma migrate dev --name add_performer_profile_tables
```

### Крок 4: Застосування міграції

```bash
# Production
npx prisma migrate deploy
```

### Крок 5: Перевірка коду бекенду

Перевірити файл що обробляє `PATCH /api/v1/users/me/role`:

```typescript
// ❌ НЕПРАВИЛЬНО (викличе помилку)
await prisma.performerProfile.upsert({
  create: {
    userId: user.id,
    baseCoordinate: data.baseCoordinate,  // ❌ такого поля немає!
    coverage: data.coverage               // ❌ такого поля немає!
  }
});

// ✅ ПРАВИЛЬНО
await prisma.performerProfile.upsert({
  create: {
    userId: user.id,
    baseLatitude: data.baseCoordinate?.lat,    // ✅ плоскі поля
    baseLongitude: data.baseCoordinate?.lng,   // ✅ плоскі поля
    coverageMode: data.coverage?.mode,         // ✅ плоскі поля
    coverageRadiusKm: data.coverage?.radiusKm  // ✅ плоскі поля
  }
});
```

### Крок 6: Тестування

```bash
# 1. Тест зміни ролі
curl -X PATCH https://api.dragonfly.ua/api/v1/users/me/role \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"role": "performer"}'

# Очікується: 200 OK

# 2. Тест отримання налаштувань
curl -X GET https://api.dragonfly.ua/api/v1/performer/settings \
  -H "Authorization: Bearer <token>"

# Очікується: 200 OK з settings

# 3. Тест збереження налаштувань
curl -X PUT https://api.dragonfly.ua/api/v1/performer/settings \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "baseLocationLabel": "Test",
    "baseCoordinate": { "lat": 49.8, "lng": 24.0 },
    "coverage": { "mode": "radius", "radiusKm": 50 }
  }'

# Очікується: 200 OK
```

---

## 5. ДОДАТКОВІ ВИМОГИ

### 5.1. Обробка помилок

```typescript
// Приклад обробки помилок
try {
  await prisma.performerProfile.upsert({ ... });
} catch (error) {
  if (error.code === 'P2002') {
    return res.status(409).json({
      success: false,
      code: 'CONFLICT',
      message: 'Profile already exists'
    });
  }
  
  if (error.code === 'P2003') {
    return res.status(400).json({
      success: false,
      code: 'INVALID_REFERENCE',
      message: 'User not found'
    });
  }
  
  // ❗ Логувати деталі помилки для дебагу
  console.error('[performerProfile.upsert] error:', {
    code: error.code,
    message: error.message,
    meta: error.meta
  });
  
  return res.status(500).json({
    success: false,
    code: 'INTERNAL_ERROR',
    message: 'Database error'
  });
}
```

### 5.2. Логування

Додати детальне логування для дебагу:

```typescript
console.log('[performerProfile.upsert] input:', {
  userId,
  createData: sanitizedCreateData,
  updateData: sanitizedUpdateData
});
```

### 5.3. Автоматичне створення профілю

При реєстрації нового користувача з `role: performer`:

```typescript
// POST /api/v1/auth/register
const user = await prisma.user.create({
  data: {
    email,
    name,
    password,
    role: 'performer'
  }
});

// Автоматично створити performerProfile
await prisma.performerProfile.create({
  data: {
    userId: user.id,
    coverageMode: 'radius',
    coverageRadiusKm: 50,
    vatPayer: false,
    avgRating: 0,
    reviewCount: 0
  }
});
```

---

## 6. ЧЕК-ЛИСТ ПЕРЕВІРКИ

### База даних
- [ ] Таблиця `performer_profile` існує
- [ ] Таблиця `performer_service` існує
- [ ] Всі колонки присутні (baseLatitude, baseLongitude, coverageMode, coverageRadiusKm, companyName, edrpou, iban, legalAddress, vatPayer, avgRating, reviewCount)
- [ ] Індекс на `userId`
- [ ] Індекс на `baseLatitude, baseLongitude`
- [ ] Foreign key на `user.id`

### Бекенд код
- [ ] `PATCH /api/v1/users/me/role` створює профіль автоматично
- [ ] Всі поля в `create/update` плоскі (не вкладені об'єкти)
- [ ] `GET /api/v1/performer/settings` трансформує плоскі поля в об'єкти
- [ ] `PUT /api/v1/performer/settings` розділяє об'єкти на плоскі поля
- [ ] Валідація IBAN (MOD-97)
- [ ] Валідація ЄДРПОУ (8-10 цифр)
- [ ] Обробка помилок Prisma

### Тестування
- [ ] Зміна ролі на `performer` працює
- [ ] Отримання налаштувань працює
- [ ] Збереження налаштувань працює
- [ ] Юридичний профіль працює
- [ ] Помилка `upsert()` зникла

---

## 7. КОНТАКТИ ДЛЯ УЗГОДЖЕННЯ

**Пріоритет:** 🔴 КРИТИЧНИЙ (блокує всю роботу з профілем виконавця)

**Дата:** 2026-03-26

**Фронтенд контакт:** [Mobile App Team]

**Бекенд контакт:** [Backend Team]

---

## ДОДАТОК А: Приклади запитів

### cURL тести

```bash
# 1. Зміна ролі
curl -X PATCH https://api.dragonfly.ua/api/v1/users/me/role \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{"role": "performer"}'

# 2. Отримання налаштувань
curl -X GET https://api.dragonfly.ua/api/v1/performer/settings \
  -H "Authorization: Bearer eyJhbGc..."

# 3. Збереження налаштувань
curl -X PUT https://api.dragonfly.ua/api/v1/performer/settings \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{
    "baseLocationLabel": "Полтава",
    "baseCoordinate": {"lat": 49.8397, "lng": 24.0297},
    "coverage": {"mode": "radius", "radiusKm": 50},
    "services": [
      {"serviceCategoryId": "spraying", "serviceSubCategoryId": "pesticide", "serviceTypeId": "type-a"}
    ]
  }'

# 4. Отримання юр. профілю
curl -X GET https://api.dragonfly.ua/api/v1/performer/legal-profile \
  -H "Authorization: Bearer eyJhbGc..."

# 5. Оновлення юр. профілю
curl -X PATCH https://api.dragonfly.ua/api/v1/performer/legal-profile \
  -H "Authorization: Bearer eyJhbGc..." \
  -H "Content-Type: application/json" \
  -d '{
    "companyName": "ФОП Петренко",
    "edrpou": "1234567890",
    "iban": "UA213223130000026007233566001",
    "legalAddress": "м. Полтава",
    "vatPayer": true
  }'
```
