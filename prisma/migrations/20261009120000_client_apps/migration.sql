-- The web application that embeds an agent through the client channel's SDK, and the keys its server
-- signs its users' JWTs with (docs/client-channel.md, "Embedding with the SDK").
--
-- Wrapped in a transaction so a failure between a CREATE TABLE and its FORCE ROW LEVEL SECURITY
-- cannot leave a tenant-scoped table that does not bind its owner (.claude/rules/prisma.md).
BEGIN;
-- CreateTable
CREATE TABLE "client_apps" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "public_id" TEXT NOT NULL,
    "allowed_origins" TEXT[],
    "anonymous_enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_apps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_app_secrets" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "app_id" BIGINT NOT NULL,
    "kid" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "client_app_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_apps_public_id_key" ON "client_apps"("public_id");

-- CreateIndex
CREATE INDEX "client_apps_tenant_id_idx" ON "client_apps"("tenant_id");

-- CreateIndex
CREATE INDEX "client_apps_agent_id_idx" ON "client_apps"("agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "client_app_secrets_kid_key" ON "client_app_secrets"("kid");

-- CreateIndex
CREATE INDEX "client_app_secrets_tenant_id_idx" ON "client_app_secrets"("tenant_id");

-- CreateIndex
CREATE INDEX "client_app_secrets_app_id_idx" ON "client_app_secrets"("app_id");

-- AddForeignKey
ALTER TABLE "client_apps" ADD CONSTRAINT "client_apps_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_apps" ADD CONSTRAINT "client_apps_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_app_secrets" ADD CONSTRAINT "client_app_secrets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_app_secrets" ADD CONSTRAINT "client_app_secrets_app_id_fkey" FOREIGN KEY ("app_id") REFERENCES "client_apps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (tests/lib/rls-policy-shape.test.ts).
ALTER TABLE "client_apps" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_apps" FORCE ROW LEVEL SECURITY;
ALTER TABLE "client_app_secrets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_app_secrets" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "client_apps"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "client_app_secrets"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "client_apps" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "client_app_secrets" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;
COMMIT;
