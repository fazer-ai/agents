-- ONE OWNER PER MESSAGE, which `conversations.last_replied_message_id` cannot hold (issue #690).
--
-- That column is a single number, so a turn that answers message 1002 closes 1001 with it — by
-- arithmetic, with nothing having read 1001. Measured 30 of 60 runs on the direct path with debounce
-- off: two deliveries are serialized (issue #658), the newer message's turn takes the thread first
-- having loaded the channel before the older message existed, and the only turn in the system that
-- read BOTH is the one the claim refuses. Nothing reopens the older message afterwards.
--
-- Wrapped in a transaction on purpose: the file leaves an INVARIANT half-applied otherwise, not just
-- half-migrated rows — a failure between the CREATE TABLE and the FORCE ROW LEVEL SECURITY below
-- leaves a tenant-scoped table that does not bind its own owner. See .claude/rules/prisma.md; there
-- is no CONCURRENTLY here, so nothing in this file objects to the block.
BEGIN;

-- CreateEnum
CREATE TYPE "ReplyClaimReason" AS ENUM ('CLAIMED', 'DISPENSED');

-- CreateTable
CREATE TABLE "message_reply_claims" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    -- The MIRROR's row id, the same key the claim is already locked on, never the Chatwoot display
    -- id: message ids are numbered per Chatwoot account, so a tenant with two accounts has two
    -- message 1001s.
    "conversation_id" BIGINT NOT NULL,
    "message_id" INTEGER NOT NULL,
    "reason" "ReplyClaimReason" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reply_claims_pkey" PRIMARY KEY ("id")
);

-- THE DISPENSAL THAT CANNOT NAME ITS MESSAGES. A gate exit decides before any Chatwoot fetch, so it
-- has no ids to insert above — only the two ends it calculated. Kept out of the table above so the
-- unique index there stays a plain index: "one owner per message" over ranges needs an exclusion
-- constraint and btree_gist, which trades a guarantee that comes free for an extension.
CREATE TABLE "reply_dispensals" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    -- Exclusive lower bound, inclusive upper: the shape `retireCoveredDeliveries` already takes, so a
    -- caller holding both ends for one write holds them for the other. NULL lower bound means the
    -- conversation had no watermark, and the dispensal does reach back to the beginning.
    "from_message_id" INTEGER,
    "to_message_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reply_dispensals_pkey" PRIMARY KEY ("id")
);

-- WHERE THE PER-MESSAGE ERA BEGINS ON THIS CONVERSATION, as a VALUE and not as "does this
-- conversation have rows yet". Inferred, it is a trap with a delayed fuse: an old conversation that
-- receives ONE new message gets its first row, joins the era, and every message it already had
-- becomes "above the era with no row", which reads as unanswered. That is the release landing one
-- conversation at a time, weeks apart. NULL means the era has not started here, never zero.
ALTER TABLE "conversations" ADD COLUMN "reply_claim_floor_message_id" INTEGER;

-- CreateIndex
-- THE WHOLE EXCLUSION, and the reason this is a table rather than a column. Claimants insert their
-- ids with ON CONFLICT DO NOTHING and compare the returned count with what they asked for.
CREATE UNIQUE INDEX "message_reply_claims_conversation_id_message_id_key" ON "message_reply_claims"("conversation_id", "message_id");

-- CreateIndex
CREATE INDEX "message_reply_claims_tenant_id_idx" ON "message_reply_claims"("tenant_id");

-- CreateIndex
-- Covering the one question asked of this table: does any range on this conversation contain M.
CREATE INDEX "reply_dispensals_conversation_id_to_message_id_idx" ON "reply_dispensals"("conversation_id", "to_message_id");

-- CreateIndex
CREATE INDEX "reply_dispensals_tenant_id_idx" ON "reply_dispensals"("tenant_id");

-- AddForeignKey
ALTER TABLE "message_reply_claims" ADD CONSTRAINT "message_reply_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reply_claims" ADD CONSTRAINT "message_reply_claims_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_dispensals" ADD CONSTRAINT "reply_dispensals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reply_dispensals" ADD CONSTRAINT "reply_dispensals_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: the POLICY PAIR every tenant-scoped table has carried since
-- 20260827000000_rls_split_tenant_and_fleet_policies, and asserted per table by
-- tests/lib/rls-policy-shape.test.ts. The tenant policy names no role, so a migration never has to
-- know the deployment's app-role name; only the fleet policy does, and it resolves it through
-- `public.fazerai_fleet_role()` rather than hardcoding it.
--
-- NOT the older single-policy shape with `current_setting('app.is_super_admin')`: that GUC is gone
-- from every tenant policy, and the fleet path goes through the role instead.
ALTER TABLE "message_reply_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message_reply_claims" FORCE ROW LEVEL SECURITY;
ALTER TABLE "reply_dispensals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reply_dispensals" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "message_reply_claims"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
CREATE POLICY tenant_isolation ON "reply_dispensals"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

DO $$
DECLARE
  v_fleet name := public.fazerai_fleet_role();
BEGIN
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "message_reply_claims" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
  EXECUTE format(
    'CREATE POLICY fleet_super_admin ON "reply_dispensals" TO %I USING (true) WITH CHECK (true)',
    v_fleet);
END $$;

-- NO BACKFILL, and that is the design rather than an omission. Every conversation alive today has a
-- NULL floor, which means the per-message era has not started on it and today's scalar behaviour
-- keeps answering for it in full. A backfill would have to invent, for each old message, whether it
-- was answered or deliberately skipped — the very distinction the scalar never recorded and this
-- table exists to start recording.
COMMIT;
