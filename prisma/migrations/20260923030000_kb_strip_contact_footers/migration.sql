-- Issue #747: per-base switch to drop a document's trailing contact footer at search time.
ALTER TABLE "knowledge_bases" ADD COLUMN "strip_contact_footers" BOOLEAN NOT NULL DEFAULT false;
