-- THE CONVERSATIONS OF A RANGE OF DAYS, read by index. Every conversation figure of the dashboard
-- selects by `created_at`, and the kept days (issue #1383) compute them a part of at most 30 days at
-- a time, which without this reads the tenant's whole table for each part. CONCURRENTLY with the DROP
-- first, the re-runnable shape of 20261011210000, asserted valid by the migration after this one.
DROP INDEX IF EXISTS "conversations_tenant_id_created_at_idx";
CREATE INDEX CONCURRENTLY "conversations_tenant_id_created_at_idx"
    ON "conversations"("tenant_id", "created_at");
