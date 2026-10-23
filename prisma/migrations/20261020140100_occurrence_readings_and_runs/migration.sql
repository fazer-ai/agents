-- What an observer reads off each conversation for the occurrence monitor, and the monitor's rounds
-- (docs/occurrences.md). Both empty until an account switches the monitor on.
BEGIN;

CREATE TABLE "conversation_readings" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "field" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "agent_id" BIGINT,
    "first_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_readings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "conversation_readings_conversation_id_field_key" ON "conversation_readings"("conversation_id", "field");
CREATE INDEX "conversation_readings_tenant_id_field_first_read_at_idx" ON "conversation_readings"("tenant_id", "field", "first_read_at");

ALTER TABLE "conversation_readings" ADD CONSTRAINT "conversation_readings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "conversation_readings" ADD CONSTRAINT "conversation_readings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "occurrence_runs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'running',
    "readings" INTEGER NOT NULL DEFAULT 0,
    "model_calls" INTEGER NOT NULL DEFAULT 0,
    "cost_usd" DECIMAL(14,6),
    "detail" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "occurrence_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "occurrence_runs_tenant_id_started_at_idx" ON "occurrence_runs"("tenant_id", "started_at");

ALTER TABLE "occurrence_runs" ADD CONSTRAINT "occurrence_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "conversation_readings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversation_readings" FORCE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "occurrence_runs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "conversation_readings"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "occurrence_runs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "conversation_readings" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "occurrence_runs" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
