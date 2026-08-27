-- A positive contact-authorization verdict, kept so the next message does not have to ask for it
-- again (issue #189). Written only under `contactAuth.mode = "once"`, and only for an ALLOW.
--
-- Nothing here identifies anyone: the two hashes are what let a grant expire on its own terms (the
-- mirrored identity moving under it, or the operator changing endpoint / credential / unlock /
-- TTL), and `context` is the endpoint's own bounded bag of facts, so the reused turns carry the
-- same prompt block the first one did instead of losing it halfway through a conversation.

-- CreateTable
CREATE TABLE "contact_auth_grants" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "contact_id" BIGINT NOT NULL,
    "identity_hash" TEXT NOT NULL,
    "policy_hash" TEXT NOT NULL,
    "context" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_auth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One grant per (tenant, agent, contact), which is also the only lookup: the read is by that key
-- and nothing scans by expiry, because a grant is evaluated when its contact writes and replaced in
-- place when it does not hold. No bare `(tenant_id)` index beside it — this one already serves the
-- prefix (see tests/prisma/tenant-index-redundancy.test.ts).
CREATE UNIQUE INDEX "contact_auth_grants_tenant_id_agent_id_contact_id_key" ON "contact_auth_grants"("tenant_id", "agent_id", "contact_id");

-- CreateIndex
-- Postgres does not index a foreign key on its own, and both of the cascades below probe this table
-- by a column the unique index above cannot serve (it leads with tenant_id): deleting an agent, and
-- the contact cleanup that runs when a Chatwoot deployment is disconnected. Without these the
-- cascade falls back to a sequential scan per deleted row.
CREATE INDEX "contact_auth_grants_agent_id_idx" ON "contact_auth_grants"("agent_id");

-- CreateIndex
CREATE INDEX "contact_auth_grants_contact_id_idx" ON "contact_auth_grants"("contact_id");

-- AddForeignKey
ALTER TABLE "contact_auth_grants" ADD CONSTRAINT "contact_auth_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_auth_grants" ADD CONSTRAINT "contact_auth_grants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- The contact is what a grant is ABOUT, so a contact that goes away takes its grants with it: the
-- collision cleanup that unlinks and clears a contact (docs/contact-auth.md) must not leave a
-- verdict behind about an identity the row no longer holds.
ALTER TABLE "contact_auth_grants" ADD CONSTRAINT "contact_auth_grants_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant fence every tenant-scoped table carries (see 20260727000000_init).
ALTER TABLE "contact_auth_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_auth_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "contact_auth_grants"
  USING (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );
