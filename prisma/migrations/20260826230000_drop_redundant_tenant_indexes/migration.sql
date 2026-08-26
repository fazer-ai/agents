-- EIGHTEEN INDEXES ON `(tenant_id)` THAT A COMPOSITE ALREADY ANSWERS (issue #373).
--
-- A btree serves any leading prefix of its key columns, so `(tenant_id, x)` already answers
-- `WHERE tenant_id = $1`. Where both exist, the bare one is a second index tuple to write on every
-- insert and on every non-HOT update, and it answers nothing the composite could not.
--
-- Uniqueness is not part of the rule, and that is where the count comes from: sixteen of these are
-- covered by a UNIQUE constraint rather than by a plain `@@index`, and a unique btree serves the
-- prefix exactly like a plain one. Measured by leaving
-- `issued_documents_tenant_id_idempotency_key_key` as the only tenant-led index on its table and
-- watching the planner take it with `Index Cond: (tenant_id = 7)`.
--
-- WHAT THE DROP BUYS, on PostgreSQL 17.10 against 1,000,000 seeded delivery rows and 500,000 issued
-- documents across 50 tenants, each arm run with the bare index dropped inside a rolled-back
-- transaction so both saw the same table:
--
--   outbound_webhook_deliveries   INSERT +3.0   UPDATE +4.0   buffer accesses per row
--   issued_documents              INSERT +3.0   UPDATE +4.0   buffer accesses per row
--
-- with `n_tup_hot_upd = 0` on both, so no update escapes the maintenance. The two indexes measured
-- 6440 kB and 3232 kB, 4.3% and 5.9% of their table's index footprint.
--
-- WHAT IT COSTS: nothing the codebase issues. Every read shape in `deliveries.ts` and `issue.ts`
-- planned identically in both arms, because the composite takes over the prefix scan. The one shape
-- that reads more index pages is a bare `count(*)` per tenant (21 -> 193 buffers on the deliveries
-- table, against a heap scan of 20,000 blocks either way, so +0.6% of the query), and there is no
-- count or aggregate on either table.
--
-- NOT CONCURRENTLY, and that is a measured limit rather than a preference. A neighbouring migration
-- states that `prisma migrate deploy` never wraps a file in a transaction; that holds for
-- `CREATE INDEX CONCURRENTLY` and does not hold for the DROP. Applied to scratch databases through
-- the real command: one `DROP INDEX CONCURRENTLY` alone in a file succeeds, the same statement with
-- ANY second statement beside it fails with `DROP INDEX CONCURRENTLY cannot run inside a transaction
-- block`, while two `CREATE INDEX CONCURRENTLY` in one file both succeed. So the concurrent form
-- would cost eighteen migration directories to buy a lock that a drop holds only briefly: unlike an
-- index BUILD, there is no work to hold ACCESS EXCLUSIVE across, and `ALTER TABLE ... ADD COLUMN`
-- throughout this directory takes the same lock for the same instant.
--
-- IF EXISTS on each, because a file that fails partway is marked rolled back and run again.
DROP INDEX IF EXISTS "agent_threads_tenant_id_idx";
DROP INDEX IF EXISTS "chatwoot_agent_bots_tenant_id_idx";
DROP INDEX IF EXISTS "chatwoot_instances_tenant_id_idx";
DROP INDEX IF EXISTS "contacts_tenant_id_idx";
DROP INDEX IF EXISTS "conversations_tenant_id_idx";
DROP INDEX IF EXISTS "conversion_events_tenant_id_idx";
DROP INDEX IF EXISTS "document_templates_tenant_id_idx";
DROP INDEX IF EXISTS "inbound_deliveries_tenant_id_idx";
DROP INDEX IF EXISTS "inboxes_tenant_id_idx";
DROP INDEX IF EXISTS "integration_external_refs_tenant_id_idx";
DROP INDEX IF EXISTS "integration_instances_tenant_id_idx";
DROP INDEX IF EXISTS "issued_documents_tenant_id_idx";
DROP INDEX IF EXISTS "mcp_server_connections_tenant_id_idx";
DROP INDEX IF EXISTS "outbound_webhook_deliveries_tenant_id_idx";
DROP INDEX IF EXISTS "prompt_variant_assignments_tenant_id_idx";
DROP INDEX IF EXISTS "scheduler_jobs_tenant_id_idx";
DROP INDEX IF EXISTS "tool_definitions_tenant_id_idx";
DROP INDEX IF EXISTS "vault_entries_tenant_id_idx";
