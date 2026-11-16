-- THE ROWS A PROCESS HAS CLAIMED, INDEXED BY THEMSELVES. The dead-claims pass
-- (src/modules/chatwoot/delivery-sweep.ts, `deadClaimsSql`) reads them every 15 seconds in every
-- process, as the fleet and across every tenant. The sweep's partial index does not serve it there:
-- the policy on this table hides the statistics of `status` from an enum comparison (not LEAKPROOF),
-- so the planner sizes that index as the whole ledger and scans the table instead. Measured on a
-- production ledger of 8.5M rows: Parallel Seq Scan, 198k buffers, 1.1 s per pass, 0 rows.
--
-- PARTIAL on `claimed_by IS NOT NULL`, which a null test can prove and whose statistics the policy
-- does not hide: the planner sees it nearly empty. The `chatwoot_delivery_forget_claimer` trigger
-- clears `claimed_by` on any write that leaves PROCESSING, so its size follows the claims in flight,
-- not the history. On `claimed_at`, the pass's own order. CONCURRENTLY with the DROP first, the same
-- re-runnable shape as 20261010120100, and asserted valid by the migration after this one.
DROP INDEX IF EXISTS "chatwoot_webhook_deliveries_claimed_idx";
CREATE INDEX CONCURRENTLY "chatwoot_webhook_deliveries_claimed_idx"
    ON "chatwoot_webhook_deliveries"("claimed_at")
 WHERE "claimed_by" IS NOT NULL;
