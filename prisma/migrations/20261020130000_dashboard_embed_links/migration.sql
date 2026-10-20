-- Embed links (docs/dashboards.md, "Embed links"): a link that opens one dashboard inside another
-- app's iframe, signed in by the token in its fragment, stored as a hash. Present in every edition, so
-- the schema never diverges; only the code that reads it is Pro. Wrapped so a failure cannot leave the
-- table without FORCE.
BEGIN;

CREATE TABLE "dashboard_embed_links" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "dashboard_id" BIGINT NOT NULL,
    "label" TEXT NOT NULL,
    "origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "token_hash" TEXT NOT NULL,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dashboard_embed_links_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dashboard_embed_links_token_hash_key" ON "dashboard_embed_links"("token_hash");
CREATE INDEX "dashboard_embed_links_tenant_id_dashboard_id_idx" ON "dashboard_embed_links"("tenant_id", "dashboard_id");

ALTER TABLE "dashboard_embed_links" ADD CONSTRAINT "dashboard_embed_links_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "dashboard_embed_links" ADD CONSTRAINT "dashboard_embed_links_dashboard_id_fkey" FOREIGN KEY ("dashboard_id") REFERENCES "dashboards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries.
ALTER TABLE "dashboard_embed_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dashboard_embed_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dashboard_embed_links"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "dashboard_embed_links" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;

COMMIT;
