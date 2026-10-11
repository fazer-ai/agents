-- The contact's and the inbox's own Chatwoot version as of the values the mirror stored (issue
-- #1282). Nullable with no default, so the ALTER only touches the catalog; a row without one keeps the
-- position rule until the first payload carrying the row's clock stamps it.
ALTER TABLE "contacts" ADD COLUMN "custom_attributes_clock" DOUBLE PRECISION;
ALTER TABLE "inboxes" ADD COLUMN "metadata_clock" DOUBLE PRECISION;
