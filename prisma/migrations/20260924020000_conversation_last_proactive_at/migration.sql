-- When our side last spoke to the customer PROACTIVELY (issue #816): a follow-up, an appointment
-- reminder, a channel-redirect follow-up or an inbound `agent_nudge` that reached the customer. The
-- reply marks (`last_replied_message_id`, `last_replied_at`) are claims on customer messages and a
-- nudge answers none, so it wrote neither, and a conversation answered only by a nudge read as one
-- nobody had ever answered. Nullable, no backfill: a nudge sent before this column is not
-- recoverable from our tables, and NULL keeps today's answer for those rows.
ALTER TABLE "conversations" ADD COLUMN "last_proactive_at" TIMESTAMP(3);
