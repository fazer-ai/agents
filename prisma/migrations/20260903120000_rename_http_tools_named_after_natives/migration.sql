-- An HTTP tool named after a native tool never reaches the model: the assembly reserves every
-- native name, granted or not (src/graph/tools/unique-names.ts, #457), and drops the other claimant
-- with a flow-log line as the only trace. The service now refuses such a name where it is typed and
-- the import renames a bundled tool that carries one; this moves the rows written before either
-- check existed, to the first free `<name>_N` in their own tenant, the same rule the import applies.
-- The grant references the row by id and follows it. The label, which is what the console shows,
-- is untouched. The list is the catalog at the time of writing (src/graph/tools/catalog.ts); a
-- name added later ships with its own file of this name, which
-- tests/prisma/native-tool-names-renamed-by-migration.test.ts asks for.
--
-- FORCE ROW LEVEL SECURITY binds the table owner too, so the owner's UPDATE would reach zero rows
-- and report success; lifted for the file and put back (.claude/rules/prisma.md).
ALTER TABLE "tool_definitions" NO FORCE ROW LEVEL SECURITY;

DO $$
DECLARE
  r RECORD;
  candidate TEXT;
  n INTEGER;
BEGIN
  FOR r IN
    SELECT id, tenant_id, name
    FROM "tool_definitions"
    WHERE name IN (
      'handoff_to_human', 'private_note', 'set_custom_attribute', 'assign_label',
      'resolve_conversation', 'kanban_move_card', 'update_kanban_task', 'set_voice_preference',
      'react_to_message', 'send_image', 'skip_reply', 'calculator', 'get_current_time', 'run_code'
    )
    ORDER BY id
  LOOP
    n := 2;
    LOOP
      candidate := r.name || '_' || n;
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM "tool_definitions" WHERE tenant_id = r.tenant_id AND name = candidate
      );
      n := n + 1;
    END LOOP;
    UPDATE "tool_definitions" SET name = candidate, updated_at = NOW() WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE "tool_definitions" FORCE ROW LEVEL SECURITY;
