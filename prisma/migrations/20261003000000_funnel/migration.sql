-- Funnel (phase 2): human-in-the-loop outreach. reply_drafts holds the
-- per-lead reply/DM drafts a person reviews before copying out; broadcasts +
-- broadcast_recipients are the composer rail for one-to-many messages. Every
-- table is tenant-scoped, so each gets ENABLE/FORCE ROW LEVEL SECURITY plus the
-- policy pair (tenant_isolation + fleet_super_admin) in the same transaction
-- that creates it (same shape as 20261001200239_merchant_mvp).
BEGIN;

-- CreateEnum
CREATE TYPE "ReplyDraftKind" AS ENUM ('PUBLIC_REPLY', 'DM_OPENER');

-- CreateEnum
CREATE TYPE "ReplyDraftStatus" AS ENUM ('DRAFT', 'APPROVED', 'SENT', 'REJECTED');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT', 'READY', 'SENT');

-- CreateEnum
CREATE TYPE "BroadcastRecipientStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "reply_drafts" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "lead_id" BIGINT NOT NULL,
    "kind" "ReplyDraftKind" NOT NULL,
    "body" TEXT NOT NULL,
    "status" "ReplyDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_by" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reply_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcasts" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience_filter" JSONB NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "sent_count" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMP(3),
    "created_by" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broadcast_recipients" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "broadcast_id" BIGINT NOT NULL,
    "lead_id" BIGINT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "BroadcastRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reply_drafts_tenant_id_lead_id_idx" ON "reply_drafts"("tenant_id", "lead_id");

-- CreateIndex
CREATE INDEX "broadcasts_tenant_id_created_at_idx" ON "broadcasts"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "broadcast_recipients_tenant_id_broadcast_id_idx" ON "broadcast_recipients"("tenant_id", "broadcast_id");

-- CreateIndex
CREATE UNIQUE INDEX "broadcast_recipients_broadcast_id_lead_id_key" ON "broadcast_recipients"("broadcast_id", "lead_id");

-- AddForeignKey
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_drafts" ADD CONSTRAINT "reply_drafts_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey" FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the policy pair every tenant-scoped table carries (see 20260917180000).
ALTER TABLE "reply_drafts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reply_drafts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "reply_drafts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "broadcasts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "broadcasts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "broadcasts"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

ALTER TABLE "broadcast_recipients" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "broadcast_recipients" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "broadcast_recipients"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "reply_drafts" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "broadcasts" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "broadcast_recipients" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

COMMIT;
