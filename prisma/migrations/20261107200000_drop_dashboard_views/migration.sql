-- The dashboard's warm-up pass is gone, and with it the table it recorded openings in. No release
-- carried that table, so this only reaches databases that ran the main branch in between.
DROP TABLE IF EXISTS "dashboard_views";
