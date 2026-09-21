-- WHAT THE STRANDED PASS OWED, AND HOW WIDE ITS SETTLEMENT WAS (issue #725). Two columns for one
-- fact: `owes_memory_only` says the pass ran with no reply to give, and
-- `settle_scoped_to_this_delivery` says which scope it would have settled with. The second exists
-- because the first is not enough on its own -- the scope is derived from WHO held the conversation,
-- and a replay half an hour later reads a different answer to that question (review round 2).
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "owes_memory_only" BOOLEAN;
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "settle_scoped_to_this_delivery" BOOLEAN;
