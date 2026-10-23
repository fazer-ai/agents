-- The round's count of what was read in its window filters by tenant, field and `last_read_at`
-- (docs/occurrences.md, "Rounds"). The table is new and empty until a monitor is switched on.
BEGIN;

CREATE INDEX "conversation_readings_tenant_id_field_last_read_at_idx" ON "conversation_readings"("tenant_id", "field", "last_read_at");

COMMIT;
