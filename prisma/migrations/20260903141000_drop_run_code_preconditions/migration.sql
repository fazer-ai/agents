-- A precondition (#101) is keyed by TOOL NAME, and the seam that applies it is deliberately
-- source-agnostic: one map reaches native, HTTP, code, document, MCP and toolpack tools, because
-- they have already been merged into one name-unique list by the time it runs
-- (graph/prepare.ts, and the note above `emptyMap` in modules/agents/tool-preconditions.ts).
--
-- That is right for every case except this one. `run_code` was a native tool on main between
-- PR #485 and the code tools of issue #363, and only a NATIVE name can be guarded at the write
-- boundary (`isGuardableToolName`), so an operator on that window could have written
-- `settings.toolPreconditions.run_code` against the native. The native is gone, which leaves the
-- rule inert -- and the next migration puts an HTTP tool BACK under the name it was moved off.
-- Without this, that rule would silently start guarding a tool nobody wrote it for: the operator
-- would see calls refused by a condition they configured for something else entirely, and nothing
-- on screen would connect the two.
--
-- Runs BEFORE the restore (20260903150000), and the order is the whole argument for deleting the
-- key unconditionally. At this instant no tool_definitions row can be named `run_code`: the earlier
-- upgrade (20260903120000) moved every one of them to `<name>_N` when the native took the name. So
-- every `toolPreconditions.run_code` in the database right now was written against the native, or
-- is already inert -- there is no third kind to preserve. After the restore that stops being true,
-- which is exactly why this does not run after it.
--
-- Data migration over a FORCE RLS table: lifted for the statement and restored after it
-- (.claude/rules/prisma.md). The write is idempotent: a second run matches no row.
ALTER TABLE "agents" NO FORCE ROW LEVEL SECURITY;
UPDATE "agents"
   SET "settings" = jsonb_set(
         "settings",
         '{toolPreconditions}',
         ("settings" -> 'toolPreconditions') - 'run_code'),
       "updated_at" = NOW()
 WHERE jsonb_typeof("settings" -> 'toolPreconditions') = 'object'
   AND ("settings" -> 'toolPreconditions') ? 'run_code';
ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;
