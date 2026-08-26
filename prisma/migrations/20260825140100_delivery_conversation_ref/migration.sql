-- What the stranded-delivery sweep needs from a delivery, and nothing more (issue #228).
--
-- The sweep REPORTS a delivery that a process death abandoned; it does not answer the customer
-- (issue #295 carries that half and why). So what it needs is the delivery's identity, never the
-- event body: no ciphertext column, no retention window, and no second copy of a customer's message
-- at rest.
--
-- Nullable with no backfill. An event that names no conversation leaves it null, and so does every
-- row written before this migration — the sweep files those without a conversation rather than
-- guessing.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN IF NOT EXISTS "conversation_id" INTEGER;

-- Serves the sweep's only query, and it is PARTIAL and TENANT-LEADING for two reasons the table
-- makes unavoidable.
--
-- Partial, because nothing prunes this ledger. PENDING and PROCESSING are transient — in-flight
-- deliveries plus strands — while PROCESSED and DEAD accumulate for the life of the install, so a
-- full index over `status` would carry every delivery the system has ever handled, forever, and pay
-- for it on every insert. Restricted to the two states the sweep asks about, it stays the size of
-- what is actually in flight.
--
-- Tenant-leading, because the sweep is per-tenant: one job per tenant, each asking only about its
-- own rows. Led by `status`, every tenant's pass walks the whole fleet's non-terminal range and lets
-- RLS discard the rest afterwards.
--
-- Prisma cannot express a partial index, so this one is declared here and NOT in schema.prisma —
-- the same arrangement the `agent_tool_selections` uniques use.
-- Every statement in this file is IDEMPOTENT, and that is forced by the same property that lets the
-- indexes be concurrent: `prisma migrate deploy` does not wrap this migration in a transaction, so a
-- concurrent build that is cancelled or fails leaves the three columns above already added. Marked
-- rolled back and run again, a bare `ADD COLUMN` would abort on the first one and the DROPs below
-- would never be reached — the recovery path would be blocked by the half of the file that had
-- already succeeded.
--
-- CONCURRENTLY, and this is the one thing in this file that is about the UPGRADE rather than about
-- the sweep. A plain CREATE INDEX holds a SHARE lock for the whole build, which blocks INSERT on the
-- table it is indexing. This migration runs while the previous release is still acking webhooks, and
-- that release writes the ledger row AFTER the 200 has gone out, with a bounded retry: an index
-- build long enough to outlast those retries turns acked events into rows that were never written,
-- which is the very loss this ledger exists to make visible. Nothing prunes this table, so the build
-- time is bounded by the install's whole history and cannot be assumed short.
--
-- Measured: `prisma migrate deploy` in this repo does NOT wrap a migration in a transaction, so
-- Postgres accepts CONCURRENTLY here — applied to a scratch database through the real command, both
-- indexes came out `indisvalid`. The DROP above each one is what makes the file re-runnable: a
-- concurrent build that fails leaves an INVALID index behind, which is never used for a query and is
-- still maintained on every write, and a bare re-run would collide with the name.
DROP INDEX IF EXISTS "chatwoot_webhook_deliveries_sweep_idx";
CREATE INDEX CONCURRENTLY "chatwoot_webhook_deliveries_sweep_idx"
    ON "chatwoot_webhook_deliveries"("tenant_id", "received_at")
 WHERE status IN ('PENDING', 'PROCESSING');


-- The INBOUND message the delivery carried, for the same reason and with the same discipline: an id,
-- never the content. Null on every event that is not a customer message, which is what lets the
-- sweep tell a row where nothing was lost from one where a customer went unanswered.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN IF NOT EXISTS "inbound_message_id" INTEGER;
-- Serves the other half of the same contract: when a turn answers a burst it retires the ledger rows
-- of the messages that burst contained. ACCOUNT FIRST, because that is how the write is keyed —
-- display ids and message ids are numbered per Chatwoot account, so a conversation id alone matches
-- rows on every account a tenant has connected. That write is what lets the sweep ask "did anything
-- cover this message" of the ROW rather than inferring it from the conversation's watermarks, which
-- cannot answer a per-message question.
-- NAMED, and short. Prisma's implicit name for this `@@index` is 87 bytes; Postgres truncates an
-- identifier to 63 and keeps the FIRST 63, while Prisma truncates so the `_idx` suffix survives. The
-- two disagree, so an implicit name here creates an index whose name does not match the schema and
-- every later `migrate dev` reports drift. One explicit name, in both places.
DROP INDEX IF EXISTS "chatwoot_webhook_deliveries_retire_idx";
CREATE INDEX CONCURRENTLY "chatwoot_webhook_deliveries_retire_idx"
    ON "chatwoot_webhook_deliveries"("chatwoot_instance_id", "conversation_id", "inbound_message_id");

-- When the CURRENT attempt claimed the row, stamped by the tx1 CAS `PENDING -> PROCESSING`.
--
-- The staleness clock has to be per-ATTEMPT, not per-receipt. A redelivery is deliberately allowed
-- to claim a row left stranded on PENDING (`recordAndProcessChatwootDelivery` sends both branches on
-- to the CAS, because the row existing is not the same as the work having been done), and that claim
-- can land long after the original receipt. Measured from `received_at`, the live attempt looks
-- abandoned the instant it starts, and the sweep would mark a row DEAD — and page an operator about
-- a lost message — while the process answering it is still running.
--
-- Null on a row never claimed, where receipt is the only clock there is and the right one.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN IF NOT EXISTS "claimed_at" TIMESTAMP(3);


-- NO BACKFILL, and that is a decision this file used to make the other way.
--
-- Every row still non-terminal when this runs is abandoned by definition, and an earlier version
-- closed them here: they predated both id columns, so the sweep could not tell whether each carried
-- a customer message. That is no longer true. `classifyStrandedDelivery` asks the EVENT NAME first,
-- and `event` is a column every build has always written — so the sweep reads a legacy row exactly
-- as well as this statement could, and better in the two ways that matter.
--
-- It can see `claimed_at`. This migration cannot: a legacy `PENDING` row whose `received_at` is
-- hours old may have been REDELIVERED seconds ago and be one instant from its `PENDING ->
-- PROCESSING` CAS. Closed here, that CAS matches nothing, the delivery returns "skipped", and the
-- upgrade itself discards a live customer message that Chatwoot will never send again. An age fence
-- does not save it, because the receipt is old and only the claim says otherwise. The sweep dates
-- the ATTEMPT, sees the fresh claim, and leaves it alone.
--
-- And it writes the LINE. A row this statement marked DEAD got no conversation-level line and no
-- alert, because nothing here knows what it carried; the sweep files one, with the delivery's event,
-- the state it stranded on, and whether the mirror knows the conversation.
--
-- The cost is that the pre-existing backlog stays non-terminal for up to the staleness window plus
-- one sweep interval instead of being closed at deploy time. That window is the same one every
-- stranded row already waits out, and a row waiting in it is a row a redelivery can still rescue.
