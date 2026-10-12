-- The generation of the decisions engine's trigger state, per agent and conversation
-- (docs/decisions.md "When a rule acts"): every observation that reads the state takes the next
-- one, and a write to decision_rule_states applies only while the row still holds the writer's
-- own, so an older observation never changes the state a newer one read.
-- Wrapped so a failure cannot leave the table without FORCE.
BEGIN;

CREATE TABLE "decision_rule_claims" (
    "tenant_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "decision_rule_claims_pkey" PRIMARY KEY ("agent_id","conversation_id")
);

CREATE INDEX "decision_rule_claims_conversation_id_idx" ON "decision_rule_claims"("conversation_id");

CREATE INDEX "decision_rule_claims_tenant_id_idx" ON "decision_rule_claims"("tenant_id");

ALTER TABLE "decision_rule_claims" ADD CONSTRAINT "decision_rule_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_rule_claims" ADD CONSTRAINT "decision_rule_claims_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "decision_rule_claims" ADD CONSTRAINT "decision_rule_claims_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries.
ALTER TABLE "decision_rule_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "decision_rule_claims" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "decision_rule_claims"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "decision_rule_claims" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
