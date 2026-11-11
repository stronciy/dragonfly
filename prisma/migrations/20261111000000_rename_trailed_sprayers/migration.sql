-- Підкатегорія «Причепні» перейменовується на «Трактор+причепні» (id 3.2 не змінюється,
-- тож прив'язки виконавців і заказів лишаються чинними).
UPDATE service_subcategories
SET name = 'Трактор+причепні',
    name_ua = CASE WHEN name_ua = 'Причепні' THEN 'Трактор+причепні' ELSE name_ua END,
    updated_at = NOW()
WHERE id = '3.2' AND name = 'Причепні';
