-- The widget's earlier conversations (issue #298): each client thread is named by its first message
-- and keeps what its owner was shown, so a conversation reopens with its transcript on any device.
--
-- Wrapped in a transaction on purpose: a failure between the CREATE TABLE and the FORCE ROW LEVEL
-- SECURITY below would leave a tenant-scoped table that does not bind its own owner. See
-- .claude/rules/prisma.md; there is no CONCURRENTLY here.
BEGIN;

-- The first message of a client thread, cut short, which names it in the list. Nullable: threads
-- from before have none and are listed by their date.
ALTER TABLE "detached_threads" ADD COLUMN "title" TEXT;

-- Whether the thread's messages are all in `client_thread_messages`: false for every thread alive
-- now, which began before the table and opens saying its earlier messages were not kept. The writer
-- that records sets it true when it mints a thread; the default stays false, so a thread a previous
-- container mints during a rolling deploy, which records nothing, says so too.
ALTER TABLE "detached_threads" ADD COLUMN "recorded" BOOLEAN NOT NULL DEFAULT false;

-- What the thread's owner was shown, in order: their message as sent, and the reply as delivered
-- (after the output screening and the external check, so a refusal is the refusal). Read back only
-- by the owner, through the same rule as the list; the model's own history stays in the checkpoint.
CREATE TABLE "client_thread_messages" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    -- A user's message that was spoken, shown with its mark beside the transcription.
    "voice" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_thread_messages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "client_thread_messages_role_check" CHECK ("role" IN ('user', 'agent'))
);

-- CreateIndex
-- The one read: a thread's messages from the newest back.
CREATE INDEX "client_thread_messages_thread_id_id_idx" ON "client_thread_messages"("thread_id", "id");

-- CreateIndex
CREATE INDEX "client_thread_messages_tenant_id_idx" ON "client_thread_messages"("tenant_id");

-- AddForeignKey
ALTER TABLE "client_thread_messages" ADD CONSTRAINT "client_thread_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Gone with its thread, whatever deletes it: the anonymous expiry, an agent's delete (whose threads
-- cascade off it) and a client app's or tenant's teardown.
ALTER TABLE "client_thread_messages" ADD CONSTRAINT "client_thread_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "detached_threads"("thread_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the POLICY PAIR, as in 20260917180000_reply_claims_per_message.
ALTER TABLE "client_thread_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "client_thread_messages" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "client_thread_messages"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "client_thread_messages" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
