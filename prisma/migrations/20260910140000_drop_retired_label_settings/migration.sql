-- The taxonomy keys were retired with the classifier (issue #568): `settings.labels` (groups and
-- `noteOnChange`) and `settings.monitoring.labelGroups` are read by nothing, and the write boundary
-- now refuses a non-empty one so an operator is told where the taxonomy went instead of saving
-- configuration that governs nothing.
--
-- This file exists because REFUSING WITHOUT REMOVING BREAKS ORDINARY SAVES. The previous Behavior
-- editor wrote the monitoring block through `observationToStored`, which built `labelGroups`
-- UNCONDITIONALLY — so every agent ever saved through that screen carries the key, almost always as
-- an empty array, whether or not a taxonomy was ever configured. Both writers that survive spread
-- what they read: the console's Tools save spreads `syncedSettings`, and `agent_settings_set`
-- preserves untouched blocks. Left in place, the stored tombstone would come back on the next
-- unrelated save and be refused, and the operator would have no way to act on it from the screen
-- they were on. Caught in review (round 14) after the population question was asked about
-- CONFIGURED taxonomies, which is genuinely empty, and answered for STORED KEYS, which is not.
--
-- Idempotent and safe to run twice: `#-` on an absent key is a no-op, and the WHERE clauses only
-- touch rows that still carry one. No audit line: nothing an operator chose is being changed —
-- these keys reached no reader before this migration and reach none after it.
--
-- One transaction, because the RLS lift below must not outlive a failure: FORCE ROW LEVEL SECURITY
-- binds the table owner too, so the UPDATEs would otherwise reach zero rows.

BEGIN;

ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;

-- 1. The whole `labels` block. It held `groups` and `noteOnChange`, and neither has a reader.
UPDATE "agents"
SET "settings" = "settings" #- '{labels}'
WHERE "settings" ? 'labels';

-- 2. `monitoring.labelGroups` only. The rest of the block is live configuration (the burst window,
--    `analysis`, the debounce), so the key is cut out rather than the block dropped.
UPDATE "agents"
SET "settings" = jsonb_set(
      "settings",
      '{monitoring}',
      ("settings" -> 'monitoring') #- '{labelGroups}'
    )
WHERE jsonb_typeof("settings" -> 'monitoring') = 'object'
  AND ("settings" -> 'monitoring') ? 'labelGroups';

ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;

COMMIT;
