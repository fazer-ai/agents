-- Whether a theme is a critical subject for the business (docs/occurrences.md, "Critical themes"):
-- the model's judgment, null until judged, and the digest of the critical list and business context it
-- was judged by. A mark whose basis is not the monitor's now reads as not judged, so a change to the
-- list needs no write to the themes. Existing themes start unjudged, and the next round of their
-- monitor judges the open ones.
ALTER TABLE "occurrence_themes" ADD COLUMN "critical" BOOLEAN;
ALTER TABLE "occurrence_themes" ADD COLUMN "critical_basis" TEXT;
