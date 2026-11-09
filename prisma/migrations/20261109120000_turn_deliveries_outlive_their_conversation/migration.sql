-- A delivery row outlives its conversation: deleting a conversation (removing its Chatwoot instance)
-- nulls the row's conversation instead of deleting the row, so the proactive breaker still counts the
-- account's sends and reads its automatic peak from them. Wrapped so a failure cannot leave the table
-- without the foreign key.
BEGIN;

ALTER TABLE "agent_turn_deliveries" DROP CONSTRAINT "agent_turn_deliveries_conversation_id_fkey";

ALTER TABLE "agent_turn_deliveries" ALTER COLUMN "conversation_id" DROP NOT NULL;

ALTER TABLE "agent_turn_deliveries" ADD CONSTRAINT "agent_turn_deliveries_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
