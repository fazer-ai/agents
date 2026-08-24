-- Documents replace the half-built quotes subsystem: a tenant-authored template plus the documents
-- issued from it. `quotes` is dropped rather than retired — the feature had no UI, no agent-side
-- generation and no way to deliver what it rendered, so nothing was operating on those rows.
--
-- NOTE: no `SET app.is_super_admin` here. RLS filters DML, not DDL; the escape hatch belongs to a
-- migration that moves DATA across a tenant-scoped table, which this one does not.

-- DropTable (the type goes after the column that still references it)
--
-- DROPPED, not archived, and that is a decision rather than an oversight: `quotes` had no UI, no
-- agent-side generation and no way to deliver what it rendered, so nothing in the product was
-- operating on those rows. An installation that scripted `POST /v1/quotes` itself is the case this
-- destroys, and it is announced as a breaking change in the PR rather than smuggled through —
-- keeping the table alive would mean carrying its RLS policy, its FK and the QuoteStatus enum
-- through a deprecation nobody is consuming.
DROP TABLE "quotes";
DROP TYPE "QuoteStatus";

-- CreateTable
CREATE TABLE "document_templates" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "blocks" JSONB NOT NULL DEFAULT '[]',
    "fields" JSONB NOT NULL DEFAULT '[]',
    "style" JSONB NOT NULL DEFAULT '{}',
    "last_number" INTEGER NOT NULL DEFAULT 0,
    "number_prefix" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "issued_documents" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "template_id" BIGINT,
    "title" TEXT NOT NULL,
    "number" INTEGER,
    "number_prefix" TEXT,
    "thread_id" TEXT,
    "chatwoot_instance_id" BIGINT,
    "conversation_id" BIGINT,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "pdf_storage_key" TEXT,
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "issued_documents_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "agent_tool_selections" ADD COLUMN "document_template_id" BIGINT;

-- CreateIndex
CREATE UNIQUE INDEX "document_templates_tenant_id_slug_key" ON "document_templates"("tenant_id", "slug");

-- CreateIndex
-- The NAME is unique per tenant too, and separately from the slug: the name is what the model reads
-- to choose between the document tools an agent holds, and a caller supplying its own slug would
-- otherwise get two templates with one name and two indistinguishable tools.
CREATE UNIQUE INDEX "document_templates_tenant_id_name_key" ON "document_templates"("tenant_id", "name");

-- CreateIndex
CREATE INDEX "document_templates_tenant_id_idx" ON "document_templates"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "issued_documents_tenant_id_idempotency_key_key" ON "issued_documents"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "issued_documents_tenant_id_idx" ON "issued_documents"("tenant_id");

-- CreateIndex
CREATE INDEX "issued_documents_tenant_id_thread_id_idx" ON "issued_documents"("tenant_id", "thread_id");

-- CreateIndex
CREATE INDEX "issued_documents_tenant_id_template_id_idx" ON "issued_documents"("tenant_id", "template_id");

-- AddForeignKey
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "issued_documents" ADD CONSTRAINT "issued_documents_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "document_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_tool_selections" ADD CONSTRAINT "agent_tool_selections_document_template_id_fkey" FOREIGN KEY ("document_template_id") REFERENCES "document_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The grant table's own invariant: exactly the target matching `source` is set. A new source has to
-- be added to BOTH sides of it — its own arm, and the IS NULL list of every other arm — or a
-- DOCUMENT grant is refused while an HTTP grant is free to carry a stray template id. Nothing in the
-- TypeScript would report either.
ALTER TABLE "agent_tool_selections" DROP CONSTRAINT "agent_tool_selection_source_target_check";
ALTER TABLE "agent_tool_selections" ADD CONSTRAINT "agent_tool_selection_source_target_check" CHECK (
  ("source" = 'HTTP'        AND "tool_definition_id" IS NOT NULL AND "mcp_server_connection_id" IS NULL AND "integration_instance_id" IS NULL AND "document_template_id" IS NULL)
  OR ("source" = 'MCP'         AND "mcp_server_connection_id" IS NOT NULL AND "tool_definition_id" IS NULL AND "integration_instance_id" IS NULL AND "document_template_id" IS NULL)
  OR ("source" = 'INTEGRATION' AND "integration_instance_id" IS NOT NULL AND "tool_definition_id" IS NULL AND "mcp_server_connection_id" IS NULL AND "document_template_id" IS NULL)
  OR ("source" = 'DOCUMENT'    AND "document_template_id" IS NOT NULL AND "tool_definition_id" IS NULL AND "mcp_server_connection_id" IS NULL AND "integration_instance_id" IS NULL)
  OR ("source" IN ('NATIVE','RAG') AND "tool_definition_id" IS NULL AND "mcp_server_connection_id" IS NULL AND "integration_instance_id" IS NULL AND "document_template_id" IS NULL)
);

-- One grant per (agent, template), like the other per-target sources.
CREATE UNIQUE INDEX "ats_document_uq" ON "agent_tool_selections" ("agent_id", "document_template_id") WHERE "source" = 'DOCUMENT';

-- RLS: same tenant fence every tenant-scoped table carries (see 20260727000000_init). BOTH tables —
-- a new table without the policy is readable across tenants and nothing in the app would say so.
ALTER TABLE "document_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_templates" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "document_templates"
  USING (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );

ALTER TABLE "issued_documents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "issued_documents" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "issued_documents"
  USING (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );
