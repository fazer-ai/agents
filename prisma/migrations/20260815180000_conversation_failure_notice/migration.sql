-- Coalescing anchor + concurrency claim for the "turn definitively lost" private note.
ALTER TABLE "conversations" ADD COLUMN "failure_notice_sent_at" TIMESTAMP(3);
