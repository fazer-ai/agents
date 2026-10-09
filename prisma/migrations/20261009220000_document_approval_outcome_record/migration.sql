-- What a document approval came to in its conversation, for the console (docs/documents.md, Approval):
-- the approved note's claim, so a retried outcome never repeats it, and the outcome itself. All
-- nullable, so the previous image keeps writing rows during the deploy.
ALTER TABLE "document_approval_requests" ADD COLUMN "approved_note_at" TIMESTAMP(3),
ADD COLUMN "outcome" TEXT,
ADD COLUMN "outcome_at" TIMESTAMP(3);
