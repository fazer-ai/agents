-- The conversation's type, mirrored from the fork's conversation block for the contact gate's local
-- rule. Additive: a nullable column, which Postgres adds without rewriting the table. The label list
-- the gate also reads is the `labels` column added by 20261007120000_conversation_labels.
ALTER TABLE "conversations" ADD COLUMN "conversation_type" TEXT;
