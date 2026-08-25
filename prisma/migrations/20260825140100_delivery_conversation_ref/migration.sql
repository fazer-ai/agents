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
CREATE INDEX "chatwoot_webhook_deliveries_sweep_idx"
    ON "chatwoot_webhook_deliveries"("tenant_id", "received_at")
 WHERE status IN ('PENDING', 'PROCESSING');


-- The INBOUND message the delivery carried, for the same reason and with the same discipline: an id,
-- never the content. Null on every event that is not a customer message, which is what lets the
-- sweep tell a row where nothing was lost from one where a customer went unanswered.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "inbound_message_id" INTEGER;
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
CREATE INDEX "chatwoot_webhook_deliveries_retire_idx"
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
-- A delivery genuinely in flight and older than that is being stranded by the same deploy, so a
-- terminal state is the right answer for it. A younger one is left where it is: if the deploy
-- strands it, the sweep reaches it half an hour later and reads it by the rules below rather than by
-- this blanket.
--
-- WHICH terminal state is a question this migration can answer, and it is the same question
-- `classifyStrandedDelivery` asks first: only a `message_created` could ever have owed a customer a
-- turn. `event` is not one of the columns being added here — every build has always written it — so
-- a conversation update, our own media write-back, a contact created and everything else Chatwoot
-- sends an agent bot are closed rather than reported. Blanket-DEAD, they would arrive as a deploy-day
-- pile of "customer went unanswered" rows that no customer was ever waiting on, in the list whose
-- entire value is that every row in it is real.
--
-- What stays ambiguous is a legacy `message_created`, which may or may not have carried an incoming
-- message: the id columns are added by this same migration and neither is backfilled. DEAD is the
-- conservative reading, and the one this whole change exists for — closing them as PROCESSED would
-- hide real losses in the population most likely to hold them.
--
-- Those rows land in the DEAD list WITHOUT the conversation-level log line and alert the sweep
-- writes, and that is deliberate rather than an oversight. Nothing here knows what they carried, so
-- a line for one of them could not name a conversation, a message, or even whether a customer was
-- waiting. A deploy-time burst of error-level alerts saying "some old deliveries were abandoned"
-- would page an operator with nothing to act on. They are distinguishable from everything the sweep
-- closes later, which is what an operator needs:
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
   SET status = 'PROCESSED', processed_at = now()
 WHERE status IN ('PENDING', 'PROCESSING')
   AND event <> 'message_created'
   AND received_at < now() - interval '30 minutes';

UPDATE "chatwoot_webhook_deliveries"
   SET status = 'DEAD', processed_at = now()
 WHERE status IN ('PENDING', 'PROCESSING')
   AND event = 'message_created'
   AND received_at < now() - interval '30 minutes';

RESET app.is_super_admin;
