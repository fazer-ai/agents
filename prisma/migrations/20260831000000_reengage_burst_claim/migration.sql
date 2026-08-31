-- The manual re-engage's own at-most-once claim (issue #452). Separate from
-- `last_handled_message_id` because that watermark is advanced by deliberate SKIPS too, so after a
-- human-owned stretch it stands ahead of the tail the button answers and its CAS can never win.
ALTER TABLE "conversations" ADD COLUMN "last_reengaged_message_id" INTEGER;
