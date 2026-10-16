-- Additive and nullable: a row the previous release writes during the rolling deploy simply leaves
-- them NULL, which reads as "never reported".
ALTER TABLE "inboxes"
  ADD COLUMN "provider_connection" TEXT,
  ADD COLUMN "provider_connection_at" TIMESTAMPTZ(6);
