-- Who a thread outside Chatwoot belongs to. The client channel minted its thread ids and honored any
-- well-formed one, so the only thing between two users of the same host was the host's own HMAC on
-- the id. These two tables let the agents check ownership itself: the person as the host names them,
-- and the thread bound to that person and to the host's scope (docs/client-channel.md).
--
-- Wrapped in a transaction so a failure between a CREATE TABLE and its FORCE ROW LEVEL SECURITY
-- cannot leave a tenant-scoped table that does not bind its owner (.claude/rules/prisma.md).
BEGIN;
-- CreateTable
CREATE TABLE "external_users" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "channel" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT,
    "contact_id" BIGINT,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detached_threads" (
    "thread_id" TEXT NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "external_user_id" BIGINT,
    "scope" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_turn_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detached_threads_pkey" PRIMARY KEY ("thread_id")
);

-- CreateIndex
CREATE INDEX "external_users_contact_id_idx" ON "external_users"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_users_tenant_id_channel_external_id_key" ON "external_users"("tenant_id", "channel", "external_id");

-- CreateIndex
CREATE INDEX "detached_threads_tenant_id_idx" ON "detached_threads"("tenant_id");

-- CreateIndex
CREATE INDEX "detached_threads_agent_id_idx" ON "detached_threads"("agent_id");

-- CreateIndex
CREATE INDEX "detached_threads_external_user_id_idx" ON "detached_threads"("external_user_id");

-- AddForeignKey
ALTER TABLE "external_users" ADD CONSTRAINT "external_users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_users" ADD CONSTRAINT "external_users_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detached_threads" ADD CONSTRAINT "detached_threads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detached_threads" ADD CONSTRAINT "detached_threads_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detached_threads" ADD CONSTRAINT "detached_threads_external_user_id_fkey" FOREIGN KEY ("external_user_id") REFERENCES "external_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- RLS: the policy pair every tenant-scoped table carries (tests/lib/rls-policy-shape.test.ts).
ALTER TABLE "external_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "external_users" FORCE ROW LEVEL SECURITY;
ALTER TABLE "detached_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "detached_threads" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "external_users"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "detached_threads"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "external_users" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "detached_threads" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

-- NO BACKFILL: client threads minted before this have no owner on record and stop resolving, which
-- is the point. The channel is not released yet, so no host holds one.
COMMIT;
