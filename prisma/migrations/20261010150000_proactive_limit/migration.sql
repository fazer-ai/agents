-- The per-conversation proactive limit. Its reservation is a delivery row marked `pending` until the
-- nudge's send reaches the customer, so the turn limit, which counts only what was delivered, never
-- counts one; and the instant of the limit's last `error` line, so only the first refusal in a
-- rolling day pages the alert channels.
ALTER TABLE "agent_turn_deliveries" ADD COLUMN "pending" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "conversations" ADD COLUMN "proactive_limit_alerted_at" TIMESTAMP(3);
