-- Whether the subject reading's canonical name is in the conversation's Chatwoot attribute
-- (docs/occurrences.md, "Canonical subjects"). False on every write of the reading, since the
-- observer writes its raw spelling; the round's copy sets it once Chatwoot holds the canonical.
BEGIN;

ALTER TABLE "conversation_readings" ADD COLUMN     "canonical_written" BOOLEAN NOT NULL DEFAULT false;

COMMIT;
