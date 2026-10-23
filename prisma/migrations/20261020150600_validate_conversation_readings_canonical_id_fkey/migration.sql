-- The foreign key `20261020150000_occurrence_themes_and_canonicals` added NOT VALID, checked here, after
-- that transaction committed: VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on
-- `conversation_readings`, so the observer keeps reading and writing while its rows are checked, where
-- the validation inside the DDL transaction would have run under the column's ACCESS EXCLUSIVE lock.
-- Alone in its file, like every statement here that must not share a transaction.
ALTER TABLE "conversation_readings" VALIDATE CONSTRAINT "conversation_readings_canonical_id_fkey";
