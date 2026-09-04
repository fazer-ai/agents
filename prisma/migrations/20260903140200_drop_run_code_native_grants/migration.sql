-- `run_code` was a native tool on main between 2026-09-03 (PR #485) and the code tools of issue
-- #363; no release carried it. A native allowlist that names it would now be refused on its next
-- save (the agent service refuses a name outside the catalog), and the Tools tab re-sends the
-- stored list, so the row is repaired here rather than left to fail at the keyboard.
--
-- Data migration over a FORCE RLS table: lifted for the statement and restored after it
-- (.claude/rules/prisma.md). The write is idempotent.
ALTER TABLE "agent_tool_selections" NO FORCE ROW LEVEL SECURITY;
UPDATE "agent_tool_selections"
   SET "enabled_tools" = array_remove("enabled_tools", 'run_code'),
       "updated_at" = NOW()
 WHERE "source" = 'NATIVE'
   AND 'run_code' = ANY("enabled_tools");
ALTER TABLE "agent_tool_selections" FORCE ROW LEVEL SECURITY;
