/**
 * Services Catalog - React Native / Mobile Version
 * 
 * Copy this file to your mobile app project.
 * 
 * Usage example:
 * ```tsx
 * import { servicesCatalog, orderMatchesWorker } from './services-catalog';
 * 
 * // Display all categories for order creation
 * {servicesCatalog.categories.map(category => (
 *   <View key={category.serviceCategoryId}>
 *     <Text>{category.icon} {category.serviceCategoryName}</Text>
 *     {category.subcategories.map(subcategory => (
 *       <View key={subcategory.serviceSubCategoryId}>
 *         <Text>{subcategory.serviceSubCategoryName}</Text>
 *         {subcategory.types.map(type => (
 *           <TouchableOpacity
 *             key={type.serviceTypeId}
 *             onPress={() => handleServiceSelect({
 *               serviceCategoryId: category.serviceCategoryId,
 *               serviceSubCategoryId: subcategory.serviceSubCategoryId,
 *               serviceTypeId: type.serviceTypeId,
 *             })}
 *           >
 *             <Text>{type.serviceTypeName}</Text>
 *           </TouchableOpacity>
 *         ))}
 *       </View>
 *     ))}
 *   </View>
 * ))}
 * 
 * // Check if order matches worker services
 * const isMatch = orderMatchesWorker(
 *   order.serviceSubCategoryId,
 *   order.serviceTypeId,
 *   worker.serviceTypes // array of serviceTypeId strings
 * );
 * ```
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

export interface SelectedService {
  serviceCategoryId: string;
  serviceSubCategoryId: string;
  serviceTypeId: string;
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

// Helper functions

export function getAllServiceTypeIds(): string[] {
  return servicesCatalog.categories.flatMap((category) =>
    category.subcategories.flatMap((subcategory) =>
      subcategory.types.map((type) => type.serviceTypeId)
    )
  );
}

export function getAllSubcategoryIds(): string[] {
  return servicesCatalog.categories.flatMap((category) =>
    category.subcategories.map((sub) => sub.serviceSubCategoryId)
  );
}

export function getAllCategoryIds(): string[] {
  return servicesCatalog.categories.map((category) => category.serviceCategoryId);
}

export function getServiceTypeById(id: string): ServiceType | undefined {
  for (const category of servicesCatalog.categories) {
    for (const subcategory of category.subcategories) {
      const type = subcategory.types.find((t) => t.serviceTypeId === id);
      if (type) return type;
    }
  }
  return undefined;
}

export function getSubcategoryById(id: string): ServiceSubcategory | undefined {
  for (const category of servicesCatalog.categories) {
    const subcategory = category.subcategories.find((s) => s.serviceSubCategoryId === id);
    if (subcategory) return subcategory;
  }
  return undefined;
}

export function getCategoryById(id: string): ServiceCategory | undefined {
  return servicesCatalog.categories.find((category) => category.serviceCategoryId === id);
}

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

export function isValidServiceType(serviceTypeId: string): boolean {
  return getServiceTypeById(serviceTypeId) !== undefined;
}

export function isValidSubcategory(subcategoryId: string): boolean {
  return getSubcategoryById(subcategoryId) !== undefined;
}

export function isValidCategory(categoryId: string): boolean {
  return getCategoryById(categoryId) !== undefined;
}

/**
 * Get matching subcategories for worker based on their service types
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
 * 
 * @param orderSubcategoryId - Order's subcategory ID
 * @param orderTypeId - Order's type ID (can be null/undefined)
 * @param workerServiceIds - Array of service type IDs the worker provides
 * @returns true if worker can fulfill this order
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

/**
 * Get category icon by ID
 */
export function getCategoryIcon(categoryId: string): string | undefined {
  const category = getCategoryById(categoryId);
  return category?.icon;
}

/**
 * Format service selection for display
 */
export function formatServiceSelection(selection: SelectedService): string {
  const category = getCategoryById(selection.serviceCategoryId);
  const subcategory = getSubcategoryById(selection.serviceSubCategoryId);
  const type = getServiceTypeById(selection.serviceTypeId);
  
  const parts = [
    category?.serviceCategoryName,
    subcategory?.serviceSubCategoryName,
    type?.serviceTypeName,
  ].filter(Boolean);
  
  return parts.join(" → ");
}
