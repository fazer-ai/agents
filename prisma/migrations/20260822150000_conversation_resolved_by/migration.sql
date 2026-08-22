-- Records who closed a conversation, so the dashboard's Resolution funnel stops inferring "the AI
-- resolved it" from status + assignee. See src/modules/conversations/resolution-origin.ts.
ALTER TABLE "conversations" ADD COLUMN "resolved_by" TEXT;

-- The status version the stamp above was written against. Without it, a delayed `resolved` event
-- from an earlier episode is indistinguishable from our own close failing to land, and clearing on
-- the second erases the first. Left NULL by the backfill below: a row resolved before this ran has
-- no close of ours to date.
ALTER TABLE "conversations" ADD COLUMN "resolved_by_at" DOUBLE PRECISION;

-- `conversations` carries FORCE ROW LEVEL SECURITY, which binds the table OWNER too; only a
-- superuser (or a BYPASSRLS role) is exempt. docs/deploy.md allows MIGRATION_DATABASE_URL to be
-- "superuser OR DB owner", and on managed Postgres the administrative role is typically the owner
-- WITHOUT rolsuper. Without this GUC the backfill below matches zero rows and reports success: no
-- error, no warning, migrate deploy green, and every historical conversation reads as "closed by
-- somebody else" with the note that explains them never appearing. Same silent failure as #106.
--
-- Plain SET, not SET LOCAL: outside a transaction SET LOCAL is a no-op with only a warning, which
-- would reproduce the very failure this line exists to prevent.
SET app.is_super_admin = 'on';

-- Rows already resolved when this ran predate the recording and cannot be attributed. Marking them
-- keeps them distinguishable from a conversation closed AFTER this point by someone other than the
-- agent (which is a real, countable "not the agent"), so the dashboard can report the historical
-- span separately instead of the funnel silently stepping down on upgrade day.
UPDATE "conversations" SET "resolved_by" = 'legacy_unknown' WHERE "status" = 'resolved';

RESET app.is_super_admin;
