-- Merchant MVP vertical slice: catalog, leads, lead-product matches, orders. Every table is
-- tenant-scoped, so each gets ENABLE/FORCE ROW LEVEL SECURITY plus the policy pair
-- (tenant_isolation + fleet_super_admin) in the same transaction that creates it: a failure
-- between CREATE TABLE and FORCE would leave a table that does not bind its own owner.
BEGIN;

-- CreateEnum
CREATE TYPE "MerchantLeadStatus" AS ENUM ('NEW', 'CONTACTED', 'QUALIFIED', 'CONVERTED', 'DEAD');

-- CreateEnum
CREATE TYPE "MerchantOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PAID', 'CANCELLED');

-- CreateTable
CREATE TABLE "merchant_products" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DECIMAL(15,0) NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "image_url" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "platform" TEXT NOT NULL,
    "author_name" TEXT NOT NULL,
    "author_handle" TEXT,
    "text" TEXT NOT NULL,
    "source_url" TEXT,
    "group_name" TEXT,
    "score" INTEGER NOT NULL DEFAULT 0,
    "status" "MerchantLeadStatus" NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_product_matches" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "lead_id" BIGINT NOT NULL,
    "product_id" BIGINT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lead_product_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_orders" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "lead_id" BIGINT,
    "contact_name" TEXT,
    "contact_phone" TEXT,
    "contact_address" TEXT,
    "status" "MerchantOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "total_amount" DECIMAL(15,0) NOT NULL DEFAULT 0,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "merchant_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "merchant_order_items" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "order_id" BIGINT NOT NULL,
    "product_id" BIGINT,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unit_price" DECIMAL(15,0) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "merchant_order_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "merchant_products_tenant_id_idx" ON "merchant_products"("tenant_id");

-- CreateIndex
CREATE INDEX "leads_tenant_id_created_at_idx" ON "leads"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "leads_tenant_id_status_idx" ON "leads"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "lead_product_matches_tenant_id_lead_id_idx" ON "lead_product_matches"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "lead_product_matches_product_id_idx" ON "lead_product_matches"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "lead_product_matches_lead_id_product_id_key" ON "lead_product_matches"("lead_id", "product_id");

-- CreateIndex
CREATE INDEX "merchant_orders_tenant_id_created_at_idx" ON "merchant_orders"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "merchant_orders_lead_id_idx" ON "merchant_orders"("lead_id");

-- CreateIndex
CREATE INDEX "merchant_order_items_tenant_id_order_id_idx" ON "merchant_order_items"("tenant_id", "order_id");

-- CreateIndex
CREATE INDEX "merchant_order_items_product_id_idx" ON "merchant_order_items"("product_id");

-- AddForeignKey
ALTER TABLE "merchant_products" ADD CONSTRAINT "merchant_products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_product_matches" ADD CONSTRAINT "lead_product_matches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_product_matches" ADD CONSTRAINT "lead_product_matches_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_product_matches" ADD CONSTRAINT "lead_product_matches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "merchant_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_orders" ADD CONSTRAINT "merchant_orders_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_order_items" ADD CONSTRAINT "merchant_order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_order_items" ADD CONSTRAINT "merchant_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "merchant_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "merchant_order_items" ADD CONSTRAINT "merchant_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "merchant_products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (see 20260917180000).
ALTER TABLE "merchant_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_products" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "merchant_products"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "leads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "leads" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "leads"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "lead_product_matches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_product_matches" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "lead_product_matches"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "merchant_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_orders" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "merchant_orders"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "merchant_order_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "merchant_order_items" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "merchant_order_items"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "merchant_products" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "leads" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "lead_product_matches" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "merchant_orders" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "merchant_order_items" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
