-- STOP-MIGRATE-START (review round 41). Under the boot order in docs/deploy.md the previous release
-- is still serving while this runs, and there `observationEnabled(cfg)` is `cfg.labelGroups.length >
-- 0`: with the key cut, that process arms no observation and answers a queued row `observation_off`.
-- An `on_resolve` observation has no later event to recover it, so the window's losses are
-- permanent. The note in docs/deploy.md carries it.
--
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
-- WHAT AN OPERATOR CONFIGURED IS CARRIED OVER, not dropped. A non-empty `labelGroups` is the one
-- thing in these keys that somebody chose: it said which labels exist and which exclude each other,
-- and under the new design that is a SENTENCE in the tool's usage guidance, written in the operator's
-- own words. So a non-empty list is rendered into `toolGuidance.set_labels` before the key goes, and
-- only where the operator has not already written one there — their own words win over ours. The
-- text names itself as migrated, because an operator who finds guidance they did not type needs to
-- know where it came from, and this migration writes no audit line (nothing else here changes
-- anything a person chose). Empty at every install we could ask about, which is why this is
-- insurance rather than the point of the file (issue #568, review round 26).
--
-- Idempotent and safe to run twice: `#-` on an absent key is a no-op, and the WHERE clauses only
-- touch rows that still carry one. No audit line: nothing an operator chose is being changed —
-- these keys reached no reader before this migration and reach none after it.
--
-- One transaction, because the RLS lift below must not outlive a failure: FORCE ROW LEVEL SECURITY
-- binds the table owner too, so the UPDATEs would otherwise reach zero rows.

BEGIN;

ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_selections" NO FORCE ROW LEVEL SECURITY;

-- 1. The whole `labels` block. It held `groups` and `noteOnChange`, and neither has a reader.
UPDATE "agents"
SET "settings" = "settings" #- '{labels}'
WHERE "settings" ? 'labels';

-- 1b. THE CONFIGURED TAXONOMY, rendered as guidance BEFORE step 2 cuts the key out. Ordered by the
--     list's own order so the sentence reads the way the screen did. Capped at TOOL_INSTRUCTIONS_MAX
--     (1500, src/modules/agents/text-caps.ts): a longer value is clipped by every reader anyway, and
--     stored over the cap it would make the agent's next save fail — the same trap the import
--     boundary clamps for.
WITH rendered AS (
  SELECT a.id,
         string_agg(
           coalesce(nullif(btrim(grp ->> 'name'), ''), 'sem nome')
             -- THE READER'S OWN RULE, and never a cast. `readLabelGroups` asked `bag.exclusive !==
             -- false`, so a group that never wrote the field was EXCLUSIVE — the default, and the
             -- opposite of what a missing value casts to. And the bag is loose: an imported agent
             -- can carry `"custom"` or an object there, and `::boolean` on it raises and aborts the
             -- whole deployment migration. Comparing the jsonb value answers both at once: only an
             -- explicit `false` is non-exclusive, everything else (absent, a string, an object)
             -- reads the way the previous release read it (review round 27).
             || CASE
                  WHEN (grp -> 'exclusive') = to_jsonb(false)
                    THEN ' (pode usar mais de uma)'
                  ELSE ' (escolha no máximo uma)'
                END
             || ': '
             || coalesce(
                  (SELECT string_agg(v, ', ')
                     FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(grp -> 'values') = 'array'
                                 THEN grp -> 'values' ELSE '[]'::jsonb END
                          ) AS v),
                  '(sem valores)'
                ),
           -- NOTE: '. ' and not a semicolon, which the migration TEST splits statements on: a
           --       literal one here would cut this statement in half where nobody would look.
           '. ' ORDER BY ord
         ) AS txt
    -- THE GUARD GOES IN THE ARGUMENT, NOT IN THE WHERE (review round 39, measured on this Postgres).
    -- A lateral set-returning function is evaluated for every row BEFORE the WHERE of its own query
    -- level, and AND does not order its operands either, so `jsonb_typeof(...) = 'array'` beside
    -- the call protects nothing: an agent carrying a string or an object under `labelGroups`, which
    -- an import can, raises "cannot extract elements from a scalar" (and "cannot get array length
    -- of a scalar" at 1c below) and aborts the WHOLE deployment migration. Substituting `[]` is the
    -- same filter by another route: the row then produces no elements and drops out of the join,
    -- exactly as the two discarded predicates intended. Same shape as the `exclusive` cast of round
    -- 27, a few lines up.
    FROM "agents" a,
         LATERAL jsonb_array_elements(
                   CASE WHEN jsonb_typeof("settings" -> 'monitoring' -> 'labelGroups') = 'array'
                        THEN "settings" -> 'monitoring' -> 'labelGroups'
                        ELSE '[]'::jsonb END
                 ) WITH ORDINALITY AS t(grp, ord)
   WHERE jsonb_typeof(grp) = 'object'
   GROUP BY a.id
)
UPDATE "agents" a
SET "settings" = jsonb_set(
      CASE WHEN jsonb_typeof(a."settings" -> 'toolGuidance') = 'object'
           THEN a."settings"
           ELSE jsonb_set(a."settings", '{toolGuidance}', '{}'::jsonb) END,
      '{toolGuidance,set_labels}',
      to_jsonb(
        left(
          'Migrado da taxonomia anterior. Grupos de etiquetas desta conta: ' || r.txt || '.',
          1500
        )
      )
    ),
    "updated_at" = NOW()
FROM rendered r
WHERE r.id = a.id
  AND r.txt IS NOT NULL
  -- NOTE: coalesce, because an ABSENT toolGuidance makes the comparison NULL and `NOT NULL` is NULL,
  --       which filters the row out — the row this whole block exists for. Three-valued logic, and
  --       the failure is silent: the migration runs, reports success and carries nothing over.
  AND NOT coalesce(
        jsonb_typeof(a."settings" -> 'toolGuidance') = 'object'
          AND (a."settings" -> 'toolGuidance') ? 'set_labels',
        false
      );

-- 1c. THE GRANT THAT THE OLD CLASSIFIER NEVER NEEDED. It applied its labels itself and asked no
--     allowlist, so a watcher could carry an explicit NATIVE allowlist WITHOUT the label tool and
--     classify anyway. Under the new design the sentence above is worth nothing without the tool:
--     the agent keeps running and spending a model call per burst while quietly no longer
--     classifying. Only for the agents whose taxonomy was just carried over, and only where a row
--     exists — an agent with NO native selection row is already allowed every native, so adding one
--     would NARROW what it can do (review round 28).
UPDATE "agent_tool_selections" s
SET enabled_tools = array_append(s.enabled_tools, 'set_labels'),
    updated_at = NOW()
FROM "agents" a
WHERE s.agent_id = a.id
  AND s.source = 'NATIVE'
  AND NOT ('set_labels' = ANY(s.enabled_tools))
  AND jsonb_array_length(
        CASE WHEN jsonb_typeof(a."settings" -> 'monitoring' -> 'labelGroups') = 'array'
             THEN a."settings" -> 'monitoring' -> 'labelGroups'
             ELSE '[]'::jsonb END
      ) > 0;

-- 2. `monitoring.labelGroups` and `monitoring.noteOnChange`, the two retired keys inside a block
--    that is otherwise live configuration (the burst window, `analysis`, the debounce), so the keys
--    are cut out rather than the block dropped. `noteOnChange` is the one that actually shipped:
--    `readMonitoringConfig` read it off THIS block, and the previous editor wrote it for every
--    agent, defaulting to true.
UPDATE "agents"
SET "settings" = jsonb_set(
      "settings",
      '{monitoring}',
      ("settings" -> 'monitoring') #- '{labelGroups}' #- '{noteOnChange}'
    )
WHERE jsonb_typeof("settings" -> 'monitoring') = 'object'
  AND (("settings" -> 'monitoring') ? 'labelGroups'
       OR ("settings" -> 'monitoring') ? 'noteOnChange');

ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_selections" FORCE ROW LEVEL SECURITY;

COMMIT;
