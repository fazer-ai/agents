-- The conversation's Chatwoot labels, mirrored from the webhook payload.
ALTER TABLE "conversations" ADD COLUMN "labels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- The dashboard groups conversations by label.
CREATE INDEX "conversations_labels_idx" ON "conversations" USING GIN ("labels");
