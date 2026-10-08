# Hierarchical Performer Services

## Overview
Performer services have been migrated from a 3-column structure to a hierarchical string ID system that matches the service tree structure.

## Changes

### Database Schema
**Old structure:**
```sql
performer_services (
  service_category_id TEXT,
  service_subcategory_id TEXT,
  service_type_id TEXT
)
```

**New structure:**
```sql
performer_services (
  service_id TEXT,       -- e.g., "1", "1.1", "1.1.1"
  service_level INTEGER  -- 1=category, 2=subcategory, 3=type
)
```

### Migration
- **File:** `prisma/migrations/20260329_hierarchical_performer_services/migration.sql`
- Drops old columns: `service_category_id`, `service_subcategory_id`, `service_type_id`
- Adds new columns: `service_id`, `service_level`
- Creates unique index on `(performer_user_id, service_id)`

## API Changes

### GET /api/v1/performer/settings

**Old Response:**
```json
{
  "settings": {
    "services": [
      { "serviceCategoryId": "plowing", "serviceSubCategoryId": "deep", "serviceTypeId": null }
    ]
  }
}
```

**New Response:**
```json
{
  "settings": {
    "services": ["1.1", "1.3", "3.1"]
  }
}
```

### PUT /api/v1/performer/settings

**Old Payload:**
```json
{
  "services": [
    { "serviceCategoryId": "1", "serviceSubCategoryId": "1.1", "serviceTypeId": null }
  ]
}
```

**New Payload:**
```json
{
  "services": ["1.1", "1.3", "3.1", "3.2"]
}
```

## Service ID Levels

| Level | Format | Example | Meaning |
|-------|--------|---------|---------|
| 1 | `\d+` | `"1"` | Category (Оранка) |
| 2 | `\d+\.\d+` | `"1.1"` | Subcategory (Глибока оранка) |
| 3 | `\d+\.\d+\.\d+` | `"1.1.1"` | Type (Стандарт) |

## Matching Logic

The matching system uses hierarchical matching:

1. **Exact Type Match**: Performer has `"1.1.1"` → matches order with type `"1.1.1"`
2. **Subcategory Match**: Performer has `"1.1"` → matches order with subcategory `"1.1"` (no type)
3. **Category Match**: Performer has `"1"` → matches order with category `"1"` (no subcategory)
4. **Parent Match**: Performer has `"1.1"` → matches order with type `"1.1.1"` (parent of type)

### SQL Implementation
```sql
WHERE (
  -- Exact type match
  psvc.service_id = o.service_type_id
  -- Subcategory match (order has no type)
  OR (o.service_type_id IS NULL AND psvc.service_id = o.service_subcategory_id)
  -- Category match (order has no subcategory)
  OR (o.service_subcategory_id IS NULL AND psvc.service_id = o.service_category_id)
  -- Parent match (performer has subcategory, order has type)
  OR (
    o.service_type_id IS NOT NULL AND
    (
      psvc.service_id = split_part(o.service_type_id, '.', 1) || '.' || split_part(o.service_type_id, '.', 2)
      OR psvc.service_id = split_part(o.service_type_id, '.', 1)
    )
  )
)
```

## Validation

The API validates service IDs by checking if they exist in the service tree:

```typescript
import { getCategoryById, getSubcategoryById, getTypeById } from './services-tree';

// Check if ID exists
const category = getCategoryById("1");     // exists
const subcategory = getSubcategoryById("1.1"); // exists
const type = getTypeById("1.1.1");        // exists

// Invalid IDs are rejected
const invalid = getCategoryById("999");    // undefined
```

## Updated Files

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Updated PerformerService model |
| `src/app/api/v1/performer/settings/route.ts` | New API logic |
| `src/workers/matchNewExecutor.worker.ts` | Updated matching SQL |
| `src/workers/matchNewOrder.worker.ts` | Updated matching SQL |
| `src/workers/depositDeadlineTimeout.worker.ts` | Updated matching SQL |
| `src/app/api/v1/orders/route.ts` | Updated debug queries |

## Data Migration

**Important:** Existing performer services will be cleared during migration. Performers will need to re-select their services.

If you need to preserve existing data, create a mapping script:

```sql
-- Example mapping (adjust based on your actual data)
UPDATE performer_services
SET service_id = 
  CASE
    WHEN service_category_id = 'plowing' AND service_subcategory_id = 'deep' AND service_type_id IS NULL THEN '1.1'
    WHEN service_category_id = 'plowing' AND service_subcategory_id = 'deep' AND service_type_id = 'standard' THEN '1.1.1'
    -- ... add more mappings
  END,
  service_level = 
  CASE
    WHEN service_type_id IS NOT NULL THEN 3
    WHEN service_subcategory_id IS NOT NULL THEN 2
    ELSE 1
  END;
```

## Usage Examples

### Mobile App - Save Services

```typescript
// PUT /api/v1/performer/settings
fetch('/api/v1/performer/settings', {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    services: ["1.1", "1.1.1", "3.1", "3.2.1"]
  })
})
```

### Mobile App - Load Services

```typescript
// GET /api/v1/performer/settings
const response = await fetch('/api/v1/performer/settings');
const { settings } = await response.json();
// settings.services = ["1.1", "1.1.1"]
```

### Backend - Check if Performer Has Service

```typescript
import { getSubcategoryById, getTypeById } from './services-tree';

const performerServices = ["1.1", "3.1.1"];

// Check if performer selected specific type
const hasType = performerServices.includes("3.1.1"); // true

// Check if performer selected parent (matches all children)
const hasParent = performerServices.includes("1.1"); // true
// This matches orders with types: 1.1.1, 1.1.2, etc.
```

## Last Updated
2026-03-29
