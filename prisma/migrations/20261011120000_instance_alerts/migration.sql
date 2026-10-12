-- Alert channels and thresholds that belong to the INSTANCE, not to a tenant (docs/logs.md, instance
-- alerts). They carry no tenant_id, so the tenant policy has nothing to match: each table gets RLS
-- with the fleet policy ONLY, and the runtime role reads and writes them only after entering the fleet
-- role (asSuperAdmin). Outside it every query sees zero rows and every write is refused.
-- One transaction: a failure after CREATE TABLE must not leave a table without its policy.
BEGIN;

CREATE TABLE "instance_alert_channels" (
    "id" BIGSERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "url" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "signals" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "secret" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_alert_channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "instance_alert_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "channel_id" BIGINT NOT NULL,
    "signal" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "level" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "last_error" TEXT,
    "unsigned_reason" TEXT,
    "channel_version" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_alert_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "instance_alert_deliveries_status_next_attempt_at_idx" ON "instance_alert_deliveries"("status", "next_attempt_at");
CREATE INDEX "instance_alert_deliveries_channel_id_signal_status_idx" ON "instance_alert_deliveries"("channel_id", "signal", "status");

ALTER TABLE "instance_alert_deliveries" ADD CONSTRAINT "instance_alert_deliveries_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "instance_alert_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "instance_alert_thresholds" (
    "signal" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instance_alert_thresholds_pkey" PRIMARY KEY ("signal")
);

ALTER TABLE "instance_alert_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instance_alert_channels" FORCE ROW LEVEL SECURITY;
ALTER TABLE "instance_alert_deliveries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instance_alert_deliveries" FORCE ROW LEVEL SECURITY;
ALTER TABLE "instance_alert_thresholds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "instance_alert_thresholds" FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  EXECUTE format('CREATE POLICY fleet_super_admin ON "instance_alert_channels" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
  EXECUTE format('CREATE POLICY fleet_super_admin ON "instance_alert_deliveries" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
  EXECUTE format('CREATE POLICY fleet_super_admin ON "instance_alert_thresholds" TO %I USING (true) WITH CHECK (true)', public.fazerai_fleet_role());
END $$;

COMMIT;
