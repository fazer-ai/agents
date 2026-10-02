-- Phase 3 "grey rails" outreach: controlled, opt-in sends from the operator's
-- own secondary/personal accounts. Both tables are tenant-scoped, so each gets
-- ENABLE/FORCE ROW LEVEL SECURITY plus the policy pair (tenant_isolation +
-- fleet_super_admin) in the same transaction that creates it.
--
-- Design invariants this schema exists to enforce:
--   * every job starts QUEUED and only an operator approval makes it sendable
--     (the worker claims APPROVED only, never QUEUED);
--   * (tenant_id, lead_id, account_id, kind) is unique, so the same lead can
--     never be double-messaged the same way from the same account;
--   * the account row carries the rate controls (daily_cap / sent_today /
--     sent_today_date / cooldown_min / last_sent_at) the worker enforces
--     atomically before each send.
BEGIN;

-- CreateEnum
CREATE TYPE "OutreachAccountStatus" AS ENUM ('ACTIVE', 'PAUSED', 'BANNED');

-- CreateEnum
CREATE TYPE "OutreachJobKind" AS ENUM ('GROUP_COMMENT', 'FRIEND_REQUEST', 'DM');

-- CreateEnum
CREATE TYPE "OutreachJobStatus" AS ENUM ('QUEUED', 'APPROVED', 'SENDING', 'READY_FOR_MANUAL', 'SENT', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "outreach_accounts" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "credential_ref" TEXT,
    "transport" TEXT NOT NULL DEFAULT 'manual',
    "daily_cap" INTEGER NOT NULL DEFAULT 20,
    "sent_today" INTEGER NOT NULL DEFAULT 0,
    "sent_today_date" DATE,
    "cooldown_min" INTEGER NOT NULL DEFAULT 10,
    "last_sent_at" TIMESTAMP(3),
    "status" "OutreachAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreach_jobs" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "lead_id" BIGINT NOT NULL,
    "kind" "OutreachJobKind" NOT NULL,
    "body" TEXT NOT NULL,
    "status" "OutreachJobStatus" NOT NULL DEFAULT 'QUEUED',
    "scheduled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreach_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outreach_accounts_tenant_id_platform_handle_key" ON "outreach_accounts"("tenant_id", "platform", "handle");

-- CreateIndex
CREATE INDEX "outreach_accounts_tenant_id_status_idx" ON "outreach_accounts"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "outreach_jobs_tenant_id_lead_id_account_id_kind_key" ON "outreach_jobs"("tenant_id", "lead_id", "account_id", "kind");

-- CreateIndex
CREATE INDEX "outreach_jobs_tenant_id_status_scheduled_at_idx" ON "outreach_jobs"("tenant_id", "status", "scheduled_at");

-- CreateIndex
CREATE INDEX "outreach_jobs_account_id_idx" ON "outreach_jobs"("account_id");

-- CreateIndex
CREATE INDEX "outreach_jobs_lead_id_idx" ON "outreach_jobs"("lead_id");

-- AddForeignKey
ALTER TABLE "outreach_accounts" ADD CONSTRAINT "outreach_accounts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_jobs" ADD CONSTRAINT "outreach_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_jobs" ADD CONSTRAINT "outreach_jobs_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "outreach_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreach_jobs" ADD CONSTRAINT "outreach_jobs_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (see 20260917180000).
ALTER TABLE "outreach_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_accounts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outreach_accounts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "outreach_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outreach_jobs" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "outreach_jobs"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "outreach_accounts" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "outreach_jobs" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
