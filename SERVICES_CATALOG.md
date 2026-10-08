# Services Catalog / Каталог послуг

Complete list of agricultural services for order matching in the Dragonfly system.

## Structure

Services are organized hierarchically:
- **Category** (Категорія) - Top-level service group with icon
- **Subcategory** (Підкатегорія) - Specific service type
- **Service Type** (Тип послуги) - Concrete service option

## Files

| File | Description |
|------|-------------|
| `services-catalog.json` | JSON format - universal |
| `services-catalog.ts` | TypeScript with matching helpers (backend/workers) |
| `services-catalog.mobile.ts` | TypeScript for React Native mobile app |

## API Endpoint

For live data (recommended), use:
```
GET /api/v1/catalog/services
```

## Services Overview

### 🚜 Оранка (plowing)
- **Глибока оранка** (deep)
  - `standard` — Стандарт
  - `reinforced` — Посилений
- **Поверхнева оранка** (shallow)
  - `light` — Легка

### 🚜 Культивація (cultivation)
- **Передпосівна** (pre_sowing)
  - `shallow` — Неглибока
  - `deep` — Глибока
- **Міжрядна** (inter_row)
  - *(no types defined)*

### 🌱 Посів (sowing)
- **Зернові** (grains)
  - `wheat` — Пшениця
  - `barley` — Ячмінь
  - `corn` — Кукурудза
- **Технічні** (technical)
  - `sunflower` — Соняшник
  - `rapeseed` — Ріпак

### 🌾 Збір врожаю (harvesting)
- **Комбайнування** (combine)
  - `grains` — Зернові
  - `corn` — Кукурудза

### 💧 Внесення добрив (fertilizing)
- **Рідкі** (liquid)
  - *(no types defined)*
- **Тверді** (solid)
  - *(no types defined)*

### 🚁 Обробка посівів (spraying)
- **Гербіциди** (herbicides)
  - *(no types defined)*
- **Фунгіциди** (fungicides)
  - *(no types defined)*

## Statistics

- **6** Categories / Категорій
- **10** Subcategories / Підкатегорій
- **15** Service Types / Типів послуг

## Usage in Mobile App

### Order Creation Flow

```tsx
import { servicesCatalog } from './services-catalog';

function ServiceSelector() {
  const [selected, setSelected] = useState({
    serviceCategoryId: '',
    serviceSubCategoryId: '',
    serviceTypeId: '',
  });

  return (
    <FlatList
      data={servicesCatalog.categories}
      keyExtractor={(item) => item.serviceCategoryId}
      renderItem={({ item: category }) => (
        <View>
          <Text>{category.icon} {category.serviceCategoryName}</Text>
          {category.subcategories.map((subcategory) => (
            <View key={subcategory.serviceSubCategoryId}>
              <Text>{subcategory.serviceSubCategoryName}</Text>
              {subcategory.types.map((type) => (
                <TouchableOpacity
                  key={type.serviceTypeId}
                  onPress={() => setSelected({
                    serviceCategoryId: category.serviceCategoryId,
                    serviceSubCategoryId: subcategory.serviceSubCategoryId,
                    serviceTypeId: type.serviceTypeId,
                  })}
                >
                  <Text>{type.serviceTypeName}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ))}
        </View>
      )}
    />
  );
}
```

### Worker Matching

```tsx
import { orderMatchesWorker, getMatchingSubcategoriesForWorker } from './services-catalog';

// Check if specific order matches worker
const isMatch = orderMatchesWorker(
  order.serviceSubCategoryId,
  order.serviceTypeId,
  worker.serviceTypes // ['standard', 'wheat', 'corn']
);

// Get all subcategories that match worker's services
const matchingSubcats = getMatchingSubcategoriesForWorker(worker.serviceTypes);
```

## Creating an Order

When creating an order, use the IDs:

```typescript
// POST /api/v1/orders
{
  "serviceCategoryId": "sowing",
  "serviceSubCategoryId": "grains",
  "serviceTypeId": "wheat",
  "areaHa": 50,
  "dateFrom": "2026-04-15",
  "dateTo": "2026-04-30",
  // ... other fields
}
```

## Worker Service Matching Logic

The matching system works as follows:

1. **Exact Type Match**: If order has a specific `serviceTypeId` and worker has that exact type → **MATCH**

2. **Subcategory Match**: If order's subcategory has any type that worker provides → **MATCH**

3. **Empty Types**: Subcategories with no types (like `inter_row`, `liquid`, `solid`, `herbicides`, `fungicides`) require special handling:
   - Worker must have explicit subcategory-level configuration
   - Or these are handled manually

Example:
```
Order: subcategory=grains, type=wheat
Worker services: ['wheat', 'barley']
→ MATCH (exact type)

Order: subcategory=grains, type=null
Worker services: ['wheat', 'barley']
→ MATCH (worker has types in same subcategory)

Order: subcategory=inter_row, type=null
Worker services: ['wheat']
→ NO MATCH (inter_row has no types defined)
```

## Last Updated

2026-03-29

## Notes

- All names are in **Ukrainian**
- IDs are stable and should be used in all API requests
- `icon` is an emoji string for UI display
- Empty `types` arrays indicate subcategories that need special handling
- Sort order is determined by array order
