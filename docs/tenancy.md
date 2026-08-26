# Multi-tenancy & isolation

fazer.ai agents is multi-tenant. Isolation is **hybrid and defense-in-depth**: a Prisma `$extends` layer auto-scopes writes, and **Postgres Row-Level Security (RLS) is the hard guarantee**. Both are load-bearing; never rely on one alone.

## The non-negotiables

1. **Runtime connects as a NON-SUPERUSER, NON-BYPASSRLS role.** Superusers and table owners bypass RLS, so a superuser runtime connection makes the entire isolation model a no-op. `DATABASE_URL` must point at `fazerai_app` (provisioned by [`scripts/db-bootstrap.sql`](../scripts/db-bootstrap.sql)); `MIGRATION_DATABASE_URL` is the superuser/owner used only for DDL/migrations. The two MUST differ in production.
2. **Tenant scope is transaction-local.** `runScoped` opens a `$transaction` and issues `set_config('app.tenant_id', <id>, true)` as the first statement. The `true` makes it reset on commit/rollback, so it cannot leak to the next request on a pooled connection. A missing GUC yields NULL in the policy → **fail-closed (zero rows)**.
3. **No network/LLM `await` inside a scoped transaction.** It pins a pooled connection; long I/O exhausts the pool. Do network I/O outside; keep the tx to DB work.
4. **Never read the tenant from AsyncLocalStorage at query time.** The `$extends` is *closure-bound* to a fixed `tenantId` (reading ALS inside the extension callback is unreliable on `create`). ALS is plumbing for carrying context to nodes/workers, not the source of truth for a query's tenant.
5. **A module takes the caller's `TenantContext`, never its `tenantId`.** `runScopedOn` verifies that an unknown tenant exists only when `ctx.role` is `SUPER_ADMIN`, because the role is the whole predicate: an id that reached this process from OUTSIDE it arrives with `SUPER_ADMIN` (the `X-Tenant-Id` selector the console persists, an MCP `tenant` argument), while every context the process builds for itself carries an id it just read from a row, and `TENANT_ADMIN`. A module that takes `tenantId: bigint` and rebuilds a context around it (`{ tenantId, userId: null, role: "TENANT_ADMIN" }`) tells that check the id was internal whatever its real provenance, and a dead selection then reads as an empty tenant instead of a refusal. The rebuild is correct where the id genuinely came from a row — the graph, the scheduler, the ingest job, the webhook receiver — and that is exactly the case the role lets through for free. `tests/modules/tenant-selector-entry-points.test.ts` holds the REST controllers to it.

## API

Everything lives under [`@/lib/tenancy`](../src/lib/tenancy):

- `runScoped(ctx, fn)` — runs `fn(db)` in a tenant-scoped transaction. `db` is a branded `ScopedDb`; only the provider can produce one, so passing the base `prisma` into a service that expects a `ScopedDb` does not type-check. `create`/`createMany`/`upsert` auto-inject `tenant_id` (and override any caller-supplied value). Throws `TenantTargetRequiredError` if `ctx.tenantId` is null.
- `asSuperAdmin(fn)` — audited fleet/cross-tenant path. Sets `app.is_super_admin='on'` so RLS allows every row (incl. `tenant_id NULL` audit rows and creating new tenants). Only call when the principal is `SUPER_ADMIN`.
- `resolveRequestTenantContext(user, headerTenantId)` — pure resolution of the request `TenantContext`. `X-Tenant-Id` is honored **only** for `SUPER_ADMIN` (who has no home tenant and selects a target per request); for anyone else it is forgeable and ignored — a mismatch is flagged as an anomaly to log, never accepted.
- `roleAtLeast` / `isAdminRole` — role hierarchy `SUPER_ADMIN > TENANT_ADMIN > AGENT` (the rank itself lives in the pure [`@/lib/roles`](../src/lib/roles.ts), shared with the React client and CLI scripts). Gate by rank, never by `!== "AGENT"`.

The Elysia boundary is [`tenancyPlugin`](../src/api/middlewares/tenancy.ts): it derives `tenantContext` from the authenticated user + `X-Tenant-Id`. Handlers/services then pass it to `runScoped`/`asSuperAdmin`.

## RLS policy shape (see the init migration)

Tenant-scoped tables (`tenant_id NOT NULL`) get `ENABLE` + `FORCE ROW LEVEL SECURITY` and:

```sql
USING (
  current_setting('app.is_super_admin', true) = 'on'
  OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
)
```

with the same `WITH CHECK`. `tenants` is keyed by `id`; `audit_logs` allows `tenant_id NULL` rows only for super admins (never leaked to a tenant). The `users` and `mcp_oauth_*` tables are **global identity tables, NOT under tenant RLS** — they are read before a tenant context exists, so isolation there is by explicit `tenant_id` filtering + the `authorize()` gate (see [`admin.service.ts`](../src/api/features/admin/admin.service.ts)).

## Roles & first-run

`UserRole` is `SUPER_ADMIN | TENANT_ADMIN | AGENT`. A CHECK constraint enforces "`SUPER_ADMIN` ⟺ `tenant_id IS NULL`". The first account is created via `/setup` as `SUPER_ADMIN` (tenant_id NULL) together with an initial `Tenant`, inside one `asSuperAdmin` transaction with an advisory lock + count re-check. `bun set-admin` promotes to `TENANT_ADMIN` of the first tenant (or `SUPER_ADMIN` when no tenant exists yet).

## LangGraph checkpointer

Lives in a separate `langgraph` Postgres schema (outside Prisma). `thread_id` is `${tenantId}:${chatwootInstanceId}:${conversationId}` — a raw Chatwoot conversation id collides across tenants, so the prefix is the tenant fence there.

## Verifying isolation

[`tests/lib/tenancy.integration.test.ts`](../tests/lib/tenancy.integration.test.ts) proves fail-closed, scoped reads, RLS overriding an explicit cross-tenant `WHERE`, blocked cross-tenant writes, and `asSuperAdmin` visibility against a real Postgres. It reads `TEST_APP_DATABASE_URL` (the app role) and skips when no DB is reachable, though the suite no longer starts at all in that state unless the run declares `ALLOW_NO_DB=1` (see [`tests/db-gate.ts`](../tests/db-gate.ts)).
