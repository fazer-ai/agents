-- WHETHER A TURN FOLDED THIS MESSAGE INTO THE THREAD, ON THE ROW THAT CARRIED IT (issue #576). Continuous ingestion
-- gates on who owns the conversation NOW, and on a `message_updated` that is a reading taken after a
-- decision taken before: a late transcription landing once the conversation changed hands is
-- appended a second time, and a stranded row replayed once it came back to the bot is dropped
-- instead. The fact the gate actually wants — did a turn cover this message — already exists at
-- `retireCoveredDeliveries`, which is handed the word by every caller and spends it on a log line.
--
-- ADDITIVE AND COMPATIBLE WITH THE PREVIOUS RELEASE SERVING BESIDE IT (docs/deploy.md). The column
-- is nullable and the previous release leaves it null, which every reader added here treats as
-- "this row cannot say" and answers with the ownership reading it always made.
--
-- NO BACKFILL, and the null is the point. A row that already settled did so without anybody
-- recording the word, and writing `false` onto it would claim a deliberate silence over a message a
-- turn may well have folded in — which is the duplicate this column exists to prevent, written by the
-- migration itself.
--
-- ONE STATEMENT, so no `BEGIN` (.claude/rules/prisma.md asks for one where a file leaves an
-- invariant half-applied; a single `ALTER TABLE` cannot).
ALTER TABLE "chatwoot_webhook_deliveries"
  ADD COLUMN "turn_covered" BOOLEAN;
