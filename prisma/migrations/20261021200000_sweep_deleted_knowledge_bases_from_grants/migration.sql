-- A RAG grant names its bases in an array no foreign key covers. deleteKnowledgeBase takes the base
-- out of every grant; a base deleted before it did left its id behind, and the agent's set is then
-- refused on its next write with nothing on screen to untick. This takes those ids out, keeping the
-- order of the rest. An id naming another tenant's base is as dangling as a deleted one. An empty
-- list searches every base of the tenant, so a grant whose every id dangles is removed (the agent
-- stops searching) rather than emptied (it would search everything). A grant already empty is left
-- alone: no id of it dangles.
--
-- RLS: a data migration lifts FORCE on every forced table it writes or reads and restores it
-- (.claude/rules/prisma.md, tests/prisma/migration-rls-bypass.test.ts).
BEGIN;
ALTER TABLE "agent_tool_selections" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "knowledge_bases" NO FORCE ROW LEVEL SECURITY;
DELETE FROM "agent_tool_selections" s
 WHERE s.source = 'RAG'
   AND cardinality(s."knowledge_base_ids") > 0
   AND NOT EXISTS (
         SELECT 1 FROM unnest(s."knowledge_base_ids") AS k(id)
           JOIN "knowledge_bases" b ON b.id = k.id AND b.tenant_id = s.tenant_id);
UPDATE "agent_tool_selections" s
   SET "knowledge_base_ids" = ARRAY(
         SELECT k.id
           FROM unnest(s."knowledge_base_ids") WITH ORDINALITY AS k(id, n)
          WHERE EXISTS (
                  SELECT 1 FROM "knowledge_bases" b
                   WHERE b.id = k.id AND b.tenant_id = s.tenant_id)
          ORDER BY k.n)
 WHERE s.source = 'RAG'
   AND EXISTS (
         SELECT 1 FROM unnest(s."knowledge_base_ids") AS k(id)
          WHERE NOT EXISTS (
                  SELECT 1 FROM "knowledge_bases" b
                   WHERE b.id = k.id AND b.tenant_id = s.tenant_id));
ALTER TABLE "knowledge_bases" FORCE ROW LEVEL SECURITY;
ALTER TABLE "agent_tool_selections" FORCE ROW LEVEL SECURITY;
COMMIT;
