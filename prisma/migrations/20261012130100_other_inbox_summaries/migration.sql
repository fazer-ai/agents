-- The summary of a conversation in another inbox, one row per conversation, read into the turns of
-- the same contact elsewhere. Wrapped so a failure cannot leave the table without FORCE.
BEGIN;

CREATE TABLE "other_inbox_summaries" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "chatwoot_instance_id" BIGINT NOT NULL,
    "chatwoot_conversation_id" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "covered_message_id" INTEGER NOT NULL,
    "covered_fingerprint" TEXT NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "other_inbox_summaries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "other_inbox_summaries_tenant_id_chatwoot_instance_id_chatwo_key" ON "other_inbox_summaries"("tenant_id", "chatwoot_instance_id", "chatwoot_conversation_id");

ALTER TABLE "other_inbox_summaries" ADD CONSTRAINT "other_inbox_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "other_inbox_summaries" ADD CONSTRAINT "other_inbox_summaries_chatwoot_instance_id_fkey" FOREIGN KEY ("chatwoot_instance_id") REFERENCES "chatwoot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries.
ALTER TABLE "other_inbox_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "other_inbox_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "other_inbox_summaries"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "other_inbox_summaries" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
