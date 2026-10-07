-- The conversation's Chatwoot labels, mirrored from the webhook payload.
ALTER TABLE "conversations" ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
