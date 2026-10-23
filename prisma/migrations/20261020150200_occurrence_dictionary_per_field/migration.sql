-- The canonical dictionary belongs to the subject field it was decided for, so switching the subject
-- field starts a new one instead of fitting another field's values with it; and a round says how many
-- of its calls had no price (docs/occurrences.md). The tables are new and empty until a monitor runs.
BEGIN;

ALTER TABLE "occurrence_canonicals" ADD COLUMN "field" TEXT NOT NULL DEFAULT '';
DROP INDEX "occurrence_canonicals_tenant_id_name_key";
CREATE UNIQUE INDEX "occurrence_canonicals_tenant_id_field_name_key" ON "occurrence_canonicals"("tenant_id", "field", "name");

ALTER TABLE "occurrence_aliases" ADD COLUMN "field" TEXT NOT NULL DEFAULT '';
DROP INDEX "occurrence_aliases_tenant_id_raw_key";
CREATE UNIQUE INDEX "occurrence_aliases_tenant_id_field_raw_key" ON "occurrence_aliases"("tenant_id", "field", "raw");

ALTER TABLE "occurrence_runs" ADD COLUMN "unpriced_calls" INTEGER NOT NULL DEFAULT 0;

COMMIT;
