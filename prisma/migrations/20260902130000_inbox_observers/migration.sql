-- An agent watching an inbox (issue #476): its bot is attached to the inbox as an OBSERVER on the
-- fork (fazer-ai/chatwoot#453), so it receives every event on its own route and never owns a
-- conversation. The responder stays `inboxes.agent_id`.

-- CreateTable
CREATE TABLE "inbox_observers" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "inbox_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inbox_observers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- ONE row per (tenant, inbox): an inbox has at most one watcher, because the graph's memory thread is
-- keyed by contact-inbox and not by agent, so a second one would write the same thread. Tenant-led so
-- it also serves the RLS prefix; no bare `(tenant_id)` index beside it
-- (see tests/prisma/tenant-index-redundancy.test.ts).
CREATE UNIQUE INDEX "inbox_observers_tenant_id_inbox_id_key" ON "inbox_observers"("tenant_id", "inbox_id");

-- CreateIndex
-- The two cascades below probe by a column the unique index cannot serve on its own.
CREATE INDEX "inbox_observers_inbox_id_idx" ON "inbox_observers"("inbox_id");

-- CreateIndex
CREATE INDEX "inbox_observers_agent_id_idx" ON "inbox_observers"("agent_id");

-- AddForeignKey
ALTER TABLE "inbox_observers" ADD CONSTRAINT "inbox_observers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_observers" ADD CONSTRAINT "inbox_observers_inbox_id_fkey" FOREIGN KEY ("inbox_id") REFERENCES "inboxes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbox_observers" ADD CONSTRAINT "inbox_observers_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the split pair every tenant-scoped table carries since
-- 20260827000000_rls_split_tenant_and_fleet_policies — the tenant predicate alone, at PUBLIC, so the
-- planner can turn it into an index condition, and the cross-tenant path as the fleet role. The role
-- exists: that migration creates it. GRANTs stay with scripts/db-bootstrap (.claude/rules/prisma.md).
ALTER TABLE "inbox_observers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "inbox_observers" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "inbox_observers"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "inbox_observers" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
