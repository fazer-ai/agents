-- Operator-authored code tools (issue #363): a JavaScript function body the agent calls with typed
-- arguments, run in the sandbox. The row is the OPERATOR's — name, description, input schema and
-- the body — and the model only ever supplies arguments. Sibling of tool_definitions (HTTP tools)
-- with its own table because none of an HTTP tool's columns (method, URL, hosts, headers, statuses)
-- describes it; the two share the name namespace the model reads, checked in the service.
--
-- NOTE: no RLS bypass here. RLS filters DML, not DDL; nothing in this file moves data across a
-- tenant-scoped table.

-- CreateTable
CREATE TABLE "code_tool_definitions" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "input_schema" JSONB NOT NULL DEFAULT '{}',
    "code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_tool_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- The name is what the model calls; one per tenant. The unique index is also the tenant-led index
-- (no bare tenant_id index beside it: #373).
CREATE UNIQUE INDEX "code_tool_definitions_tenant_id_name_key" ON "code_tool_definitions"("tenant_id", "name");

-- AddForeignKey
ALTER TABLE "code_tool_definitions" ADD CONSTRAINT "code_tool_definitions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "agent_tool_selections" ADD COLUMN "code_tool_definition_id" BIGINT;

-- AddForeignKey
ALTER TABLE "agent_tool_selections" ADD CONSTRAINT "agent_tool_selections_code_tool_definition_id_fkey" FOREIGN KEY ("code_tool_definition_id") REFERENCES "code_tool_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The grant table's own invariant: exactly the target matching `source` is set. A new source goes
-- on BOTH sides of it — its own arm, and the IS NULL list of every other arm (20260822220000).
ALTER TABLE "agent_tool_selections" DROP CONSTRAINT "agent_tool_selection_source_target_check";
ALTER TABLE "agent_tool_selections" ADD CONSTRAINT "agent_tool_selection_source_target_check" CHECK (
  ("source" = 'HTTP'        AND "tool_definition_id" IS NOT NULL AND "mcp_server_connection_id" IS NULL AND "integration_instance_id" IS NULL AND "document_template_id" IS NULL AND "code_tool_definition_id" IS NULL)
  OR ("source" = 'MCP'         AND "mcp_server_connection_id" IS NOT NULL AND "tool_definition_id" IS NULL AND "integration_instance_id" IS NULL AND "document_template_id" IS NULL AND "code_tool_definition_id" IS NULL)
  OR ("source" = 'INTEGRATION' AND "integration_instance_id" IS NOT NULL AND "tool_definition_id" IS NULL AND "mcp_server_connection_id" IS NULL AND "document_template_id" IS NULL AND "code_tool_definition_id" IS NULL)
  OR ("source" = 'DOCUMENT'    AND "document_template_id" IS NOT NULL AND "tool_definition_id" IS NULL AND "mcp_server_connection_id" IS NULL AND "integration_instance_id" IS NULL AND "code_tool_definition_id" IS NULL)
  OR ("source" = 'CODE'        AND "code_tool_definition_id" IS NOT NULL AND "tool_definition_id" IS NULL AND "mcp_server_connection_id" IS NULL AND "integration_instance_id" IS NULL AND "document_template_id" IS NULL)
  OR ("source" IN ('NATIVE','RAG') AND "tool_definition_id" IS NULL AND "mcp_server_connection_id" IS NULL AND "integration_instance_id" IS NULL AND "document_template_id" IS NULL AND "code_tool_definition_id" IS NULL)
);

-- One grant per (agent, code tool), like the other per-target sources.
CREATE UNIQUE INDEX "ats_code_uq" ON "agent_tool_selections" ("agent_id", "code_tool_definition_id") WHERE "source" = 'CODE';

-- RLS: the tenant fence every tenant-scoped table carries, in the shape every table has since
-- 20260827000000_rls_split_tenant_and_fleet_policies — the tenant policy on app.tenant_id alone,
-- and the fleet path as its own policy granted to the fleet role (resolved by name at run time,
-- since the role is per installation).
ALTER TABLE "code_tool_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "code_tool_definitions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "code_tool_definitions"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format($f$
    CREATE POLICY fleet_super_admin ON "code_tool_definitions" TO %I USING (true) WITH CHECK (true)
  $f$, v_fleet);
END $$;
