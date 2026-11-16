-- THE RETENTION PASS'S RANGE: chatwoot_webhook_deliveries by tenant and receipt. The pass deletes the
-- settled rows past the ledger's window (src/modules/chatwoot/ledger-retention.ts) a batch at a time,
-- and each batch is a range over this index; without it a batch walks the tenant's whole history.
--
-- FULL, not partial on the settled statuses: under RLS (forced on this table) a user predicate whose
-- operator is not leakproof is evaluated after the policy and cannot prove a partial index's
-- predicate, and the enum equality behind `status IN (...)` is not leakproof. The timestamp
-- comparison is, so the range reaches the index under both the tenant policy and the fleet role.
--
-- It leads with tenant_id, so it serves every read the bare tenant_id index served, and the migration
-- after the assertion drops that one. CONCURRENTLY with the DROP first, the same re-runnable shape as
-- 20261010120100, and asserted valid by the migration after this one.
DROP INDEX IF EXISTS "chatwoot_webhook_deliveries_tenant_id_received_at_idx";
CREATE INDEX CONCURRENTLY "chatwoot_webhook_deliveries_tenant_id_received_at_idx"
    ON "chatwoot_webhook_deliveries"("tenant_id", "received_at");
