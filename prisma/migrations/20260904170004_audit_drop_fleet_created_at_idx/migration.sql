-- Superseded by `20260904170000_audit_keyset_by_time`. ONE DROP PER FILE, and that is measured, not
-- style: two `DROP INDEX CONCURRENTLY` statements in one migration are sent as a multi-command
-- message, which Postgres runs as an implicit transaction, and the command refuses one --
-- `DROP INDEX CONCURRENTLY cannot run inside a transaction block`. (Several `CREATE INDEX
-- CONCURRENTLY` in one file do NOT hit this, which is why the migration before this one holds three.)
--
-- CONCURRENTLY at all because a plain `DROP INDEX` takes ACCESS EXCLUSIVE on the TABLE rather than on
-- the index: it waits behind any audit read in flight, and every audited mutation queues behind it --
-- the exact blocking the concurrent builds exist to avoid.
--
-- Replaced by `audit_logs_fleet_created_at_id_idx`.
DROP INDEX CONCURRENTLY IF EXISTS "audit_logs_fleet_created_at_idx";

-- NOTE: `audit_logs_fleet_id_idx` is deliberately NOT dropped in this release, though nothing in this
-- codebase issues the `ORDER BY id` fleet page it serves. `docs/deploy.md` describes rolling deploys,
-- so for one overlap a container from the previous release still asks that question, and without the
-- index it walks the primary key past every tenant row: 8,687 buffers and 21.5 ms against 2, measured
-- on a 500k-row probe with the fleet slice at the far end. The three indexes dropped here and in the
-- two migrations before it have no such problem -- the new `(created_at DESC, id DESC)` ones answer
-- the old queries too. Removal is scheduled in docs/roadmap.md.
