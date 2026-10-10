-- The facts mark and the linked kanban card's clock (issue #1269). Nullable with no default, so the
-- ALTER only touches the catalog; a row without a mark keeps the recency rule until the first
-- versioned payload stamps it.
ALTER TABLE "conversations"
  ADD COLUMN "chatwoot_facts_at" DOUBLE PRECISION,
  ADD COLUMN "chatwoot_kanban_card_id" INTEGER,
  ADD COLUMN "chatwoot_kanban_card_at" DOUBLE PRECISION;
