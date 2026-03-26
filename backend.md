# Backend Technical Specification (Dragonfly App)

This document serves as the Source of Truth for the Dragonfly backend implementation. It defines the naming conventions, database schema, and API contracts required for full compatibility with the mobile application.

## 1. Core Principles
- **Table Naming**: Plural (`users`, `orders`, `performer_profiles`).
- **Column Naming**: snake_case in Database (`user_id`, `avg_rating`) / camelCase in Prisma Client (`userId`, `avgRating`).
- **Standard**: If a field is `avgRating` in TypeScript, it MUST map to `avg_rating` in Postgres.

## 2. Database Schema Fixes

Run the following SQL to ensure your existing tables have the required columns for the Performer Profile features.

```sql
-- 1. Update performer_profiles table
ALTER TABLE "performer_profiles" 
ADD COLUMN IF NOT EXISTS "base_location_label" TEXT,
ADD COLUMN IF NOT EXISTS "base_latitude" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "base_longitude" DOUBLE PRECISION,
ADD COLUMN IF NOT EXISTS "coverage_mode" TEXT DEFAULT 'radius',
ADD COLUMN IF NOT EXISTS "coverage_radius_km" INTEGER DEFAULT 50,
ADD COLUMN IF NOT EXISTS "avg_rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "review_count" INTEGER NOT NULL DEFAULT 0;

-- 2. Ensure performer_services exists
CREATE TABLE IF NOT EXISTS "performer_services" (
    "id" TEXT NOT NULL,
    "performer_user_id" TEXT NOT NULL,
    "service_category_id" TEXT NOT NULL,
    "service_subcategory_id" TEXT NOT NULL,
    "service_type_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "performer_services_pkey" PRIMARY KEY ("id")
);

-- 3. Add Unique constraint for services
CREATE UNIQUE INDEX IF NOT EXISTS "uniq_performer_service" 
ON "performer_services"("performer_user_id", "service_category_id", "service_subcategory_id", "service_type_id");

-- 4. Add Foreign Keys
ALTER TABLE "performer_services" 
ADD CONSTRAINT "performer_services_performer_user_id_fkey" 
FOREIGN KEY ("performer_user_id") REFERENCES "performer_profiles"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;
```

## 3. API Contract: Role Switching

### PATCH `/api/v1/users/me/role`
Used to switch the user's current role (e.g., from Customer to Performer).

**Request Body:**
```json
{
  "role": "performer"
}
```

**Backend Logic:**
1. Update `role` in `users` table.
2. `upsert` a record into `performer_profiles` (or `customer_profiles`).
3. If switching to `performer`, initialize defaults:
   - `coverage_mode`: "radius"
   - `coverage_radius_km`: 50
   - `avg_rating`: 0
   - `review_count`: 0

## 4. API Contract: Performer Settings

### PUT `/api/v1/performer/settings`
Updates the performer's location and coverage area.

**Request Body:**
```json
{
  "baseLocationLabel": "Kyiv, Ukraine",
  "baseCoordinate": { "lat": 50.45, "lng": 30.52 },
  "coverage": { "mode": "radius", "radiusKm": 100 },
  "services": [
    {
      "serviceCategoryId": "cat_1",
      "serviceSubCategoryId": "sub_1",
      "serviceTypeId": "type_1"
    }
  ]
}
```

**Backend Logic:**
- Flatten `baseCoordinate` into `base_latitude` and `base_longitude`.
- Flatten `coverage` into `coverage_mode` and `coverage_radius_km`.
- Update `performer_profiles` table.
- Sync `performer_services` table (delete old, insert new).

## 5. Summary of Common 500 Errors
- **"Table public.user does not exist"**: Caused by using singular `@@map("user")` in Prisma while the DB table is `users`. Fix: use plural in Prisma.
- **"Column avg_rating does not exist"**: Caused by missing columns in `performer_profiles`. Fix: Run the SQL in Section 2.
- **"(not available)"**: Same as above, usually during an `upsert`.
