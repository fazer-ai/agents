-- The WhatsApp entry conversation a widget thread was redirected FROM (Chatwoot's display_id),
-- mirrored from the webhook payload. NULL on every conversation outside a redirect episode.
ALTER TABLE "conversations" ADD COLUMN "redirect_origin_display_id" INTEGER;

-- Ordering mark for the column above: the conversation `updated_at` of the payload that last wrote
-- it. Its own mark because the fork records the pairing with a write of its own, and it cannot be
-- ordered by `last_event_at`, which a column write does not move.
ALTER TABLE "conversations" ADD COLUMN "chatwoot_redirect_origin_at" DOUBLE PRECISION;
