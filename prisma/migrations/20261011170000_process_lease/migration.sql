-- WHICH PROCESS CLAIMED A DELIVERY, AND WHETHER IT IS STILL ALIVE (issue #1298). A Chatwoot delivery
-- whose claimer died without draining (`kill -9`, OOM, a host crash, a drain bound that ran out) sat
-- PROCESSING until the stranded sweep's 30-minute window, because nothing told a dead claimer from a
-- slow live one. Each process now renews a row here, and the claim records whose it was.
--
-- Not tenant data: no tenant_id and no RLS, like `users`. The runtime role reaches it through the
-- default privileges the bootstrap grants on every table this role creates.
CREATE TABLE IF NOT EXISTS "process_leases" (
    "id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heartbeat_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "host" TEXT,
    "pid" INTEGER,

    CONSTRAINT "process_leases_pkey" PRIMARY KEY ("id")
);

-- Nullable with no default, so a catalog change that does not rewrite the table. The previous release
-- keeps claiming without it during a rolling deploy, and its rows keep the 30-minute window. The pass
-- that reads it filters `status = 'PROCESSING'`, which the partial `chatwoot_webhook_deliveries_sweep_idx`
-- (PENDING and PROCESSING rows only) already serves, so no index of its own.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN IF NOT EXISTS "claimed_by" UUID;
