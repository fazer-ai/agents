-- A knowledge base can mirror a help center portal (issue #794): one source per base, and the link
-- between each upstream item and its document held by the platform, on the document itself.
--
-- Wrapped in a transaction for the same reason as 20260917180000: a failure between the CREATE
-- TABLE and the FORCE ROW LEVEL SECURITY below would leave a tenant-scoped table that does not bind
-- its own owner. Nothing here builds an index concurrently.
BEGIN;

ALTER TABLE "knowledge_documents" ADD COLUMN "external_id" TEXT;
ALTER TABLE "knowledge_documents" ADD COLUMN "source_url" TEXT;

-- Every existing document has a NULL external id, and NULLs never collide, so this builds over
-- today's rows without a conflict and without a backfill.
CREATE UNIQUE INDEX "knowledge_documents_knowledge_base_id_external_id_key"
  ON "knowledge_documents"("knowledge_base_id", "external_id");

CREATE TABLE "knowledge_sources" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "knowledge_base_id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "interval_minutes" INTEGER NOT NULL DEFAULT 10,
    "last_sync_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_sources_knowledge_base_id_key" ON "knowledge_sources"("knowledge_base_id");
CREATE INDEX "knowledge_sources_tenant_id_idx" ON "knowledge_sources"("tenant_id");

ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "knowledge_sources" ADD CONSTRAINT "knowledge_sources_knowledge_base_id_fkey"
  FOREIGN KEY ("knowledge_base_id") REFERENCES "knowledge_bases"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (see 20260917180000).
ALTER TABLE "knowledge_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_sources" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "knowledge_sources"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "knowledge_sources" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
