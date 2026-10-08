/**
 * Hierarchical Service Tree with Technical Specifications
 * 
 * Structure:
 * - Category (Level 1) → Subcategory (Level 2) → Type (Level 3, optional)
 * - Each node can have required specs (technical parameters)
 * 
 * ID Format:
 * - Category: "1", "2", "3", "4"
 * - Subcategory: "1.1", "3.2", "4.1"
 * - Type: "2.1.1", "4.1.1"
 */

export interface SpecParameter {
  name: string;
  type: 'number' | 'string' | 'select';
  required: boolean;
  unit?: string;
  min?: number;
  max?: number;
  options?: number[] | string[]; // for 'select' type
}

export interface ServiceNode {
  id: string;
  name: string;
  icon?: string;
  children?: ServiceNode[];
  specs?: SpecParameter[];
}

export interface ServiceCategory extends ServiceNode {
  id: string;
  children: ServiceSubcategory[];
}

export interface ServiceSubcategory extends ServiceNode {
  id: string;
  categoryId: string;
  children?: ServiceType[];
  specs?: SpecParameter[];
}

export interface ServiceType extends ServiceNode {
  id: string;
  subcategoryId: string;
  specs?: SpecParameter[];
}

export interface ServicesTree {
  categories: ServiceCategory[];
}

export const servicesTree: ServicesTree = {
  categories: [
    {
      id: "1",
      name: "Підготовка ґрунту",
      icon: "🚜",
      children: [
        {
          id: "1.1",
          name: "Дискування",
          categoryId: "1",
          specs: [],
        },
        {
          id: "1.2",
          name: "Рихлення",
          categoryId: "1",
          specs: [],
        },
        {
          id: "1.3",
          name: "Оранка",
          categoryId: "1",
          specs: [],
        },
        {
          id: "1.4",
          name: "Подрібнення",
          categoryId: "1",
          specs: [],
        },
        {
          id: "1.5",
          name: "Лущення",
          categoryId: "1",
          specs: [],
        },
        {
          id: "1.6",
          name: "Культивація",
          categoryId: "1",
          specs: [],
        },
      ],
    },
    {
      id: "2",
      name: "Посів",
      icon: "🌱",
      children: [
        {
          id: "2.1",
          name: "Суцільного висіву",
          categoryId: "2",
          children: [
            {
              id: "2.1.1",
              name: "Анкерні",
              subcategoryId: "2.1",
              specs: [],
            },
            {
              id: "2.1.2",
              name: "Дискові",
              subcategoryId: "2.1",
              specs: [],
            },
          ],
        },
        {
          id: "2.2",
          name: "Широкорядні",
          categoryId: "2",
          children: [
            {
              id: "2.2.1",
              name: "Анкерні",
              subcategoryId: "2.2",
              specs: [],
            },
            {
              id: "2.2.2",
              name: "Дискові",
              subcategoryId: "2.2",
              specs: [],
            },
          ],
        },
      ],
    },
    {
      id: "3",
      name: "Внесення ЗЗР, добрив",
      icon: "🚁",
      children: [
        {
          id: "3.1",
          name: "Дрони",
          categoryId: "3",
          specs: [
            { 
              name: "Ширина внесення штанги (м)", 
              type: "select", 
              required: true, 
              options: [4, 6, 8, 10] 
            },
          ],
        },
        {
          id: "3.2",
          name: "Причепні",
          categoryId: "3",
          specs: [
            { 
              name: "Ширина внесення штанги (м)", 
              type: "select", 
              required: true, 
              options: [18, 30] 
            },
            { 
              name: "Кліренс (см)", 
              type: "select", 
              required: true, 
              options: [105, 125, 135, 155, 175, 180, 190, 210] 
            },
          ],
        },
        {
          id: "3.3",
          name: "Самохідні",
          categoryId: "3",
          specs: [
            { 
              name: "Ширина внесення штанги (м)", 
              type: "select", 
              required: true, 
              options: [24, 28, 32, 36] 
            },
            { 
              name: "Кліренс (см)", 
              type: "select", 
              required: true, 
              options: [105, 125, 135, 155, 175, 180, 190, 210] 
            },
          ],
        },
      ],
    },
    {
      id: "4",
      name: "Збір врожаю",
      icon: "🌾",
      children: [
        {
          id: "4.1",
          name: "Зернозбиральні",
          categoryId: "4",
          children: [
            {
              id: "4.1.1",
              name: "Роторні",
              subcategoryId: "4.1",
              specs: [],
            },
            {
              id: "4.1.2",
              name: "Барабанні",
              subcategoryId: "4.1",
              specs: [],
            },
            {
              id: "4.1.3",
              name: "Гібридні",
              subcategoryId: "4.1",
              specs: [],
            },
          ],
        },
        {
          id: "4.2",
          name: "Бурякозбиральні",
          categoryId: "4",
          specs: [],
        },
        {
          id: "4.3",
          name: "Кормозбиральні",
          categoryId: "4",
          specs: [],
        },
        {
          id: "4.4",
          name: "Овочезбиральні",
          categoryId: "4",
          specs: [],
        },
      ],
    },
  ],
};

// Helper functions

export function getCategoryById(id: string): ServiceCategory | undefined {
  return servicesTree.categories.find((c) => c.id === id);
}

export function getSubcategoryById(id: string): ServiceSubcategory | undefined {
  for (const category of servicesTree.categories) {
    const subcategory = category.children.find((s) => s.id === id);
    if (subcategory) return subcategory;
  }
  return undefined;
}

export function getTypeById(id: string): ServiceType | undefined {
  for (const category of servicesTree.categories) {
    for (const subcategory of category.children) {
      if (subcategory.children) {
        const type = subcategory.children.find((t) => t.id === id);
        if (type) return type;
      }
    }
  }
  return undefined;
}

export function getRequiredSpecs(
  serviceTypeId: string | null,
  serviceSubCategoryId: string
): SpecParameter[] {
  if (serviceTypeId) {
    const type = getTypeById(serviceTypeId);
    if (type?.specs && type.specs.length > 0) {
      return type.specs.filter((s) => s.required);
    }
  }
  
  const subcategory = getSubcategoryById(serviceSubCategoryId);
  if (subcategory?.specs) {
    return subcategory.specs.filter((s) => s.required);
  }
  
  return [];
}

export function validateSpecs(
  serviceTypeId: string | null,
  serviceSubCategoryId: string,
  specs: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const requiredSpecs = getRequiredSpecs(serviceTypeId, serviceSubCategoryId);
  
  for (const spec of requiredSpecs) {
    const value = specs[spec.name];
    
    if (value === undefined || value === null || value === '') {
      errors.push(`Відсутнє обов'язкове поле: ${spec.name}`);
      continue;
    }
    
    if (spec.type === 'number') {
      const numValue = typeof value === 'number' ? value : Number(value);
      
      if (isNaN(numValue)) {
        errors.push(`Поле "${spec.name}" має бути числом`);
        continue;
      }
      
      if (spec.min !== undefined && numValue < spec.min) {
        errors.push(`Поле "${spec.name}" має бути не менше ${spec.min}${spec.unit || ''}`);
      }
      
      if (spec.max !== undefined && numValue > spec.max) {
        errors.push(`Поле "${spec.name}" має бути не більше ${spec.max}${spec.unit || ''}`);
      }
    } else if (spec.type === 'select') {
      const options = spec.options || [];
      const numValue = typeof value === 'number' ? value : Number(value);
      
      const isInOptions = options.some((opt) => opt === numValue || opt === value);
      if (!isInOptions) {
        errors.push(`Поле "${spec.name}" має бути одним з: ${(options as number[]).join(', ')}`);
      }
    }
  }
  
  return errors;
}

export function isValidSpecs(
  serviceTypeId: string | null,
  serviceSubCategoryId: string,
  specs: Record<string, unknown>
): boolean {
  return validateSpecs(serviceTypeId, serviceSubCategoryId, specs).length === 0;
}

/**
 * Validate performer-declared equipment specs for one service id.
 * Unknown id -> error. Category (no specs in tree) with non-empty specs ->
 * error. Missing service in tree is the only failure besides spec errors;
 * an ABSENT specs entry (not sent at all) means wildcard and is handled by
 * callers (no error here).
 */
export function validatePerformerServiceSpecs(
  serviceId: string,
  specs: Record<string, unknown>
): string[] {
  const value = specs ?? {};
  const type = getTypeById(serviceId);
  if (type) {
    const subcategory = getSubcategoryById(type.subcategoryId);
    if (!subcategory) return [`Unknown service ID: ${serviceId}`];
    return validateSpecs(type.id, subcategory.id, value);
  }
  const subcategory = getSubcategoryById(serviceId);
  if (subcategory) {
    return validateSpecs(null, subcategory.id, value);
  }
  const category = getCategoryById(serviceId);
  if (category) {
    return Object.keys(value).length > 0
      ? [`Service ${serviceId} takes no specs`]
      : [];
  }
  return [`Unknown service ID: ${serviceId}`];
}

export function getAllServiceIds(): {
  categories: string[];
  subcategories: string[];
  types: string[];
} {
  const categories: string[] = [];
  const subcategories: string[] = [];
  const types: string[] = [];
  
  for (const category of servicesTree.categories) {
    categories.push(category.id);
    
    for (const subcategory of category.children) {
      subcategories.push(subcategory.id);
      
      if (subcategory.children) {
        for (const type of subcategory.children) {
          types.push(type.id);
        }
      }
    }
  }
  
  return { categories, subcategories, types };
}

export function isValidServiceId(
  categoryId?: string,
  subcategoryId?: string,
  typeId?: string | null
): boolean {
  if (categoryId && !getCategoryById(categoryId)) {
    return false;
  }
  
  if (subcategoryId && !getSubcategoryById(subcategoryId)) {
    return false;
  }
  
  if (typeId && !getTypeById(typeId)) {
    return false;
  }
  
  return true;
}

export function getServicePath(serviceTypeId: string): {
  category: ServiceCategory;
  subcategory: ServiceSubcategory;
  type: ServiceType;
} | undefined {
  const type = getTypeById(serviceTypeId);
  if (!type) return undefined;
  
  const subcategory = getSubcategoryById(type.subcategoryId);
  if (!subcategory) return undefined;
  
  const category = getCategoryById(subcategory.categoryId);
  if (!category) return undefined;
  
  return { category, subcategory, type };
}

export function formatServiceSelection(
  categoryId: string,
  subcategoryId: string,
  typeId?: string | null
): string {
  const category = getCategoryById(categoryId);
  const subcategory = getSubcategoryById(subcategoryId);
  const type = typeId ? getTypeById(typeId) : undefined;
  
  const parts = [
    category?.name,
    subcategory?.name,
    type?.name,
  ].filter(Boolean);
  
  return parts.join(" → ");
}
