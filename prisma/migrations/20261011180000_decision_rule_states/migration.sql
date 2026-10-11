-- The trigger state of the decisions engine's rules (issue #1222, docs/decisions.md "When a rule
-- acts"): one row per rule that acted and is held back, per agent and conversation. The key is the
-- rule's own content, so editing a rule leaves its old row behind for the next tick to drop.
-- Wrapped so a failure cannot leave the table without FORCE.
BEGIN;

CREATE TABLE "decision_rule_states" (
    "tenant_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "rule_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_rule_states_pkey" PRIMARY KEY ("agent_id","conversation_id","rule_key")
);

CREATE INDEX "decision_rule_states_conversation_id_idx" ON "decision_rule_states"("conversation_id");

CREATE INDEX "decision_rule_states_tenant_id_idx" ON "decision_rule_states"("tenant_id");

ALTER TABLE "decision_rule_states" ADD CONSTRAINT "decision_rule_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_rule_states" ADD CONSTRAINT "decision_rule_states_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_rule_states" ADD CONSTRAINT "decision_rule_states_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries.
ALTER TABLE "decision_rule_states" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_rule_states" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "decision_rule_states"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "decision_rule_states" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
