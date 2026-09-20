-- When OUR side last spoke on this conversation, which is a different question from when the
-- customer last did (`last_inbound_at`) and the one the follow-up's activation fence has to ask.
--
-- Left NULL on the rows that already existed, on purpose: a value invented for them would claim we
-- spoke at a moment nobody measured, and the fence falls back to `last_inbound_at` when it is null,
-- so nothing that is eligible today stops being eligible.
ALTER TABLE "conversations" ADD COLUMN "last_replied_at" TIMESTAMP(3);
