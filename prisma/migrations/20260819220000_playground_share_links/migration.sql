-- CreateTable: PlaygroundShareLink — operator-minted, no-login public link to chat with an agent
-- in an isolated playground thread. Only the SHA-256 hash of the token is stored.
CREATE TABLE "playground_share_links" (
    "id"            BIGSERIAL    NOT NULL,
    "tenant_id"     BIGINT       NOT NULL,
    "agent_id"      BIGINT       NOT NULL,
    "token_hash"    TEXT         NOT NULL,
    "message_count" INTEGER      NOT NULL DEFAULT 0,
    "max_messages"  INTEGER      NOT NULL DEFAULT 60,
    "expires_at"    TIMESTAMP(3) NOT NULL,
    "revoked_at"    TIMESTAMP(3),
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "playground_share_links_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "playground_share_links_token_hash_key" ON "playground_share_links"("token_hash");
CREATE INDEX "playground_share_links_tenant_id_idx" ON "playground_share_links"("tenant_id");
CREATE INDEX "playground_share_links_agent_id_idx" ON "playground_share_links"("agent_id");

-- FKs
ALTER TABLE "playground_share_links"
  ADD CONSTRAINT "playground_share_links_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "playground_share_links"
  ADD CONSTRAINT "playground_share_links_agent_id_fkey"
  FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant-isolation pattern as all other tenant-scoped tables. Uses 'on' (not 'true')
-- for is_super_admin, matching asSuperAdminOn's set_config call. The public (no-login) route that
-- consumes a token does its lookup via asSuperAdminOn (it has no tenant context yet — the token
-- itself resolves the tenant), same shape as Chatwoot's resolveBotByRouteToken.
ALTER TABLE "playground_share_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "playground_share_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "playground_share_links"
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::BIGINT
    OR current_setting('app.is_super_admin', true) = 'on'
  );

-- No GRANT statements here: scripts/db-bootstrap.ts's ALTER DEFAULT PRIVILEGES already covers
-- every table created after it runs — see .claude/rules/prisma.md.
