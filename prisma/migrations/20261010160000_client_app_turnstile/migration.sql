-- An optional Cloudflare Turnstile challenge before a new anonymous session of an embedding app. Off,
-- with no keys, on every existing app. Additive: the previous release ignores the columns.
ALTER TABLE "client_apps" ADD COLUMN "turnstile_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "client_apps" ADD COLUMN "turnstile_site_key" TEXT;
ALTER TABLE "client_apps" ADD COLUMN "turnstile_secret" TEXT;
