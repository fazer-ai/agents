-- The per-conversation turn limit: one row per agent turn that reached the customer, counted over a
-- rolling hour, and the instant the limit last handed the conversation to a person, after which the
-- count starts again. Wrapped so a failure cannot leave the table without FORCE.
BEGIN;

CREATE TABLE "agent_turn_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "proactive" BOOLEAN NOT NULL DEFAULT false,
    "delivered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_turn_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "agent_turn_deliveries_conversation_id_delivered_at_idx" ON "agent_turn_deliveries"("conversation_id", "delivered_at");

CREATE INDEX "agent_turn_deliveries_tenant_id_delivered_at_idx" ON "agent_turn_deliveries"("tenant_id", "delivered_at");

ALTER TABLE "agent_turn_deliveries" ADD CONSTRAINT "agent_turn_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_turn_deliveries" ADD CONSTRAINT "agent_turn_deliveries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversations" ADD COLUMN "turn_limit_tripped_at" TIMESTAMP(3);

-- RLS: the policy pair every tenant-scoped table carries.
ALTER TABLE "agent_turn_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "agent_turn_deliveries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_turn_deliveries"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "agent_turn_deliveries" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
