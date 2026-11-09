-- THE FLOW-LOG LINES OF A PROACTIVE SEND THAT REACHED THE CUSTOMER, INDEXED BY THEMSELVES. The
-- proactive breaker's automatic peak (src/modules/proactive-breaker/service.ts, `autoPeakFromLogSql`)
-- counts them in a sliding 24h window over 30 days; without this it walks every `generate` line of the
-- month and reads the `detail` of each to keep a few percent, 16.9 s on a busy instance against a 5 s
-- transaction.
--
-- PARTIAL, so it holds only those lines, and on (tenant_id, created_at), which is all the read needs:
-- the reader's predicate is this one, so Postgres reaches the lines without the heap's `detail`.
-- CONCURRENTLY with the DROP first, the same re-runnable shape as 20261011210000, and asserted valid
-- by the migration after this one.
DROP INDEX IF EXISTS "execution_logs_proactive_sends_idx";
CREATE INDEX CONCURRENTLY "execution_logs_proactive_sends_idx"
    ON "execution_logs"("tenant_id", "created_at")
 WHERE "stage" = 'generate'
   AND "source" = 'inbox'
   AND ("detail"->>'outcome') IN ('messaged', 'templated');
