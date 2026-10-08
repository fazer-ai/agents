-- The source position of an inbox's mirrored name and channel. The mirror writes the inbox row
-- only when one of them changes, and this position is what keeps a late delivery from restoring a name or channel a newer one replaced. NULL on every existing row until its next change,
-- which the reader treats as "never positioned". Additive: the previous release ignores the column.
ALTER TABLE "inboxes" ADD COLUMN "metadata_at" TIMESTAMP(3);
