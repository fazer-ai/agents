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
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "conversation_id" INTEGER;

-- Serves the sweep's only query: the oldest non-terminal rows. PENDING and PROCESSING are both
-- transient (in-flight deliveries plus strands), so this index stays small next to the table.
CREATE INDEX "chatwoot_webhook_deliveries_status_received_at_idx" ON "chatwoot_webhook_deliveries"("status", "received_at");


-- The INBOUND message the delivery carried, for the same reason and with the same discipline: an id,
-- never the content. Null on every event that is not a customer message, which is what lets the
-- sweep tell a row where nothing was lost from one where a customer went unanswered.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "inbound_message_id" INTEGER;
-- Serves the other half of the same contract: when a turn answers a burst it retires the ledger rows
-- of the messages that burst contained, matched by conversation and message id. That write is what
-- lets the sweep ask "did anything cover this message" of the ROW rather than inferring it from the
-- conversation's watermarks, which cannot answer a per-message question.
CREATE INDEX "chatwoot_webhook_deliveries_conversation_message_idx" ON "chatwoot_webhook_deliveries"("conversation_id", "inbound_message_id");

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
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "claimed_at" TIMESTAMP(3);


-- Every row still non-terminal at this moment is, by definition, abandoned: nothing but
-- `processChatwootDelivery` moves these, and the process that would have is long gone. They predate
-- the columns above, so the sweep could never tell whether each one carried a customer message —
-- and closing them as PROCESSED would hide real losses in exactly the list that exists to surface
-- them. Marked DEAD once, here, so they appear in it instead.
--
-- The age fence is not cosmetic: this migration runs while the PREVIOUS release is still serving.
-- A row that old release inserted seconds ago is about to be claimed by it, and closing it here
-- makes that `PENDING -> PROCESSING` CAS match nothing — the delivery returns "skipped" and a live
-- customer message is discarded by the upgrade. Thirty minutes is the same threshold the sweep uses
-- to call a row abandoned, so what this closes is exactly what the sweep would have.
--
-- A delivery genuinely in flight and older than that is being stranded by the same deploy, so DEAD
-- is the right answer for it. A younger one is left where it is: if the deploy strands it, the sweep
-- reaches it half an hour later and reads it by the rules below rather than by this blanket.
--
-- These rows land in the DEAD list WITHOUT the conversation-level log line and alert the sweep
-- writes, and that is deliberate rather than an oversight. Nothing here knows what they carried:
-- both id columns are being added by this same migration and neither is backfilled, so a line for
-- one of these could not name a conversation, a message, or even whether a customer was waiting. A
-- deploy-time burst of error-level alerts saying "some old deliveries were abandoned" would page an
-- operator with nothing to act on. They are distinguishable from everything the sweep closes later,
-- which is what an operator needs:
--
--   SELECT * FROM chatwoot_webhook_deliveries WHERE status = 'DEAD' AND conversation_id IS NULL;
-- The GUC is load-bearing, and its absence fails SILENTLY in the one direction that matters. This
-- table is tenant-scoped and carries FORCE ROW LEVEL SECURITY, which subjects even the table OWNER
-- to the tenant policy, and `MIGRATION_DATABASE_URL` is only ever documented as "superuser OR owner"
-- (docs/deploy.md). On a self-hosted Postgres the migration role is usually a real superuser and
-- this makes no difference; on managed Postgres the admin role is typically the owner WITHOUT
-- rolsuper, and there this UPDATE matches ZERO rows and reports success. The rows would then stay
-- non-terminal with both id columns null, which is exactly what the sweep reads as "carried no
-- message" — so every pre-existing loss would be closed as PROCESSED and never reported, on the
-- population most likely to contain real ones.
--
-- Plain SET, not SET LOCAL: outside a transaction SET LOCAL is a no-op with only a warning, which
-- would reproduce the very failure this line exists to prevent.
SET app.is_super_admin = 'on';

UPDATE "chatwoot_webhook_deliveries"
   SET status = 'DEAD', processed_at = now()
 WHERE status IN ('PENDING', 'PROCESSING')
   AND received_at < now() - interval '30 minutes';

RESET app.is_super_admin;
