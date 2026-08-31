-- The at-most-once claim every posting path takes before it sends (issue #452). Separate from
-- `last_handled_message_id`, which is ALSO advanced by deliberate skips (a human-owned stretch, an
-- out-of-hours silence, a turn that ended without a reply) and therefore answers "will anything
-- answer this again" rather than "did anything answer this". The manual re-engage needs the second
-- question, and claiming on the first made it lose forever on the conversations it exists for.
ALTER TABLE "conversations" ADD COLUMN "last_replied_message_id" INTEGER;
