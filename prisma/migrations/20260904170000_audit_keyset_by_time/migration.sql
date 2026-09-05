-- EACH BUILD IS PRECEDED BY ITS OWN `DROP INDEX IF EXISTS`, which is the rule in
-- `.claude/rules/prisma.md`: without a transaction this file is not atomic, and an interrupted
-- `CREATE INDEX CONCURRENTLY` leaves an `indisvalid=false` index that Postgres silently refuses to
-- use -- the plan goes back to what it was, the migration reads as applied, and nothing says so. The
-- drop is what makes the redeploy rebuild from scratch instead of finding the residue and keeping it.
--
-- Round 6 of review took these out, on the grounds that a plain `DROP INDEX` takes ACCESS EXCLUSIVE
-- on the table. That is true and it is the trade this rule already weighed: the drops run only on a
-- retry, they are metadata-only on an index that exists, and the alternative measured worse in every
-- direction -- `IF NOT EXISTS` skips the dead index and never builds it, `DROP INDEX CONCURRENTLY`
-- cannot share a file with a `CREATE INDEX CONCURRENTLY`, and moving the cleanup to an earlier
-- migration does nothing because Prisma re-runs only the migration that failed (measured: the dead
-- index survived the retry untouched). Leaving the deploy stuck on `42P07` for a human to clear is a
-- worse outage than a brief lock on the retry path.
--
-- The catalog assertion the rule asks for is the migration right after this one: a `DO $$` block
-- puts the file in an implicit transaction, which these `CREATE INDEX CONCURRENTLY` cannot share.
-- THE ORDERING KEY, INDEXED IN FULL (#530).
--
-- The trail is now paged by `(created_at, id)` -- the column its window is cut on, plus the id as
-- the tie-break. Before this, a date filter was a plain predicate over a walk ordered by `id`, so a
-- window that is not the newest one made Postgres walk the primary key backwards discarding
-- everything outside it, at a cost proportional not to the page but to how far back the window
-- reached. Measured on a 500k-row probe carrying this table's own indexes, a 30-day window 80 days
-- back, page of 51:
--
--                       ORDER BY id (before)        ORDER BY created_at, id (after)
--   scope=tenant    9,277 buffers  24.3 ms          39 buffers  0.15 ms
--   scope=fleet     6,857 buffers   4.4 ms          32 buffers  0.04 ms
--   scope=all       9,237 buffers  38.6 ms           5 buffers  0.02 ms
--
-- 448,000 rows read and thrown away to collect 51.
--
-- THE `id` AT THE END IS NOT DECORATION, and a first measurement said it was: on a probe whose
-- stamps were all distinct, adding it moved 39 buffers to 45 and nothing else. That probe was
-- missing the case that matters. `created_at` is written by the client and a transaction stamps
-- every row it writes with the same `NOW()` -- `20260903120000_rename_http_tools_named_after_natives`
-- writes one audit row per renamed tool that way -- so a large TIED GROUP is a thing this table
-- really holds. An index that stops at `created_at` cannot supply the `id DESC` inside such a group,
-- so the page has to read the whole group and sort it. Measured on 200,000 rows sharing one instant,
-- a page of 51: 4,277 buffers and 22.1 ms with a quicksort, against 2 buffers and 0.07 ms with the
-- id in the key. The cost is bounded by the tie, not by the page.
--
-- One index goes away. `audit_logs_fleet_id_idx` existed for a single query -- the fleet trail's
-- first page ordered by `id` -- which no longer exists, so it was pure write cost on a table every
-- audited mutation writes to.
--
-- CONCURRENTLY, and therefore OUTSIDE a transaction, which Prisma gives us: it runs a migration file
-- unwrapped (measured in both `migrate deploy` and `migrate dev`'s shadow replay). Three builds share
-- this file because `CREATE INDEX CONCURRENTLY` tolerates that; the DROP form does not.
--
-- IF A BUILD IS INTERRUPTED, this migration fails LOUDLY on the retry and that is deliberate. A dead
-- `CREATE INDEX CONCURRENTLY` leaves an `indisvalid=false` index that Postgres ignores for planning,
-- and re-running raises `42P07 relation already exists` (measured) -- which is the right outcome,
-- because the three ways to clean it up automatically are all worse:
--
--   * `IF NOT EXISTS` skips past the dead index, so it is never built and nothing says so;
--   * a plain `DROP INDEX` first takes ACCESS EXCLUSIVE on the TABLE, queueing every audit read and
--     every audited mutation behind the recovery;
--   * `DROP INDEX CONCURRENTLY` cannot share this file, and putting it in an EARLIER migration does
--     not help: Prisma re-runs only the migration that failed, never the ones already applied
--     (measured -- the dead index survived the retry untouched).
--
-- So recovery is one command, run by hand, off the write path:
--
--   DROP INDEX CONCURRENTLY IF EXISTS "<the name in the error>";
--
-- then re-run the deploy.

DROP INDEX IF EXISTS "audit_logs_tenant_id_created_at_id_idx";
CREATE INDEX CONCURRENTLY "audit_logs_tenant_id_created_at_id_idx"
  ON "audit_logs" ("tenant_id", "created_at" DESC, "id" DESC);
DROP INDEX IF EXISTS "audit_logs_created_at_id_idx";
CREATE INDEX CONCURRENTLY "audit_logs_created_at_id_idx"
  ON "audit_logs" ("created_at" DESC, "id" DESC);
DROP INDEX IF EXISTS "audit_logs_fleet_created_at_id_idx";
CREATE INDEX CONCURRENTLY "audit_logs_fleet_created_at_id_idx"
  ON "audit_logs" ("created_at" DESC, "id" DESC) WHERE "tenant_id" IS NULL;

-- The indexes these replace are dropped by the migration that FOLLOWS this one, not here. Two
-- reasons, and the second is the one that matters on a live deployment:
--
--   * mixing `DROP INDEX CONCURRENTLY` with `CREATE INDEX CONCURRENTLY` in one file puts Postgres in
--     an implicit transaction and the CREATEs fail with `cannot run inside a transaction block`
--     (measured here); and
--   * a plain `DROP INDEX` takes ACCESS EXCLUSIVE on the TABLE, not on the index -- so it waits
--     behind any audit read in flight, and every mutation writing a trail row queues behind it. That
--     is the exact blocking the concurrent builds above exist to avoid.
--
-- One file per concurrent statement is what keeps both off the write path.
