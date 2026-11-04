-- The two optional addresses of a Chatwoot connection: the base this Chatwoot
-- calls the agents on, and the address people open it on. Nullable, so every existing row keeps
-- today's behavior (PUBLIC_URL and base_url).
ALTER TABLE "chatwoot_deployments" ADD COLUMN "webhook_base_url" TEXT;
ALTER TABLE "chatwoot_deployments" ADD COLUMN "public_url" TEXT;
