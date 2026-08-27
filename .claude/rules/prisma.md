---
paths:
  - "prisma/**"
  - "prisma.config.ts"
  - "scripts/db-bootstrap.ts"
---

# Prisma / migrations constraints

- `knowledge_chunks` is **externally managed** (`tables.external` in `prisma.config.ts`): the migrate diff ignores it, so any schema change to this table (columns, indexes) must be written by hand in a migration. Never remove the external config to "fix" a diff.
- The pgvector HNSW index `knowledge_chunks_embedding_hnsw` is not modeled by Prisma. A generated migration containing `DROP INDEX "knowledge_chunks_embedding_hnsw"` is a bug — it silently kills RAG KNN retrieval; delete that statement.
- Enums: a value added with `ALTER TYPE ... ADD VALUE` cannot be used (DML/DEFAULT) in the same migration that adds it. Split add-value and first-use into separate migrations.
- Runtime role, GRANTs and default privileges are provisioned by `scripts/db-bootstrap.ts` (runs before `migrate deploy` at boot) — never put them in migrations. Two exceptions, both for the same reason (the `migrate dev` SHADOW database is a fresh database bootstrap never touches) and both narrow: the baseline migration keeps an idempotent `CREATE EXTENSION IF NOT EXISTS vector` so the shadow database can create `vector(...)` columns; and `20260827000000_rls_split_tenant_and_fleet_policies` creates the **fleet role** it writes into `CREATE POLICY … TO`, which is a hard error on a role that does not exist. That one creates the role and nothing else — no grants, no default privileges. Don't remove either, don't add extensions in later migrations, and don't grow the list without the same kind of reason.
- **`migrate dev` leaves one fleet role behind per run**, because the name derives from the shadow database and dropping that database does not drop the role. Harmless but not free (managed servers cap roles). Clean them on a dev cluster with:
  ```sql
  DO $$ DECLARE r record; BEGIN
    FOR r IN SELECT rolname FROM pg_roles WHERE rolname LIKE 'fazerai\\_fleet\\_prisma\\_migrate\\_shadow%' LOOP
      EXECUTE format('DROP ROLE %I', r.rolname);
    END LOOP;
  END $$;
  ```
- Never run a bare `prisma migrate reset`: it recreates the `public` schema and wipes the bootstrap-provisioned grants (Postgres `42501` on next boot). Use `bun db:reset`, or rerun `bun db:bootstrap` after any reset.
- **A DATA migration over a tenant-scoped table lifts FORCE around the statement** (`ALTER TABLE x NO FORCE ROW LEVEL SECURITY;` … `ALTER TABLE x FORCE ROW LEVEL SECURITY;`), never entering the fleet role: `migrate dev` replays into a shadow database bootstrap never touches, where that role has no grants and no membership (measured — `permission denied to set role`). Whatever a file lifts it must restore; `tests/prisma/migration-rls-bypass.test.ts` asks both, per table.
- RLS policies, partial/expression indexes and CHECK constraints are hand-written SQL in migrations (Prisma cannot model them). When adding a tenant-scoped table, add its `ENABLE`/`FORCE ROW LEVEL SECURITY` + `tenant_isolation` policy in the same migration (see the tail of the baseline migration).

## Querying

- **`notIn` drops NULL rows.** Prisma renders it as a bare `NOT IN (...)`, and `NULL NOT IN (...)` is `NULL` in SQL, so on a nullable column the filter silently shrinks the result. Measured seeding `[null, "vision", "agent"]`: `notIn: ["vision"]` returns `["agent"]` only. Where NULL carries meaning (rows written before the column had a default), say so: `OR: [{ col: null }, { col: { notIn: [...] } }]`. There is no error and every historical count just gets smaller.
- **A `catch` cannot recover inside a scoped transaction.** `runScoped`/`runScopedOn` open a `$transaction` to `SET LOCAL app.tenant_id` for RLS (`src/lib/tenancy/multi-tenant.ts`), so a statement that fails puts the Postgres transaction in the aborted state and every later statement dies with `current transaction is aborted`: the try-create / catch-P2002 / update-instead pattern is dead code in there. Use `db.<model>.upsert` keyed on the full composite unique (Prisma emits a native `INSERT … ON CONFLICT DO UPDATE` when the where is a complete unique and create/update hold only scalars). Prisma has no manual savepoint; if upsert does not fit, restructure outside the transaction.

## Dropping a column

The condition for a safe `DROP COLUMN` is **not** "no code reads the field", it is "no query NAMES the column". A Prisma query without an explicit `select` asks for every scalar of the model, and a relation pulled as `toolDefinition: true` does the same, so a call site that never touches the field still puts the column in the SQL and the previous image answers `undefined_column` after the drop. Auditing the explicit `SELECT` lists answers backwards: the screen you expect to break is the one that survives, because it is the only one naming its columns. Measured on #149/#176 with the v1.9.0 client against a database already missing the column: the two `findMany`/`update` without `select` failed, the one with an explicit `select` passed.

The mechanism is `@ignore` on the schema field. It removes the field from the generated client, so no query shape can name the column and a read becomes a `TS2339`, and it has **no DDL effect** — a `migrate diff` across the attribute is an empty migration, and across the field's removal it is the `ALTER TABLE … DROP COLUMN` the next release carries. Two designs lose to it, both tried: per-call-site `select` (enumerating the shapes is a race you lose — `toolDefinition: true` matches no call-site pattern), and a global client `omit` (works in SQL but re-types `PrismaClient`, which 89 files here use raw, and any call site undoes it).

So: one release adds `@ignore`, the next removes the field and drops the column, and the release note belongs to the second, saying rollback past it is no longer supported. Test the **shapes** (implicit read, write whose result nobody reads, whole relation pulled, insert) with a raw `SELECT` control, not the call sites. Gotcha: a statement the database REJECTS emits no query event, so the insert has to succeed, and under RLS that wants the migration role.

## Postgres catalog columns have a version

A catalog column can be newer than the servers you must boot on: `pg_auth_members.inherit_option` is PG16+, and using it in `db-bootstrap.ts` (which runs at every boot) would break every 15-or-older server with `column am.inherit_option does not exist` — no local assertion would catch it, because the servers here run 17 and the failure is an old server refusing to parse. Prefer the portable function to gating by version (`pg_has_role(r, d, 'USAGE')` answered the same thing and exists in every version). Since the red is impossible locally, the fence is a test that reads the script's source and asserts every 16-only construct sits behind the version gate — validated against its own error by reintroducing the column.
