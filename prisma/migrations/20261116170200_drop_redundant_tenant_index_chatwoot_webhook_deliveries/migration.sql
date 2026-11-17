-- `@@index([tenantId])` beside `(tenant_id, received_at)`, which serves the same prefix. The reason it
-- goes, and why this is one statement per file, is in
-- `20260826230000_drop_redundant_tenant_index_agent_threads`.
DROP INDEX CONCURRENTLY IF EXISTS "chatwoot_webhook_deliveries_tenant_id_idx";
