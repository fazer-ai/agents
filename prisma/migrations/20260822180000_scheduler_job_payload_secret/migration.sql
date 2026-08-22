-- The encrypted half of a job payload, kept out of the Json column.
--
-- `encryptJson` returns a base64 blob, and this repository's rule is that such a blob lives in a
-- plain String column and never in `Json`: a Json payload is the thing that gets logged or
-- serialized whole, and it would carry the ciphertext of a contact's own message with it.
--
-- Nullable and with no backfill on purpose. The only kind that writes it is INGEST_MESSAGE, which
-- did not exist before this release, so there is no older row whose secret would need moving.
ALTER TABLE "scheduler_jobs" ADD COLUMN "payload_secret" TEXT;
