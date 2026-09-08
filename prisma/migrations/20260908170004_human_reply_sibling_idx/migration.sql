-- THE SIBLING LOOKUP ON A COLLEAGUE'S REPLY GETS THE INDEX THE INBOUND ONE ALREADY HAS (issue #540,
-- PR review round 9).
--
-- `responderSiblingRemembers` asks, for every delivery on an observer's route, what the responder's
-- own delivery of the SAME message decided. On a customer message that lookup is keyed by
-- `inbound_message_id` and served by `chatwoot_webhook_deliveries_retire_idx`; on a colleague's
-- reply it is keyed by `human_reply_message_id`, which had no index at all.
--
-- The shape that hurts is the ORDINARY one, not a rare one: the fan-out has no order, so the
-- observer's delivery arrives first about half the time, and then the query finds NOTHING — and an
-- absence is the case that has to read every candidate row before it can be stated. Nothing prunes
-- this ledger (see 20260825140100), so "every candidate row" grows for the life of the install, on
-- the live path of every reply on a shared observer/responder inbox.
--
-- PARTIAL, for the reason the sweep's index is: `human_reply_message_id` is null on every row that is
-- not a colleague's reply, which is the great majority of the table. Restricted to the rows the
-- query can match, the index stays the size of the replies actually handled and costs nothing on the
-- inserts that carry no reply.
--
-- ACCOUNT FIRST, like the retire index and for the same reason: message ids are numbered per
-- Chatwoot account, so a conversation id alone matches rows on every account a tenant has connected.
--
-- CONCURRENTLY and IDEMPOTENT, both forced by how this file runs: `prisma migrate deploy` does not
-- wrap a migration in a transaction, so CONCURRENTLY is accepted here — and a build that fails
-- leaves an INVALID index behind, which is never used for a query and still maintained on every
-- write, so the DROP is what makes a re-run possible rather than a name collision.
--
-- Declared here and not in schema.prisma because Prisma cannot express a partial index, the same
-- arrangement the sweep's index uses.
DROP INDEX IF EXISTS "chatwoot_webhook_deliveries_reply_sibling_idx";
CREATE INDEX CONCURRENTLY "chatwoot_webhook_deliveries_reply_sibling_idx"
    ON "chatwoot_webhook_deliveries"("chatwoot_instance_id", "conversation_id", "human_reply_message_id")
 WHERE "human_reply_message_id" IS NOT NULL;
