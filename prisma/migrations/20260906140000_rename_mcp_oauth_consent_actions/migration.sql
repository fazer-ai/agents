-- The two audit actions that predate the `<entity>.<verb>` convention (#392) get the shape every
-- other one has. They are not legacy names on a dead producer: `auditConsentDecision` writes one of
-- them on every MCP OAuth consent decision, and the console's action filter renders the catalog
-- VERBATIM, so the odd spelling reaches the operator as noise and suggests the family it belongs to
-- is somewhere else.
--
--     mcp_oauth_consent_granted  ->  mcp_oauth_consent.grant
--     mcp_oauth_consent_denied   ->  mcp_oauth_consent.deny
--
-- WHY THE RENAME CANNOT BE PRODUCER-ONLY. The rows already recorded stay in `audit_logs` forever,
-- and the filter offers exactly the catalog: rename the producers alone and the same act sits under
-- two names, only one of which can be picked. The old rows are not hidden, they are unreachable
-- through the only door the page has.
--
-- WHAT THIS PASS CANNOT REACH is a row written AFTER it runs, and the rollout guarantees some: the
-- deploy overlaps, so the outgoing container keeps serving consent decisions under the old spellings
-- while the incoming one migrates (docs/deploy.md). Both old names therefore stay in `AUDIT_ACTIONS`
-- for this release, so those rows are still offered by the filter, and a SECOND pass over them plus
-- the delisting is the release after this one.
--
-- Keyed on the WHOLE name rather than a prefix: `mcp_client.*`, `mcp_connection.*`, `mcp_approval.*`
-- and `mcp_token.*` are neighbours in the same family and already conventional.
--
-- `action` carries no index (`audit_logs` is indexed for the keyset walk: `(tenant_id, created_at
-- DESC, id DESC)` and `(created_at DESC, id DESC)`), so each statement is one sequential scan of the
-- table. That is the right trade here rather than building an index for two one-time UPDATEs: the
-- matching rows are consent decisions, which are written once per operator per client, and the scan
-- takes no lock beyond the ROW EXCLUSIVE an ordinary write already takes.
--
-- RLS: a data migration lifts FORCE on every forced table it writes AND reads, and restores it
-- (.claude/rules/prisma.md, tests/prisma/migration-rls-bypass.test.ts). Without it, on the managed
-- Postgres where `MIGRATION_DATABASE_URL` is the owner without rolsuper, both statements match ZERO
-- rows and report success.

ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;

UPDATE "audit_logs" SET action = 'mcp_oauth_consent.grant'
 WHERE action = 'mcp_oauth_consent_granted';

UPDATE "audit_logs" SET action = 'mcp_oauth_consent.deny'
 WHERE action = 'mcp_oauth_consent_denied';

ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
