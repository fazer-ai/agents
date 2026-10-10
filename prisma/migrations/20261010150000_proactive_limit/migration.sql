-- The per-conversation proactive limit: the instant its last `error` line was written, so only the
-- first refusal in a rolling day pages the alert channels. The count itself reads the existing
-- `agent_turn_deliveries` rows marked proactive.
ALTER TABLE "conversations" ADD COLUMN "proactive_limit_alerted_at" TIMESTAMP(3);
