-- One version mark per conversation relation (issue #1291). Nullable with no default, so the ALTER
-- only touches the catalog; a row without a mark keeps the recency rule for that relation until the
-- first versioned payload naming it stamps it.
ALTER TABLE "conversations"
  ADD COLUMN "chatwoot_contact_at" DOUBLE PRECISION,
  ADD COLUMN "chatwoot_contact_inbox_at" DOUBLE PRECISION,
  ADD COLUMN "chatwoot_inbox_at" DOUBLE PRECISION;
