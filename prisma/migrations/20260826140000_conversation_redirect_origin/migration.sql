-- The WhatsApp entry conversation a widget thread was redirected from, as Chatwoot's per-account
-- display_id. Mirrored from the webhook payload; the fork writes it at token-resolve time, which is
-- the one moment the two halves of a redirect episode are known together (issue #222).
ALTER TABLE "conversations" ADD COLUMN "redirect_origin_display_id" INTEGER;
