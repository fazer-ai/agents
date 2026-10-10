-- Approval before a document is issued (issue #1137, design on #1077). Wrapped in a transaction: a
-- failure between the CREATE TABLE and the FORCE ROW LEVEL SECURITY below would leave a
-- tenant-scoped table that does not bind its own owner (.claude/rules/prisma.md).
BEGIN;

-- AlterTable
ALTER TABLE "document_templates" ADD COLUMN     "approval_ttl_hours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "requires_approval" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "document_approval_requests" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "template_id" BIGINT,
    "title" TEXT NOT NULL,
    "number_prefix" TEXT,
    "thread_id" TEXT,
    "chatwoot_instance_id" BIGINT,
    "conversation_id" BIGINT,
    "idempotency_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "reviewer_user_id" BIGINT,
    "note" TEXT,
    "decided_at" TIMESTAMP(3),
    "issued_document_id" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_approval_requests_issued_document_id_key" ON "document_approval_requests"("issued_document_id");

-- CreateIndex
CREATE INDEX "document_approval_requests_tenant_id_status_expires_at_idx" ON "document_approval_requests"("tenant_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "document_approval_requests_tenant_id_template_id_idx" ON "document_approval_requests"("tenant_id", "template_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_approval_requests_tenant_id_idempotency_key_key" ON "document_approval_requests"("tenant_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "document_approval_requests" ADD CONSTRAINT "document_approval_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_approval_requests" ADD CONSTRAINT "document_approval_requests_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "document_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_approval_requests" ADD CONSTRAINT "document_approval_requests_issued_document_id_fkey" FOREIGN KEY ("issued_document_id") REFERENCES "issued_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The design's range, 1 hour to 7 days. In the database too, because three transports write it.
ALTER TABLE "document_templates" ADD CONSTRAINT "document_templates_approval_ttl_hours_range" CHECK ("approval_ttl_hours" BETWEEN 1 AND 168);

ALTER TABLE "document_approval_requests" ADD CONSTRAINT "document_approval_requests_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CANCELLED'));

-- RLS: the policy pair every tenant-scoped table carries (tests/lib/rls-policy-shape.test.ts).
ALTER TABLE "document_approval_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "document_approval_requests" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "document_approval_requests"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "document_approval_requests" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
