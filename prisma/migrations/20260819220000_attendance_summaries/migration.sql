-- AlterEnum
ALTER TYPE "SchedulerJobKind" ADD VALUE 'MEMORY_COMPACT';

-- CreateTable
CREATE TABLE "attendance_summaries" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "chatwoot_instance_id" BIGINT NOT NULL,
    "contact_inbox_id" INTEGER NOT NULL,
    "conversation_id" INTEGER NOT NULL,
    "last_message_id" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "message_count" INTEGER NOT NULL,
    "attendance_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "attendance_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "attendance_summaries_tenant_id_chatwoot_instance_id_contact_idx" ON "attendance_summaries"("tenant_id", "chatwoot_instance_id", "contact_inbox_id");

-- CreateIndex
CREATE UNIQUE INDEX "attendance_summaries_tenant_id_chatwoot_instance_id_contact_key" ON "attendance_summaries"("tenant_id", "chatwoot_instance_id", "contact_inbox_id", "conversation_id", "last_message_id");

-- AddForeignKey
ALTER TABLE "attendance_summaries" ADD CONSTRAINT "attendance_summaries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attendance_summaries" ADD CONSTRAINT "attendance_summaries_chatwoot_instance_id_fkey" FOREIGN KEY ("chatwoot_instance_id") REFERENCES "chatwoot_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant fence every tenant-scoped table carries (see 20260727000000_init).
ALTER TABLE "attendance_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "attendance_summaries" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "attendance_summaries"
  USING (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );
