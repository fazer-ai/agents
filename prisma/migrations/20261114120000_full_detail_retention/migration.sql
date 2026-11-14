-- A TURN'S FULL DETAIL, KEPT PER AGENT FOR N DAYS (issue #1761, docs/logs.md "Full turn detail").
--
-- Two new tables, nothing else touched: the log lines keep their cut `detail`, and the whole text of a
-- tool result or of the audited system prompt lives here, stored once per tenant by its hash and
-- pointed to by one row per log line. Both are swept by `expires_at` (the FLOWLOG_SWEEP job), each
-- with its own index, so the sweep is a range read and never a join.
--
-- Wrapped in a transaction: a failure between a CREATE TABLE and its FORCE ROW LEVEL SECURITY leaves a
-- tenant-scoped table that does not bind its owner (.claude/rules/prisma.md).
BEGIN;

CREATE TABLE "full_detail_contents" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "hash" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "chars" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "full_detail_contents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "full_detail_refs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "execution_log_id" BIGINT NOT NULL,
    "agent_id" BIGINT,
    "kind" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "clipped" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "full_detail_refs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "full_detail_contents_tenant_id_hash_key" ON "full_detail_contents"("tenant_id", "hash");
CREATE INDEX "full_detail_contents_tenant_id_expires_at_idx" ON "full_detail_contents"("tenant_id", "expires_at");
CREATE INDEX "full_detail_refs_tenant_id_expires_at_idx" ON "full_detail_refs"("tenant_id", "expires_at");
CREATE INDEX "full_detail_refs_tenant_id_execution_log_id_idx" ON "full_detail_refs"("tenant_id", "execution_log_id");
CREATE INDEX "full_detail_refs_tenant_id_agent_id_content_hash_idx" ON "full_detail_refs"("tenant_id", "agent_id", "content_hash");

ALTER TABLE "full_detail_contents" ADD CONSTRAINT "full_detail_contents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "full_detail_refs" ADD CONSTRAINT "full_detail_refs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "full_detail_contents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "full_detail_contents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "full_detail_refs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "full_detail_refs" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "full_detail_contents"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "full_detail_refs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "full_detail_contents" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "full_detail_refs" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
