-- Where the occurrence monitor's own reading of each conversation stands (docs/occurrences.md,
-- "Readings"): the monitor now reads the conversations of its inboxes itself, and this is how it knows
-- which ones have a customer message it has not read. Additive: the readings, canonicals, aliases,
-- themes, members, events and rounds are left as they are.
BEGIN;

CREATE TABLE "occurrence_conversation_reads" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "read_inbound_at" TIMESTAMP(3),
    "read_at" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "failed_inbound_at" TIMESTAMP(3),

    CONSTRAINT "occurrence_conversation_reads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "occurrence_conversation_reads_conversation_id_key" ON "occurrence_conversation_reads"("conversation_id");
CREATE INDEX "occurrence_conversation_reads_tenant_id_idx" ON "occurrence_conversation_reads"("tenant_id");

ALTER TABLE "occurrence_conversation_reads" ADD CONSTRAINT "occurrence_conversation_reads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "occurrence_conversation_reads" ADD CONSTRAINT "occurrence_conversation_reads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "occurrence_conversation_reads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_conversation_reads" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "occurrence_conversation_reads"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "occurrence_conversation_reads" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
