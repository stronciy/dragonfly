UPDATE service_categories
SET name = 'Обприскування', updated_at = NOW()
WHERE id = 'spraying';

UPDATE service_categories
SET name = 'Оранка', updated_at = NOW()
WHERE id = 'plowing';

UPDATE service_categories
SET name = 'Культивація', updated_at = NOW()
WHERE id = 'cultivation';

UPDATE service_categories
SET name = 'Сівба', updated_at = NOW()
WHERE id = 'sowing';

UPDATE service_categories
SET name = 'Збирання', updated_at = NOW()
WHERE id = 'harvesting';

UPDATE service_subcategories
SET name = 'Обприскування (ЗЗР)', updated_at = NOW()
WHERE id = 'pesticide';

UPDATE service_subcategories
SET name = 'Глибока оранка', updated_at = NOW()
WHERE id = 'deep' AND category_id = 'plowing';

UPDATE service_subcategories
SET name = 'Поверхнева оранка', updated_at = NOW()
WHERE id = 'shallow' AND category_id = 'plowing';

UPDATE service_subcategories
SET name = 'Передпосівна культивація', updated_at = NOW()
WHERE id = 'pre_sowing' AND category_id = 'cultivation';

UPDATE service_subcategories
SET name = 'Зернові', updated_at = NOW()
WHERE id = 'grains' AND category_id = 'sowing';

UPDATE service_subcategories
SET name = 'Технічні культури', updated_at = NOW()
WHERE id = 'technical' AND category_id = 'sowing';

UPDATE service_subcategories
SET name = 'Комбайном', updated_at = NOW()
WHERE id = 'combine' AND category_id = 'harvesting';

UPDATE service_types
SET name = 'Обприскування — базовий тариф', updated_at = NOW()
WHERE subcategory_id = 'pesticide' AND id = 'type-a';

UPDATE service_types
SET name = 'Стандарт', updated_at = NOW()
WHERE subcategory_id = 'deep' AND id = 'standard';

UPDATE service_types
SET name = 'Підсилений', updated_at = NOW()
WHERE subcategory_id = 'deep' AND id = 'reinforced';

UPDATE service_types
SET name = 'Легкий', updated_at = NOW()
WHERE subcategory_id = 'shallow' AND id = 'light';

UPDATE service_types
SET name = 'Неглибока', updated_at = NOW()
WHERE subcategory_id = 'pre_sowing' AND id = 'shallow';

UPDATE service_types
SET name = 'Глибока', updated_at = NOW()
WHERE subcategory_id = 'pre_sowing' AND id = 'deep';

UPDATE service_types
SET name = 'Пшениця', updated_at = NOW()
WHERE subcategory_id = 'grains' AND id = 'wheat';

UPDATE service_types
SET name = 'Ячмінь', updated_at = NOW()
WHERE subcategory_id = 'grains' AND id = 'barley';

UPDATE service_types
SET name = 'Кукурудза', updated_at = NOW()
WHERE subcategory_id = 'grains' AND id = 'corn';

UPDATE service_types
SET name = 'Соняшник', updated_at = NOW()
WHERE subcategory_id = 'technical' AND id = 'sunflower';

UPDATE service_types
SET name = 'Ріпак', updated_at = NOW()
WHERE subcategory_id = 'technical' AND id = 'rapeseed';

UPDATE service_types
SET name = 'Зернові', updated_at = NOW()
WHERE subcategory_id = 'combine' AND id = 'grains';

UPDATE service_types
SET name = 'Кукурудза', updated_at = NOW()
WHERE subcategory_id = 'combine' AND id = 'corn';
