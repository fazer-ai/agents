-- Voice agents: an agent's kind, and the voice agent that answers an inbox's calls.
ALTER TABLE "agents" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'text';
ALTER TABLE "agents" ADD CONSTRAINT "agents_kind_check" CHECK ("kind" IN ('text', 'voice'));

ALTER TABLE "inboxes" ADD COLUMN "voice_agent_id" BIGINT;
ALTER TABLE "inboxes" ADD COLUMN "voice_route_token" TEXT;
ALTER TABLE "inboxes" ADD COLUMN "voice_route_token_hash" TEXT;
CREATE UNIQUE INDEX "inboxes_voice_route_token_hash_key" ON "inboxes"("voice_route_token_hash");
