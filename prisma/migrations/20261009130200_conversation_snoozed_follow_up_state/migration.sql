-- Where the snoozed ladder (issue #1184) stands on a conversation: which message of a person it is
-- chasing, how many steps it has spent on it, and when the last one ran. Nullable with no default, so
-- the ALTER only touches the catalog.
ALTER TABLE "conversations"
  ADD COLUMN "snoozed_follow_up_anchor_id" INTEGER,
  ADD COLUMN "snoozed_follow_up_step" INTEGER,
  ADD COLUMN "snoozed_follow_up_at" TIMESTAMP(3);
