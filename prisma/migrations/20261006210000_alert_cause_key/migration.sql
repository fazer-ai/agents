-- AlterTable
ALTER TABLE "alert_deliveries" ADD COLUMN "cause_key" TEXT;

-- CreateIndex
CREATE INDEX "alert_deliveries_channel_id_cause_key_created_at_idx" ON "alert_deliveries"("channel_id", "cause_key", "created_at");
