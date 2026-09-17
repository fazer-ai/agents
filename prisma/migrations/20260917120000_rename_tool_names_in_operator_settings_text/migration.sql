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
-- that knows where that text lives). SIX of those twelve reach a model that has tools, and those
-- six are what this file rewrites:
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
-- DELIBERATELY NOT REWRITTEN, and the reason is the same for the first group: the text is read by a
-- PERSON, not by a model, and `set_labels` means no more to a customer than `assign_label` did. The
-- rename would change a message a customer reads and fix nothing.
--
--   availability.awayMessage, contactAuth.denyMessage,
--   guardrails.input.templateMessage, guardrails.output.templateMessage, signature.text
--
-- And `vision.extractionPrompt` is out for a different reason: it is the instruction sent to the
-- vision model, which is handed no tools at all (`src/modules/vision/service.ts`), so a tool name in
-- it names nothing in either spelling.
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
  -- The prefilter is on the whole bag as text, which is cheap and over-inclusive: a row it selects
  -- may carry the old name only in a field this migration leaves alone, and then `touched` comes
  -- back empty and nothing is written. What it must not do is MISS a row, which is why it asks the
  -- bag rather than the six paths.
  FOR r IN
    SELECT id, tenant_id, settings FROM "agents" WHERE settings::text ~ '\yassign_label\y'
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
          -- Through `format()`, and not as a bare literal: on the right of `text[] ||` an untyped
          -- literal containing `[]` is parsed as an ARRAY LITERAL, and the migration dies with
          -- "malformed array literal" (measured while mutating this line).
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

ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;

COMMIT;
