-- When the CURRENT attempt on an inbound delivery was claimed, which is the only thing that can
-- tell a claim still running from one whose process died (issue #356).
--
-- Staleness was read off `received_at`, and that is the delivery's RECEIPT, never refreshed by a
-- claim. Five minutes after a webhook arrives the row is permanently "stale" by that measure, so a
-- duplicate delivery landing while the last attempt was still working could reclaim it, and the
-- attempt-cap path could mark it terminally FAILED under the invocation that then marked it
-- PROCESSED.
--
-- Nullable, and no backfill: NULL reads as stale, which is correct for every row that exists today.
-- A PROCESSING row written before this column was added has been sitting there since before the
-- deploy, so nothing is running for it.
ALTER TABLE "inbound_deliveries" ADD COLUMN "claimed_at" TIMESTAMP(3);

-- And the claims that are RUNNING while this statement executes. `docs/deploy.md` supports rolling
-- deploys (with `migrate deploy` as a pre-deploy step) and a scaled web tier, so the previous
-- version is serving inbound webhooks right now and its claims carry no stamp. Reading those as
-- stale would let a duplicate delivery take a row mid-flight — running an agent nudge twice — or
-- mark its last attempt terminally FAILED under the invocation still working on it.
--
-- `now()` rather than a backfill from `received_at`, which cannot answer this: a fifth attempt is
-- claimed hours after receipt, so a row claimed one second ago can carry an ancient receipt. This
-- fences EVERY pre-existing claim for one full staleness window and costs a genuinely abandoned row
-- five minutes of extra wait.
-- `inbound_deliveries` carries FORCE ROW LEVEL SECURITY, which binds the table OWNER too; only a
-- superuser (or a BYPASSRLS role) is exempt. docs/deploy.md allows MIGRATION_DATABASE_URL to be
-- "superuser OR DB owner", and on managed Postgres the administrative role is typically the owner
-- WITHOUT rolsuper. Without this GUC the statement below matches zero rows and reports success: no
-- error, no warning, migrate deploy green, and every live claim goes unfenced on exactly the
-- installs we do not run ourselves. Plain SET, never SET LOCAL, which outside a transaction is a
-- no-op with a warning.
SET app.is_super_admin = 'on';

UPDATE "inbound_deliveries" SET "claimed_at" = now() WHERE "status" = 'PROCESSING';

RESET app.is_super_admin;
