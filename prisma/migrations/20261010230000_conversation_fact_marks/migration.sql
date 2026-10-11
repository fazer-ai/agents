-- One version mark per conversation fact with no version of its own, and the linked kanban card's
-- clock (issue #1269). Nullable with no default, so the ALTER only touches the catalog; a row without
-- a mark keeps the recency rule for that fact until the first versioned payload stamps it.
ALTER TABLE "conversations"
  ADD COLUMN "chatwoot_labels_at" DOUBLE PRECISION,
  ADD COLUMN "chatwoot_custom_attributes_at" DOUBLE PRECISION,
  ADD COLUMN "chatwoot_conversation_type_at" DOUBLE PRECISION,
  ADD COLUMN "chatwoot_kanban_attributes_at" DOUBLE PRECISION,
  ADD COLUMN "chatwoot_kanban_card_id" INTEGER,
  ADD COLUMN "chatwoot_kanban_card_at" DOUBLE PRECISION;
