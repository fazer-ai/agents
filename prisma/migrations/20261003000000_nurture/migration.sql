-- Nurture sequences: operator-authored follow-up step lists (nurture_sequences),
-- per-lead enrollments (nurture_enrollments) and the human-executed outbox the
-- drain renders into (nurture_outbox). All three tables are tenant-scoped, so
-- each gets ENABLE/FORCE ROW LEVEL SECURITY plus the policy pair in the same
-- transaction that creates it. Also adds the NURTURE_DRAIN scheduler job kind:
-- ALTER TYPE ... ADD VALUE may run inside a transaction on Postgres 12+, the
-- new value just cannot be USED until commit, and this migration never uses it.
BEGIN;

-- CreateEnum
CREATE TYPE "NurtureEnrollmentStatus" AS ENUM ('ACTIVE', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "NurtureOutboxStatus" AS ENUM ('PENDING', 'SENT', 'CANCELLED');

-- AlterEnum
ALTER TYPE "SchedulerJobKind" ADD VALUE 'NURTURE_DRAIN';

-- CreateTable
CREATE TABLE "nurture_sequences" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nurture_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nurture_enrollments" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "sequence_id" BIGINT NOT NULL,
    "lead_id" BIGINT NOT NULL,
    "step_index" INTEGER NOT NULL DEFAULT 0,
    "next_run_at" TIMESTAMP(3) NOT NULL,
    "status" "NurtureEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nurture_enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nurture_outbox" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "enrollment_id" BIGINT NOT NULL,
    "lead_id" BIGINT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "NurtureOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "nurture_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "nurture_sequences_tenant_id_idx" ON "nurture_sequences"("tenant_id");

-- CreateIndex
CREATE INDEX "nurture_enrollments_tenant_id_status_next_run_at_idx" ON "nurture_enrollments"("tenant_id", "status", "next_run_at");

-- CreateIndex
CREATE INDEX "nurture_enrollments_lead_id_idx" ON "nurture_enrollments"("lead_id");

-- CreateIndex: ONE ACTIVE enrollment per (tenant, sequence, lead). Partial, so
-- DONE/CANCELLED history rows never collide with a re-enroll; hand-written
-- because Prisma cannot model a WHERE on an index.
CREATE UNIQUE INDEX "nurture_enrollments_active_key" ON "nurture_enrollments"("tenant_id", "sequence_id", "lead_id") WHERE status = 'ACTIVE'::"NurtureEnrollmentStatus";

-- CreateIndex
CREATE INDEX "nurture_outbox_tenant_id_status_idx" ON "nurture_outbox"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "nurture_outbox_enrollment_id_idx" ON "nurture_outbox"("enrollment_id");

-- AddForeignKey
ALTER TABLE "nurture_sequences" ADD CONSTRAINT "nurture_sequences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurture_enrollments" ADD CONSTRAINT "nurture_enrollments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurture_enrollments" ADD CONSTRAINT "nurture_enrollments_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "nurture_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurture_enrollments" ADD CONSTRAINT "nurture_enrollments_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurture_outbox" ADD CONSTRAINT "nurture_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurture_outbox" ADD CONSTRAINT "nurture_outbox_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "nurture_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "nurture_outbox" ADD CONSTRAINT "nurture_outbox_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (see 20260917180000).
ALTER TABLE "nurture_sequences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nurture_sequences" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "nurture_sequences"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "nurture_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nurture_enrollments" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "nurture_enrollments"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "nurture_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "nurture_outbox" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "nurture_outbox"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "nurture_sequences" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "nurture_enrollments" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "nurture_outbox" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
