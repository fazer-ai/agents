-- The version of the newest stated null redirect pairing that did not count as an answer (issue
-- #1281). Nullable with no default, so the ALTER only touches the catalog.
ALTER TABLE "conversations" ADD COLUMN "chatwoot_redirect_origin_cleared_at" DOUBLE PRECISION;
