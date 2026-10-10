-- The decisions engine's simulation mode is removed (issue #1224): `settings.monitoring.decisions.apply`
-- ("shadow" decided and logged without writing, "enforce" wrote) no longer exists, and every rule
-- that fires runs. The write boundary refuses the key by name, so it cannot stay on stored rows:
-- the next unrelated save of the block would be refused over a field the screen no longer shows.
--
-- AN AGENT THAT WAS IN SIMULATION IS DISABLED, not switched live. Its rules were written to be
-- watched, never to write, and after this release they would start labelling and noting real
-- conversations the moment it ran. Disabled, the operator reviews the rules and turns it back on.
-- One audit line per agent disabled, with the reason, so the operator who finds it off knows why.
-- Every other agent only loses the key: `enforce` is what every agent does now.
--
-- Idempotent: `#-` on an absent key is a no-op and the WHERE clauses only reach rows that still
-- carry it. One transaction, because the RLS lift below must not outlive a failure: FORCE ROW LEVEL
-- SECURITY binds the table owner too, so the writes would otherwise reach zero rows.
-- `tests/prisma/remove-decisions-simulation-migration.test.ts` asks for this file by name.

BEGIN;

ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;

-- 1. The audit line first, while `enabled` still says what the agent was.
INSERT INTO "audit_logs" (tenant_id, actor_id, actor_type, action, target, "before", "after", created_at)
SELECT tenant_id, NULL, 'system', 'agent.disabled_by_upgrade', 'agent:' || id,
       jsonb_build_object('enabled', enabled, 'monitoring.decisions.apply', 'shadow'),
       jsonb_build_object(
         'enabled', false,
         'reason', 'simulation mode removed; agent disabled so it does not start writing without review'
       ),
       NOW()
FROM "agents"
WHERE "settings" #>> '{monitoring,decisions,apply}' = 'shadow';

-- 2. Those agents off, and the key out.
UPDATE "agents"
SET "enabled" = false,
    "updated_at" = NOW(),
    "settings" = "settings" #- '{monitoring,decisions,apply}'
WHERE "settings" #>> '{monitoring,decisions,apply}' = 'shadow';

-- 3. Everyone else only loses the key.
UPDATE "agents"
SET "settings" = "settings" #- '{monitoring,decisions,apply}'
WHERE "settings" #> '{monitoring,decisions}' ? 'apply';

ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;

COMMIT;
