-- The conversation's type and labels, mirrored from the fork's conversation block for the contact
-- gate's local rule. Additive: a nullable column and an array with a constant default, both of which
-- Postgres adds without rewriting the table.
ALTER TABLE "conversations" ADD COLUMN "conversation_type" TEXT;
ALTER TABLE "conversations" ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
