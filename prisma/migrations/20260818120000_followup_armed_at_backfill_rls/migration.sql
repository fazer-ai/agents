-- Re-arm the agents the 20260807032257 backfill silently missed.
--
-- That migration ended in a bare `UPDATE "agents" SET "follow_up_armed_at" = NOW()`. `agents`
-- carries FORCE ROW LEVEL SECURITY, so `tenant_isolation` applies to the table OWNER as well; only
-- a superuser (or a BYPASSRLS role) is exempt. docs/deploy.md allows MIGRATION_DATABASE_URL to be
-- "superuser OR DB owner", and on managed Postgres the administrative role is typically the owner
-- WITHOUT rolsuper. There the statement matched zero rows and reported success: no error, no
-- warning, migrate deploy green. Every agent that existed before that deploy kept a null watermark,
-- which conversations/service.ts reads as "not armed", and since the column gates sequence STARTS,
-- no follow-up ever fires on that install (issue #106).
--
-- The GUC is the same escape hatch the app's own asSuperAdmin() path uses, and docs/deploy.md
-- (#105) makes it the rule for any DATA migration over a tenant-scoped table. Plain SET rather than
-- SET LOCAL: outside a transaction SET LOCAL is a no-op with only a warning, which would reproduce
-- the very failure this migration exists to repair.
SET app.is_super_admin = 'on';

-- Idempotent by construction. An install where the original backfill DID work is untouched, and so
-- is any agent armed since by the app's OFF→ON transition. Re-arming an already-armed agent would
-- move its watermark forward, and the watermark is what keeps the sweep off the historical backlog.
-- NOW() (transaction start) is the conservative value: it admits only episodes of silence that
-- begin after this deploy, which is the semantics the column was introduced with.
UPDATE "agents" SET "follow_up_armed_at" = NOW() WHERE "follow_up_armed_at" IS NULL;

RESET app.is_super_admin;
