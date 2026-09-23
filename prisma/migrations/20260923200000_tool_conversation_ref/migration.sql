-- `{{conversation_ref}}` (issue #818): an HTTP tool names the GENERIC integration instance it hands
-- the conversation's handle for. Nullable and additive: every existing tool declares nothing, and a
-- tool whose templates never use the variable never needs it. SET NULL on the instance's deletion,
-- so a tool pointing at a deleted instance refuses to run rather than sending a dead handle.
--
-- NOTE: no RLS bypass here. RLS filters DML, not DDL; nothing in this file moves data across a
-- tenant-scoped table.

-- AlterTable
ALTER TABLE "tool_definitions" ADD COLUMN "conversation_ref_integration_id" BIGINT;

-- CreateIndex
-- The SET NULL on the instance's deletion scans for referencing rows; without an index that is a
-- sequential scan of every tenant's tools under the delete's lock.
CREATE INDEX "tool_definitions_conversation_ref_integration_id_idx" ON "tool_definitions"("conversation_ref_integration_id");

-- AddForeignKey
ALTER TABLE "tool_definitions" ADD CONSTRAINT "tool_definitions_conversation_ref_integration_id_fkey" FOREIGN KEY ("conversation_ref_integration_id") REFERENCES "integration_instances"("id") ON DELETE SET NULL ON UPDATE CASCADE;
