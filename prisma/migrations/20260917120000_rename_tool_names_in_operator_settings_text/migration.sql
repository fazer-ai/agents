-- A RENAME HAS TO FOLLOW THE OPERATOR'S OWN PROSE, NOT ONLY THE KEYS IT IS FILED UNDER (issue #604).
--
-- `20260909120000_rename_http_tools_named_after_natives` moved `assign_label` to `set_labels` in four
-- places: the system prompt (where it rewrote the PROSE, line 244), the NATIVE grant, and the
-- `toolGuidance` / `toolPreconditions` keys (where it moved the KEY and left the value alone). That
-- last part is what this file finishes. Measured on a real installation right after upgrading to
-- v1.16.0: the note moved to the new key and its own text did not, so
-- `readToolGuidance` appended, to the description of `set_labels`, an instruction about calling
-- `assign_label` -- a name the model is never shown and cannot call. Nothing was lost and no
-- capability broke; what it cost was a rule read against a tool that does not exist, on the single
-- tool the rule was written to fence, and an operator with no way to know the two halves disagreed.
--
-- THE SURFACE, counted rather than assumed. Operator-authored free text lives in
-- `agents.system_prompt` and in twelve kinds of field inside `agents.settings`
-- (`src/modules/agents/text-caps.ts` walks all twelve, and says of itself that it is the one place
-- that knows where that text lives). SIX of those twelve carry text where a tool name MEANS the
-- agent's toolset, and those six are what this file rewrites. That is the axis, and it is not "the
-- reader has tools": the first four are read by the tool-calling model itself, and the two guardrail
-- ones are read by a model that has no tools at all (`analyze.ts` uses `withStructuredOutput` and
-- says so twice) yet are rules ABOUT what the agent may call, so a stale name there is a policy
-- pointed at a tool that no longer exists.
--
--   toolGuidance.<tool>                 appended to that tool's description
--   handoff.instructions                appended to handoff_to_human's description
--   kanban.instructions                 appended to kanban_move_card's description
--   followUp.steps[i].instructions      "Operator guidance for this follow-up", in the nudge prompt
--   guardrails.customPolicy             "Additional policy", in every analysis prompt
--   guardrails.output.generationPrompt  steers the model that rewrites a refused reply
--
-- `system_prompt` is the seventh model-facing surface, and the migration named above already
-- rewrote it; doing it again here would write a second audit line for one change.
--
-- AND PROSE DOES NOT ALL LIVE IN THE BAG. Two more surfaces are COLUMNS on the tool definition
-- tables, which `text-caps.ts` knows nothing about: `tool_definitions.description` and
-- `code_tool_definitions.description`, which the model receives as those tools' descriptions, plus
-- the per-argument `description` inside each `input_schema`, in BOTH shapes that column can hold
-- (the compact map and legacy JSON Schema), which it receives as the argument's hint. This file
-- rewrites them too; the block that does it is at the bottom, with the ambiguity they raise stated
-- there. `tests/utils/operator-text-classes.ts` classifies every String column of
-- those two tables so a new one cannot arrive unclassified.
--
-- DELIBERATELY NOT REWRITTEN, and the reason is the same for the first group: the text is read by a
-- PERSON, not by a model, and `set_labels` means no more to a customer than `assign_label` did. The
-- rename would change a message a customer reads and fix nothing.
--
--   availability.awayMessage, contactAuth.denyMessage,
--   guardrails.input.templateMessage, guardrails.output.templateMessage, signature.text
--
-- And `vision.extractionPrompt` is out for a different reason: it instructs the vision model to read
-- an image, and it is not a rule about the agent's behaviour either, so a tool name in it means
-- nothing in either spelling. What separates it from the two guardrail prompts is NOT that its
-- reader lacks tools (neither reader has any); it is that a tool name there refers to nothing.
--
-- EVERY FOLLOW-UP STEP, INCLUDING THE ONES PAST THE READER'S CUT. `readFollowUpConfig` keeps the
-- first ten steps and `text-caps.ts` stops walking there for a stated reason ("text in a step the
-- reader discards is text nothing reads"), and this file deliberately does NOT stop: the cut is on
-- POSITION, so deleting or reordering a step promotes the eleventh into range, and a name that goes
-- live later is worse than a rewrite of text nothing reads today. Rewriting them all costs one more
-- `jsonb_set` per step; the audit line names each index it touched, so the operator can see it.
--
-- `toolPreconditions` needs nothing here: it holds structured conditions, not prose, and the earlier
-- migration already moved its keys.
--
-- `\y` is a word boundary and `_` is a word character to it, so `xassign_labelx` is left alone --
-- the same predicate the earlier migration used on the prompt, on purpose: two rewrites of one
-- rename that disagreed about what a word is would be worse than one of them not running.
--
-- Wrapped in BEGIN/COMMIT because the file lifts FORCE ROW LEVEL SECURITY: a failure in the middle
-- of an unwrapped file leaves `agents` not subjecting its own owner to the tenant policy
-- (.claude/rules/prisma.md). The lift itself is required for a data migration over a forced table,
-- for every table it WRITES and every table it READS.

BEGIN;

ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "code_tool_definitions" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  r RECORD;
  s jsonb;
  touched text[];
  p text;
  path text[];
  gk text;
  gv jsonb;
  step jsonb;
  ord int;
  old_text text;
  -- Scalar string paths, as comma-joined keys: a Postgres 2-D array wants every row the same
  -- length, and one of these is three deep.
  scalar_paths text[] := ARRAY[
    'handoff,instructions',
    'kanban,instructions',
    'guardrails,customPolicy',
    'guardrails,output,generationPrompt'
  ];
BEGIN
  -- THE PREFILTER IS A SUBSTRING, NOT A WORD BOUNDARY, and that is the whole point of it being
  -- separate from the per-field test below. On the serialized bag a newline inside the operator's
  -- note comes out as the two characters `\` and `n`, so `Allowed tool:` + newline + `assign_label`
  -- puts a WORD CHARACTER right before the name and `\y` does not match: the agent would be skipped
  -- with its guidance left stale and no audit line (measured in review round 1 of PR #687, where
  -- the serialized bag answered false and the decoded value answered true). The boundary belongs on
  -- the DECODED value, which is where prose actually lives, and this filter only has to avoid
  -- MISSING a row. `strpos` rather than LIKE because `_` is a LIKE wildcard, the same note the
  -- 20260903120000 migration makes about these names.
  --
  -- Over-inclusive on purpose: a row it selects may carry the old name only in a field this
  -- migration leaves alone, and then `touched` comes back empty and nothing is written.
  FOR r IN
    SELECT id, tenant_id, settings FROM "agents"
     WHERE strpos(settings::text, 'assign_label') > 0
  LOOP
    s := r.settings;
    touched := ARRAY[]::text[];

    FOREACH p IN ARRAY scalar_paths LOOP
      path := string_to_array(p, ',');
      IF jsonb_typeof(s #> path) = 'string' THEN
        old_text := s #>> path;
        IF old_text ~ '\yassign_label\y' THEN
          s := jsonb_set(s, path, to_jsonb(regexp_replace(old_text, '\yassign_label\y', 'set_labels', 'g')));
          touched := touched || replace(p, ',', '.');
        END IF;
      END IF;
    END LOOP;

    -- Every STRING value under toolGuidance, whatever key it is filed under. Not only the keys in
    -- the native catalog: the catalog is code and this file is frozen, so encoding it here would
    -- leave a note unrewritten the moment the catalog gains a name. Rewriting text that no reader
    -- keeps (`readToolGuidance` drops keys outside the catalog) costs nothing; missing a note the
    -- reader does keep costs the operator their rule.
    --
    -- Written as a walk with `jsonb_set` per key rather than as one `jsonb_object_agg` rebuild, for
    -- two reasons: a rebuild replaces the whole object, so a value shape this file did not think of
    -- would be rewritten by the aggregate's ELSE branch instead of being left where it is, and the
    -- audit line below can then name the KEY that changed instead of the block.
    IF jsonb_typeof(s -> 'toolGuidance') = 'object' THEN
      FOR gk, gv IN SELECT e.key, e.value FROM jsonb_each(r.settings -> 'toolGuidance') AS e LOOP
        IF jsonb_typeof(gv) = 'string' AND (gv #>> '{}') ~ '\yassign_label\y' THEN
          s := jsonb_set(
            s,
            ARRAY['toolGuidance', gk],
            to_jsonb(regexp_replace(gv #>> '{}', '\yassign_label\y', 'set_labels', 'g'))
          );
          touched := touched || ('toolGuidance.' || gk);
        END IF;
      END LOOP;
    END IF;

    -- The follow-up steps, by index. `jsonb_set` on one element leaves the ARRAY ORDER alone, which
    -- a `jsonb_agg` rebuild would only preserve if asked (and these steps are a SEQUENCE: reordering
    -- them changes when each nudge fires, a worse defect than the one this file exists to fix).
    IF jsonb_typeof(s #> '{followUp,steps}') = 'array' THEN
      FOR step, ord IN
        SELECT a.step, a.ord
          FROM jsonb_array_elements(r.settings #> '{followUp,steps}') WITH ORDINALITY AS a(step, ord)
      LOOP
        IF jsonb_typeof(step) = 'object'
           AND jsonb_typeof(step -> 'instructions') = 'string'
           AND (step #>> '{instructions}') ~ '\yassign_label\y' THEN
          s := jsonb_set(
            s,
            ARRAY['followUp', 'steps', (ord - 1)::text, 'instructions'],
            to_jsonb(regexp_replace(step #>> '{instructions}', '\yassign_label\y', 'set_labels', 'g'))
          );
          -- Through `format()`, and not as a bare literal. On the right of `text[] ||` an UNTYPED
          -- literal is read as an ARRAY literal, so the statement dies at runtime with "malformed
          -- array literal" (measured twice: once while mutating this line, and once for real on the
          -- appends in the tool-definition block below, which now carry an explicit `::text`). Every
          -- append in this file is therefore a typed expression: a function result, a concatenation,
          -- or a cast. A DO block only fails when a row reaches it, so an empty table hides this.
          touched := touched || format('followUp.steps[%s].instructions', ord - 1);
        END IF;
      END LOOP;
    END IF;

    IF array_length(touched, 1) IS NOT NULL THEN
      UPDATE "agents" SET settings = s, updated_at = NOW() WHERE id = r.id;
      -- The audit line names the PATHS, which is the thing the operator cannot see for themselves:
      -- the text is theirs, so what they need from the trail is which of their own fields an upgrade
      -- edited. Its own action, not the one the earlier migration used for the prompt: that one says
      -- "your prompt was rewritten" and this one says "these settings fields were", and an operator
      -- reading the trail has to be able to tell them apart.
      INSERT INTO "audit_logs" (
        tenant_id, actor_id, actor_type, action, target, "before", "after", created_at
      ) VALUES (
        r.tenant_id, NULL, 'system', 'agent.settings_text_renamed_tool', 'agent:' || r.id,
        NULL,
        jsonb_build_object(
          'tool', 'assign_label',
          'renamed', 'set_labels',
          'paths', to_jsonb(touched)
        ),
        NOW()
      );
    END IF;
  END LOOP;
END $$;

-- THE OPERATOR'S OWN TOOLS, which are prose too and do not live in the settings bag at all. An HTTP
-- or CODE tool carries a `description` the operator typed, and the MODEL receives it as that tool's
-- description (`src/graph/tools/http.ts:972`, `src/graph/tools/code.ts:172`), right beside the
-- native whose name changed; the per-argument `description` inside `input_schema` reaches the same
-- model as the argument's own hint (`http.ts:275`, `zt.describe`). Same harm, same surface, and
-- `text-caps.ts` does not know about them because they are COLUMNS on two other tables rather than
-- keys in the bag. Found by the round's blind holdout, not by the issue, whose table lists neither.
--
-- WHAT IS AMBIGUOUS HERE, said once for the whole file. A tenant whose own HTTP tool was named
-- `assign_label` had it moved to `assign_label_N` by 20260903120000, so in THAT tenant prose naming
-- `assign_label` could mean either the old native or their own moved tool. The ambiguity is not
-- special to these two columns: it is exactly as true of `handoff.instructions` and of the
-- `system_prompt` the earlier migration already rewrote blind. So this file resolves it the same way
-- that one did, toward the global one-to-one rename, and the audit line is what makes the choice
-- readable and reversible.

CREATE OR REPLACE FUNCTION pg_temp.renamed(t text) RETURNS text
  LANGUAGE sql IMMUTABLE AS $fn$
    SELECT regexp_replace($1, '\yassign_label\y', 'set_labels', 'g')
  $fn$;

-- The per-argument descriptions, in BOTH stored shapes. `input_schema` is normally the compact map
-- `{ <field>: { type, description?, … } }`, but a legacy row can hold standard JSON Schema
-- (`{ type, required, properties: { <field>: { description? } } }`), which the runtime still
-- supports: `normalizeToolShapes` converts it on read and `compactFromJsonSchema` copies the
-- property's `description` across verbatim, so the model receives it either way. Measured in review
-- round 2 of PR #687 by building the zod schema from a legacy row and reading the description back
-- out of it. A one-level walk would have left every legacy row advertising the old name.
--
-- Both walks run unconditionally, which needs no shape predicate and cannot damage either shape: the
-- nested walk only descends into `properties.<k>` when that value is an OBJECT, so a compact field
-- literally named `properties` (whose sub-values are the strings of its own FieldSpec) is untouched
-- by it, while the top-level walk has already rewritten that field's own description. A `description`
-- that is not a string is left alone in both, and an empty object would make `jsonb_object_agg`
-- return NULL, hence the COALESCE.
CREATE OR REPLACE FUNCTION pg_temp.renamed_descriptions(s jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE
      WHEN jsonb_typeof($1) <> 'object' THEN $1
      ELSE COALESCE(
        (SELECT jsonb_object_agg(
                  e.key,
                  CASE
                    WHEN jsonb_typeof(e.value) = 'object'
                         AND jsonb_typeof(e.value -> 'description') = 'string'
                      THEN jsonb_set(
                             e.value,
                             '{description}',
                             to_jsonb(pg_temp.renamed(e.value #>> '{description}'))
                           )
                    ELSE e.value
                  END)
           FROM jsonb_each($1) AS e),
        $1)
    END
  $fn$;

CREATE OR REPLACE FUNCTION pg_temp.renamed_schema(s jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $fn$
    SELECT CASE
      WHEN jsonb_typeof($1) <> 'object' THEN $1
      -- NESTED FIRST, then the top level over the RESULT. The other order looks equivalent and is
      -- not: `jsonb_set(top_level(x), '{properties}', nested(x -> 'properties'))` replaces the
      -- properties value with a walk of the ORIGINAL, discarding what the top-level walk had already
      -- rewritten there. Measured by the case in the test file that seeds a compact field literally
      -- named `properties`: it came back with the old name.
      WHEN jsonb_typeof($1 -> 'properties') = 'object'
        THEN pg_temp.renamed_descriptions(
               jsonb_set(
                 $1,
                 '{properties}',
                 pg_temp.renamed_descriptions($1 -> 'properties')
               )
             )
      ELSE pg_temp.renamed_descriptions($1)
    END
  $fn$;

DO $$
DECLARE
  r RECORD;
  tbl text;
  new_desc text;
  new_schema jsonb;
  touched text[];
BEGIN
  -- Two tables, one loop, because the work is identical and the only thing that differs is which
  -- table the row came from and what the audit target is called.
  FOR r IN
    SELECT 'tool_definitions' AS src, id, tenant_id, description, input_schema
      FROM "tool_definitions"
     WHERE strpos(COALESCE(description, ''), 'assign_label') > 0
        OR strpos(input_schema::text, 'assign_label') > 0
    UNION ALL
    SELECT 'code_tool_definitions' AS src, id, tenant_id, description, input_schema
      FROM "code_tool_definitions"
     WHERE strpos(COALESCE(description, ''), 'assign_label') > 0
        OR strpos(input_schema::text, 'assign_label') > 0
    ORDER BY src, id
  LOOP
    touched := ARRAY[]::text[];
    new_desc := pg_temp.renamed(r.description);
    new_schema := pg_temp.renamed_schema(r.input_schema);
    IF new_desc IS DISTINCT FROM r.description THEN
      touched := touched || 'description'::text;
    END IF;
    IF new_schema IS DISTINCT FROM r.input_schema THEN
      touched := touched || 'input_schema.*.description'::text;
    END IF;
    -- A row whose only occurrence is glued to a word character changes nothing, and must not be
    -- stamped with a new updated_at for an edit that did not happen.
    CONTINUE WHEN array_length(touched, 1) IS NULL;
    IF r.src = 'tool_definitions' THEN
      UPDATE "tool_definitions"
         SET description = new_desc, input_schema = new_schema, updated_at = NOW()
       WHERE id = r.id;
      tbl := 'tool';
    ELSE
      UPDATE "code_tool_definitions"
         SET description = new_desc, input_schema = new_schema, updated_at = NOW()
       WHERE id = r.id;
      tbl := 'code_tool';
    END IF;
    INSERT INTO "audit_logs" (
      tenant_id, actor_id, actor_type, action, target, "before", "after", created_at
    ) VALUES (
      r.tenant_id, NULL, 'system', 'tool.text_renamed_tool', tbl || ':' || r.id,
      NULL,
      jsonb_build_object(
        'tool', 'assign_label',
        'renamed', 'set_labels',
        'paths', to_jsonb(touched)
      ),
      NOW()
    );
  END LOOP;
END $$;

ALTER TABLE "code_tool_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;

COMMIT;
