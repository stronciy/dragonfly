-- Migration: Convert service catalog to hierarchical IDs
-- Maps old string IDs to new numeric hierarchical IDs

-- Step 1: Create temporary mapping tables to avoid conflicts
-- We need to update in the right order due to foreign keys

-- Step 2: Update ServiceCategory IDs
-- Map: spraying=1, plowing=2, cultivation=3, sowing=4, harvesting=5, fertilizing=6
UPDATE service_categories SET id = '1' WHERE id = 'spraying';
UPDATE service_categories SET id = '2' WHERE id = 'plowing';
UPDATE service_categories SET id = '3' WHERE id = 'cultivation';
UPDATE service_categories SET id = '4' WHERE id = 'sowing';
UPDATE service_categories SET id = '5' WHERE id = 'harvesting';
UPDATE service_categories SET id = '6' WHERE id = 'fertilizing';

-- Step 3: Update ServiceSubcategory IDs and category_id references
-- Category 2 (plowing): deep=2.1, shallow=2.2
UPDATE service_subcategories SET id = '2.1', category_id = '2' WHERE id = 'deep' AND category_id = '2';
UPDATE service_subcategories SET id = '2.2', category_id = '2' WHERE id = 'shallow' AND category_id = '2';

-- Category 3 (cultivation): pre_sowing=3.1
UPDATE service_subcategories SET id = '3.1', category_id = '3' WHERE id = 'pre_sowing' AND category_id = '3';

-- Category 4 (sowing): grains=4.1, technical=4.2
UPDATE service_subcategories SET id = '4.1', category_id = '4' WHERE id = 'grains' AND category_id = '4';
UPDATE service_subcategories SET id = '4.2', category_id = '4' WHERE id = 'technical' AND category_id = '4';

-- Category 5 (harvesting): combine=5.1
UPDATE service_subcategories SET id = '5.1', category_id = '5' WHERE id = 'combine' AND category_id = '5';

-- Category 1 (spraying): pesticide=1.1
UPDATE service_subcategories SET id = '1.1', category_id = '1' WHERE id = 'pesticide' AND category_id = '1';

-- Step 4: Update ServiceType IDs and subcategory_id references
-- Subcategory 2.1 (deep plowing): standard=2.1.1, reinforced=2.1.2
UPDATE service_types SET id = '2.1.1', subcategory_id = '2.1' WHERE id = 'standard' AND subcategory_id = '2.1';
UPDATE service_types SET id = '2.1.2', subcategory_id = '2.1' WHERE id = 'reinforced' AND subcategory_id = '2.1';

-- Subcategory 2.2 (shallow plowing): light=2.2.1
UPDATE service_types SET id = '2.2.1', subcategory_id = '2.2' WHERE id = 'light' AND subcategory_id = '2.2';

-- Subcategory 3.1 (pre_sowing): shallow=3.1.1, deep=3.1.2
UPDATE service_types SET id = '3.1.1', subcategory_id = '3.1' WHERE id = 'shallow' AND subcategory_id = '3.1';
UPDATE service_types SET id = '3.1.2', subcategory_id = '3.1' WHERE id = 'deep' AND subcategory_id = '3.1';

-- Subcategory 4.1 (grains): wheat=4.1.1, barley=4.1.2, corn=4.1.3
UPDATE service_types SET id = '4.1.1', subcategory_id = '4.1' WHERE id = 'wheat' AND subcategory_id = '4.1';
UPDATE service_types SET id = '4.1.2', subcategory_id = '4.1' WHERE id = 'barley' AND subcategory_id = '4.1';
UPDATE service_types SET id = '4.1.3', subcategory_id = '4.1' WHERE id = 'corn' AND subcategory_id = '4.1';

-- Subcategory 4.2 (technical): sunflower=4.2.1, rapeseed=4.2.2
UPDATE service_types SET id = '4.2.1', subcategory_id = '4.2' WHERE id = 'sunflower' AND subcategory_id = '4.2';
UPDATE service_types SET id = '4.2.2', subcategory_id = '4.2' WHERE id = 'rapeseed' AND subcategory_id = '4.2';

-- Subcategory 5.1 (combine): grains=5.1.1, corn=5.1.2
UPDATE service_types SET id = '5.1.1', subcategory_id = '5.1' WHERE id = 'grains' AND subcategory_id = '5.1';
UPDATE service_types SET id = '5.1.2', subcategory_id = '5.1' WHERE id = 'corn' AND subcategory_id = '5.1';

-- Subcategory 1.1 (pesticide): type-a=1.1.1
UPDATE service_types SET id = '1.1.1', subcategory_id = '1.1' WHERE id = 'type-a' AND subcategory_id = '1.1';
