-- THE ROWS THAT STILL HOLD A BODY, INDEXED BY THEMSELVES. The drain reads them per tenant by receipt,
-- and clears the body of any row that left PENDING by a road that does not clear it (the sweep's
-- verdict, or an older release's claim during a rolling deploy). That second question is about rows
-- in every status, which the sweep's partial index does not cover, and an unindexed predicate on a
-- ledger nothing prunes is a scan of every delivery the install has handled.
--
-- PARTIAL, so it holds only the rows whose first attempt has not begun (a body is cleared by the
-- claim): its size follows the backlog, not the history. CONCURRENTLY with the DROP first, the same
-- re-runnable shape as 20260908170004, and asserted valid by the migration after this one.
DROP INDEX IF EXISTS "chatwoot_webhook_deliveries_payload_idx";
CREATE INDEX CONCURRENTLY "chatwoot_webhook_deliveries_payload_idx"
    ON "chatwoot_webhook_deliveries"("tenant_id", "received_at")
 WHERE "payload" IS NOT NULL;
