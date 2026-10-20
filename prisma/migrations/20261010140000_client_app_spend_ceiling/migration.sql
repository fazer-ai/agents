-- An embedding app's own monthly spend ceiling, in US cents. NULL (no ceiling) on every existing app.
-- Additive: the previous release ignores the column.
ALTER TABLE "client_apps" ADD COLUMN "monthly_ceiling_cents" INTEGER;
