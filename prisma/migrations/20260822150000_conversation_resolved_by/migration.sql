-- Records who closed a conversation, so the dashboard's Resolution funnel stops inferring "the AI
-- resolved it" from status + assignee. See src/modules/analytics/resolution-origin.ts.
ALTER TABLE "conversations" ADD COLUMN "resolved_by" TEXT;

-- Rows already resolved when this ran predate the recording and cannot be attributed. Marking them
-- keeps them distinguishable from a conversation closed AFTER this point by someone other than the
-- agent (which is a real, countable "not the agent"), so the dashboard can report the historical
-- span separately instead of the funnel silently stepping down on upgrade day.
UPDATE "conversations" SET "resolved_by" = 'legacy_unknown' WHERE "status" = 'resolved';
