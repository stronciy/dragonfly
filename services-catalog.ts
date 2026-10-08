/**
 * Services Catalog for Order Matching
 * 
 * Structure optimized for matching orders by service category/subcategory/type
 * All names in Ukrainian
 * 
 * Usage:
 * - Import for static matching logic
 * - Or fetch from API: GET /api/v1/catalog/services
 */

export interface ServiceType {
  serviceTypeId: string;
  serviceTypeName: string;
}

export interface ServiceSubcategory {
  serviceSubCategoryId: string;
  serviceSubCategoryName: string;
  types: ServiceType[];
}

export interface ServiceCategory {
  serviceCategoryId: string;
  serviceCategoryName: string;
  icon: string;
  subcategories: ServiceSubcategory[];
}

export interface ServicesCatalog {
  categories: ServiceCategory[];
  metadata: {
    totalCategories: number;
    totalSubcategories: number;
    totalTypes: number;
    lastUpdated: string;
  };
}

export const servicesCatalog: ServicesCatalog = {
  categories: [
    {
      serviceCategoryId: "plowing",
      serviceCategoryName: "Оранка",
      icon: "🚜",
      subcategories: [
        {
          serviceSubCategoryId: "deep",
          serviceSubCategoryName: "Глибока оранка",
          types: [
            { serviceTypeId: "standard", serviceTypeName: "Стандарт" },
            { serviceTypeId: "reinforced", serviceTypeName: "Посилений" },
          ],
        },
        {
          serviceSubCategoryId: "shallow",
          serviceSubCategoryName: "Поверхнева оранка",
          types: [
            { serviceTypeId: "light", serviceTypeName: "Легка" },
          ],
        },
      ],
    },
    {
      serviceCategoryId: "cultivation",
      serviceCategoryName: "Культивація",
      icon: "🚜",
      subcategories: [
        {
          serviceSubCategoryId: "pre_sowing",
          serviceSubCategoryName: "Передпосівна",
          types: [
            { serviceTypeId: "shallow", serviceTypeName: "Неглибока" },
            { serviceTypeId: "deep", serviceTypeName: "Глибока" },
          ],
        },
        {
          serviceSubCategoryId: "inter_row",
          serviceSubCategoryName: "Міжрядна",
          types: [],
        },
      ],
    },
    {
      serviceCategoryId: "sowing",
      serviceCategoryName: "Посів",
      icon: "🌱",
      subcategories: [
        {
          serviceSubCategoryId: "grains",
          serviceSubCategoryName: "Зернові",
          types: [
            { serviceTypeId: "wheat", serviceTypeName: "Пшениця" },
            { serviceTypeId: "barley", serviceTypeName: "Ячмінь" },
            { serviceTypeId: "corn", serviceTypeName: "Кукурудза" },
          ],
        },
        {
          serviceSubCategoryId: "technical",
          serviceSubCategoryName: "Технічні",
          types: [
            { serviceTypeId: "sunflower", serviceTypeName: "Соняшник" },
            { serviceTypeId: "rapeseed", serviceTypeName: "Ріпак" },
          ],
        },
      ],
    },
    {
      serviceCategoryId: "harvesting",
      serviceCategoryName: "Збір врожаю",
      icon: "🌾",
      subcategories: [
        {
          serviceSubCategoryId: "combine",
          serviceSubCategoryName: "Комбайнування",
          types: [
            { serviceTypeId: "grains", serviceTypeName: "Зернові" },
            { serviceTypeId: "corn", serviceTypeName: "Кукурудза" },
          ],
        },
      ],
    },
    {
      serviceCategoryId: "fertilizing",
      serviceCategoryName: "Внесення добрив",
      icon: "💧",
      subcategories: [
        {
          serviceSubCategoryId: "liquid",
          serviceSubCategoryName: "Рідкі",
          types: [],
        },
        {
          serviceSubCategoryId: "solid",
          serviceSubCategoryName: "Тверді",
          types: [],
        },
      ],
    },
    {
      serviceCategoryId: "spraying",
      serviceCategoryName: "Обробка посівів",
      icon: "🚁",
      subcategories: [
        {
          serviceSubCategoryId: "herbicides",
          serviceSubCategoryName: "Гербіциди",
          types: [],
        },
        {
          serviceSubCategoryId: "fungicides",
          serviceSubCategoryName: "Фунгіциди",
          types: [],
        },
      ],
    },
  ],
  metadata: {
    totalCategories: 6,
    totalSubcategories: 10,
    totalTypes: 15,
    lastUpdated: "2026-03-29",
  },
};

/**
 * Get all service type IDs as flat array
 */
export function getAllServiceTypeIds(): string[] {
  return servicesCatalog.categories.flatMap((category) =>
    category.subcategories.flatMap((subcategory) =>
      subcategory.types.map((type) => type.serviceTypeId)
    )
  );
}

/**
 * Get all subcategory IDs as flat array
 */
export function getAllSubcategoryIds(): string[] {
  return servicesCatalog.categories.flatMap((category) =>
    category.subcategories.map((sub) => sub.serviceSubCategoryId)
  );
}

/**
 * Get all category IDs as flat array
 */
export function getAllCategoryIds(): string[] {
  return servicesCatalog.categories.map((category) => category.serviceCategoryId);
}

/**
 * Find service type by ID
 */
export function getServiceTypeById(id: string): ServiceType | undefined {
  for (const category of servicesCatalog.categories) {
    for (const subcategory of category.subcategories) {
      const type = subcategory.types.find((t) => t.serviceTypeId === id);
      if (type) return type;
    }
  }
  return undefined;
}

/**
 * Find subcategory by ID
 */
export function getSubcategoryById(id: string): ServiceSubcategory | undefined {
  for (const category of servicesCatalog.categories) {
    const subcategory = category.subcategories.find((s) => s.serviceSubCategoryId === id);
    if (subcategory) return subcategory;
  }
  return undefined;
}

/**
 * Find category by ID
 */
export function getCategoryById(id: string): ServiceCategory | undefined {
  return servicesCatalog.categories.find((category) => category.serviceCategoryId === id);
}

/**
 * Get full path for a service type
 */
export function getServiceTypePath(serviceTypeId: string): {
  category: ServiceCategory;
  subcategory: ServiceSubcategory;
  type: ServiceType;
} | undefined {
  for (const category of servicesCatalog.categories) {
    for (const subcategory of category.subcategories) {
      const type = subcategory.types.find((t) => t.serviceTypeId === serviceTypeId);
      if (type) {
        return { category, subcategory, type };
      }
    }
  }
  return undefined;
}

/**
 * Check if service type exists
 */
export function isValidServiceType(serviceTypeId: string): boolean {
  return getServiceTypeById(serviceTypeId) !== undefined;
}

/**
 * Check if subcategory exists
 */
export function isValidSubcategory(subcategoryId: string): boolean {
  return getSubcategoryById(subcategoryId) !== undefined;
}

/**
 * Check if category exists
 */
export function isValidCategory(categoryId: string): boolean {
  return getCategoryById(categoryId) !== undefined;
}

/**
 * Get matching order criteria for worker
 * Worker matches if they have ANY of the types in the subcategory
 */
export function getMatchingSubcategoriesForWorker(
  workerServiceIds: string[]
): string[] {
  const matchingSubcategories = new Set<string>();
  
  for (const category of servicesCatalog.categories) {
    for (const subcategory of category.subcategories) {
      const hasMatchingType = subcategory.types.some((type) =>
        workerServiceIds.includes(type.serviceTypeId)
      );
      if (hasMatchingType) {
        matchingSubcategories.add(subcategory.serviceSubCategoryId);
      }
    }
  }
  
  return Array.from(matchingSubcategories);
}

/**
 * Check if order matches worker's services
 */
export function orderMatchesWorker(
  orderSubcategoryId: string,
  orderTypeId: string | null | undefined,
  workerServiceIds: string[]
): boolean {
  // If worker has the exact service type
  if (orderTypeId && workerServiceIds.includes(orderTypeId)) {
    return true;
  }
  
  // If worker has any service type in the same subcategory
  const subcategory = getSubcategoryById(orderSubcategoryId);
  if (subcategory) {
    return subcategory.types.some((type) =>
      workerServiceIds.includes(type.serviceTypeId)
    );
  }
  
  return false;
}
