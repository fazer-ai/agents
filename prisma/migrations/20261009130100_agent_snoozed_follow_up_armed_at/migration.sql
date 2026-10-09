-- The backlog fence of the snoozed ladder (issue #1184), stamped when snoozedFollowUp turns on.
-- Nullable with no default, so the ALTER only touches the catalog.
ALTER TABLE "agents" ADD COLUMN "snoozed_follow_up_armed_at" TIMESTAMP(3);
