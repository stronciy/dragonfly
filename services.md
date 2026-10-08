# Service Hierarchy & Technical Specifications

## Overview
The service catalog uses a hierarchical tree structure with variable depth. Each leaf node can define required technical specifications (specs) for orders.

## Hierarchy Structure
```
Level 1: Category (serviceCategoryId)
  └─ Level 2: Subcategory (serviceSubCategoryId)
       └─ Level 3: Type (serviceTypeId) - can be null if tree ends at Level 2
            └─ Technical Specs (allowed parameters)
```

## ID Format
- **Category IDs**: Integer strings (e.g., "1", "2", "3")
- **Subcategory IDs**: Hierarchical (e.g., "1.1", "3.2")
- **Type IDs**: Hierarchical (e.g., "1.1.1", "3.2.1")

---

## Service Tree

### 1. 🚜 Оранка (Plowing)
**Category ID: "1"**

#### 1.1 Глибока оранка (Deep Plowing)
**Subcategory ID: "1.1"**

##### 1.1.1 Стандарт (Standard)
**Type ID: "1.1.1"**
- No specific specs required

##### 1.1.2 Посилений (Reinforced)
**Type ID: "1.1.2"**
- No specific specs required

#### 1.2 Поверхнева оранка (Shallow Plowing)
**Subcategory ID: "1.2"**

##### 1.2.1 Легка (Light)
**Type ID: "1.2.1"**
- No specific specs required

---

### 2. 🚜 Культивація (Cultivation)
**Category ID: "2"**

#### 2.1 Передпосівна (Pre-sowing)
**Subcategory ID: "2.1"**

##### 2.1.1 Неглибока (Shallow)
**Type ID: "2.1.1"**
- No specific specs required

##### 2.1.2 Глибока (Deep)
**Type ID: "2.1.2"**
- No specific specs required

#### 2.2 Міжрядна (Inter-row)
**Subcategory ID: "2.2"**
- No types defined (leaf subcategory)
- **Specs required:**
  - `Міжряддя (см)` - row spacing in cm

---

### 3. 🌱 Посів (Sowing)
**Category ID: "3"**

#### 3.1 Зернові (Grains)
**Subcategory ID: "3.1"**

##### 3.1.1 Пшениця (Wheat)
**Type ID: "3.1.1"**
- **Specs required:**
  - `Норма висіву (кг/га)` - seeding rate kg/ha

##### 3.1.2 Ячмінь (Barley)
**Type ID: "3.1.2"**
- **Specs required:**
  - `Норма висіву (кг/га)` - seeding rate kg/ha

##### 3.1.3 Кукурудза (Corn)
**Type ID: "3.1.3"**
- **Specs required:**
  - `Норма висіву (кг/га)` - seeding rate kg/ha
  - `Ширина міжрядь (см)` - row spacing cm

#### 3.2 Технічні (Technical Crops)
**Subcategory ID: "3.2"**

##### 3.2.1 Соняшник (Sunflower)
**Type ID: "3.2.1"**
- **Specs required:**
  - `Норма висіву (кг/га)` - seeding rate kg/ha
  - `Ширина міжрядь (см)` - row spacing cm

##### 3.2.2 Ріпак (Rapeseed)
**Type ID: "3.2.2"**
- **Specs required:**
  - `Норма висіву (кг/га)` - seeding rate kg/ha
  - `Ширина міжрядь (см)` - row spacing cm

---

### 4. 🌾 Збір врожаю (Harvesting)
**Category ID: "4"**

#### 4.1 Комбайнування (Combine Harvesting)
**Subcategory ID: "4.1"**

##### 4.1.1 Зернові (Grains)
**Type ID: "4.1.1"**
- **Specs required:**
  - `Висота зрізу (см)` - cutting height cm

##### 4.1.2 Кукурудза (Corn)
**Type ID: "4.1.2"**
- **Specs required:**
  - `Висота зрізу (см)` - cutting height cm
  - `Тип жатки` - header type (кукурудзяна/corn)

---

### 5. 💧 Внесення добрив (Fertilizing)
**Category ID: "5"**

#### 5.1 Рідкі (Liquid)
**Subcategory ID: "5.1"**
- No types defined (leaf subcategory)
- **Specs required:**
  - `Тип добрива` - fertilizer type (КАС/UREA/etc)
  - `Норма внесення (л/га)` - application rate L/ha

#### 5.2 Тверді (Solid)
**Subcategory ID: "5.2"**
- No types defined (leaf subcategory)
- **Specs required:**
  - `Тип добрива` - fertilizer type (нітроамофоска/карбамід/etc)
  - `Норма внесення (кг/га)` - application rate kg/ha

---

### 6. 🚁 Обробка посівів (Crop Protection)
**Category ID: "6"**

#### 6.1 Гербіциди (Herbicides)
**Subcategory ID: "6.1"**
- No types defined (leaf subcategory)
- **Specs required:**
  - `Ширина штанги (м)` - boom width meters
  - `Кліренс (см)` - clearance cm

#### 6.2 Фунгіциди (Fungicides)
**Subcategory ID: "6.2"**
- No types defined (leaf subcategory)
- **Specs required:**
  - `Ширина штанги (м)` - boom width meters
  - `Кліренс (см)` - clearance cm

#### 6.3 Інсектициди (Insecticides)
**Subcategory ID: "6.3"**
- No types defined (leaf subcategory)
- **Specs required:**
  - `Ширина штанги (м)` - boom width meters
  - `Кліренс (см)` - clearance cm

---

## Specs Validation Rules

### Numeric Fields
- Must be positive numbers
- Range validation based on parameter type

### String Fields (dropdowns)
- Must match one of the allowed values

### Example Valid Specs

#### Herbicides (6.1)
```json
{
  "Ширина штанги (м)": 24,
  "Кліренс (см)": 155
}
```

#### Sowing Corn (3.1.3)
```json
{
  "Норма висіву (кг/га)": 25,
  "Ширина міжрядь (см)": 70
}
```

#### Harvesting Corn (4.1.2)
```json
{
  "Висота зрізу (см)": 20,
  "Тип жатки": "кукурудзяна"
}
```

---

## API Usage

### Create Order with Specs
```typescript
POST /api/v1/orders
{
  "serviceCategoryId": "6",
  "serviceSubCategoryId": "6.1",
  "serviceTypeId": null,
  "specs": {
    "Ширина штанги (м)": 24,
    "Кліренс (см)": 155
  },
  "areaHa": 50,
  "dateFrom": "2026-04-01",
  "dateTo": "2026-04-05",
  "location": {
    "lat": 50.4501,
    "lng": 30.5234,
    "addressLabel": "Київська область",
    "regionName": "Київська"
  },
  "budget": 5000,
  "comment": "Обробка гербіцидами"
}
```

### Validate Specs
```typescript
import { validateSpecsForService } from './services-tree';

const errors = validateSpecsForService("6.1", {
  "Ширина штанги (м)": 24,
  "Кліренс (см)": 155
});

if (errors.length > 0) {
  throw new Error(`Invalid specs: ${errors.join(', ')}`);
}
```

---

## Database Schema

### orders table
```sql
ALTER TABLE "orders" ADD COLUMN "specs" JSONB DEFAULT '{}';
CREATE INDEX "orders_specs_idx" ON "orders" USING GIN ("specs");
```

---

## Migration Notes

1. Existing orders with `serviceTypeId` in old format (e.g., "wheat", "standard") need to be migrated
2. New orders must use hierarchical IDs
3. `specs` field is optional but recommended for equipment-heavy services

---

## Last Updated
2026-03-29
