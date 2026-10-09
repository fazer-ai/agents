-- THE ACK STORES THE BODY BEFORE IT ANSWERS (issue #1121). The receiver used to answer Chatwoot's
-- webhook with a 200 before anything durable existed, so a process that died after the 200 lost the
-- message with no ledger row the sweep could see. The row is now written by the ack, with the body,
-- and processed from it.
--
-- Nullable with no default, so this is a catalog change and does not rewrite the table. The previous
-- release keeps writing rows without it during a rolling deploy, which is the shape every row an
-- older build wrote has: nothing to drain, the sweep's as before. The index the drain reads by is
-- the next migration's, built concurrently.
ALTER TABLE "chatwoot_webhook_deliveries" ADD COLUMN "payload" TEXT;
