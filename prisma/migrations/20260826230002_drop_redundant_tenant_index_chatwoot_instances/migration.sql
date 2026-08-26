-- One of eighteen (issue #373): `@@index([tenantId])` beside a composite that already leads with
-- the same column. The measurement, and why this is one statement per file, is in
-- `20260826230000_drop_redundant_tenant_index_agent_threads`.
DROP INDEX CONCURRENTLY IF EXISTS "chatwoot_instances_tenant_id_idx";
