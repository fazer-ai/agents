-- Who owns a booking, stored beside its id (issue #352).
--
-- A tool definition can now declare that its own response describes an appointment, so the two
-- things `external_id` alone used to imply are no longer implied: that the id identifies the booking
-- within the tenant, and that the Google Calendar tools can reach it. Two operator systems can both
-- count from 1, and neither answers to calendar_cancel_event.
--
-- DEFAULT 'google_calendar' is what makes this a pure widening: every row written before this (the
-- 20260826220000 backfill included) IS a Calendar event, and keeps both the identity and the
-- operability it was written with.
ALTER TABLE "appointments" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'google_calendar';

-- The record's key gains its other half. Dropping the old index first keeps the table with exactly
-- one uniqueness rule at every instant, rather than briefly enforcing the narrower one as well.
DROP INDEX "appointments_tenant_id_external_id_key";
CREATE UNIQUE INDEX "appointments_tenant_id_provider_external_id_key" ON "appointments"("tenant_id", "provider", "external_id");
