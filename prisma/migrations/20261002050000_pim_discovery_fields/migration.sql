-- PIM-lite product fields (category/attributes/tag provenance), discovery
-- provenance on leads (source_id + external_id dedupe key), and the
-- lead_sources table for configured scanners. lead_sources is tenant-scoped,
-- so it gets ENABLE/FORCE RLS plus the policy pair in the same transaction.
BEGIN;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "external_id" TEXT,
ADD COLUMN     "source_id" BIGINT;

-- AlterTable
ALTER TABLE "merchant_products" ADD COLUMN     "attributes" JSONB,
ADD COLUMN     "category" TEXT,
ADD COLUMN     "tag_source" TEXT,
ADD COLUMN     "tagged_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "lead_sources" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "interval_min" INTEGER NOT NULL DEFAULT 60,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_run_at" TIMESTAMP(3),
    "last_status" TEXT,
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_sources_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lead_sources_tenant_id_idx" ON "lead_sources"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_tenant_id_platform_external_id_key" ON "leads"("tenant_id", "platform", "external_id");

-- CreateIndex
CREATE INDEX "merchant_products_tenant_id_category_idx" ON "merchant_products"("tenant_id", "category");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "lead_sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_sources" ADD CONSTRAINT "lead_sources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (see 20260917180000).
ALTER TABLE "lead_sources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_sources" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lead_sources"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "lead_sources" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
