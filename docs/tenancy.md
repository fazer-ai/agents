# Multi-tenancy & isolation

fazer.ai agents is multi-tenant. Isolation is **hybrid and defense-in-depth**: a Prisma `$extends` layer auto-scopes writes, and **Postgres Row-Level Security (RLS) is the hard guarantee**. Both are load-bearing; never rely on one alone.

## The non-negotiables

1. **Runtime connects as a NON-SUPERUSER, NON-BYPASSRLS role.** Superusers and table owners bypass RLS, so a superuser runtime connection makes the entire isolation model a no-op. `DATABASE_URL` must point at `fazerai_app` (provisioned by [`scripts/db-bootstrap.sql`](../scripts/db-bootstrap.sql)); `MIGRATION_DATABASE_URL` is the superuser/owner used only for DDL/migrations. The two MUST differ in production. This holds for the cross-tenant path too: it is a role with no attribute of its own, reached by `SET ROLE`, never a `BYPASSRLS` account — see the policy section below.
2. **Tenant scope is transaction-local.** `runScoped` opens a `$transaction` and issues `set_config('app.tenant_id', <id>, true)` as the first statement. The `true` makes it reset on commit/rollback, so it cannot leak to the next request on a pooled connection. A missing GUC yields NULL in the policy → **fail-closed (zero rows)**.
3. **No network/LLM `await` inside a scoped transaction.** It pins a pooled connection; long I/O exhausts the pool. Do network I/O outside; keep the tx to DB work.
4. **Never read the tenant from AsyncLocalStorage at query time.** The `$extends` is *closure-bound* to a fixed `tenantId` (reading ALS inside the extension callback is unreliable on `create`). ALS is plumbing for carrying context to nodes/workers, not the source of truth for a query's tenant.
5. **A module takes the caller's `TenantContext`, never its `tenantId`.** `runScopedOn` verifies that an unknown tenant exists only when `ctx.role` is `SUPER_ADMIN`, because the role is the whole predicate: an id that reached this process from OUTSIDE it arrives with `SUPER_ADMIN` (the `X-Tenant-Id` selector the console persists, an MCP `tenant` argument), while every context the process builds for itself carries an id it just read from a row, and `TENANT_ADMIN`. A module that takes `tenantId: bigint` and rebuilds a context around it (`{ tenantId, userId: null, role: "TENANT_ADMIN" }`) tells that check the id was internal whatever its real provenance, and a dead selection then reads as an empty tenant instead of a refusal. The rebuild is correct where the id genuinely came from a row — the graph, the scheduler, the ingest job, the webhook receiver — and that is exactly the case the role lets through for free. `tests/modules/tenant-selector-entry-points.test.ts` holds the REST controllers to it.
6. **An FK does not validate ownership.** When a tenant-scoped row points at another entity, `tenant_isolation` checks only the new row's own `tenant_id`; the `agent_id`/`inbox_id` that came from the request is validated by nobody, because Postgres documents that referential-integrity checks (FK, unique, PK) always bypass row security to preserve consistency. So an `INSERT` carrying another tenant's FK returns `INSERT 0 1` under `FORCE ROW LEVEL SECURITY`, even when RLS hides that row from the writer. Measured on the public PR #132: tenant A wrote `playground_share_links(tenant_id=1, agent_id=<tenant B's agent>)` without being able to see the agent. Inert on its own; it became a leak because the read that followed ran `asSuperAdminOn` and joined `agent.name` into a public, `BIGSERIAL`-enumerable route. **Isolation comes from the scoped READ, never from the constraint**: read the referenced entity with `runScopedOn` first and let RLS refuse (the pattern `src/modules/agents/transfer.ts` already uses), and in any `asSuperAdminOn` read that joins across entities, compare the two `tenantId`s explicitly — RLS will not save you there.

## API

Everything lives under [`@/lib/tenancy`](../src/lib/tenancy):

- `runScoped(ctx, fn)` — runs `fn(db)` in a tenant-scoped transaction. `db` is a branded `ScopedDb`; only the provider can produce one, so passing the base `prisma` into a service that expects a `ScopedDb` does not type-check. `create`/`createMany`/`upsert` auto-inject `tenant_id` (and override any caller-supplied value). Throws `TenantTargetRequiredError` if `ctx.tenantId` is null.
- `asSuperAdmin(fn)` — audited fleet/cross-tenant path. Becomes the fleet role for the length of the transaction (`set_config('role', …, true)`, which resets on commit and on rollback), and that role is what every table's `fleet_super_admin` policy is written `TO` — so RLS allows every row (incl. `tenant_id NULL` audit rows and creating new tenants). Only call when the principal is `SUPER_ADMIN`.
- `resolveRequestTenantContext(user, headerTenantId)` — pure resolution of the request `TenantContext`. `X-Tenant-Id` is honored **only** for `SUPER_ADMIN` (who has no home tenant and selects a target per request); for anyone else it is forgeable and ignored — a mismatch is flagged as an anomaly to log, never accepted.
- `roleAtLeast` / `isAdminRole` — role hierarchy `SUPER_ADMIN > TENANT_ADMIN > AGENT` (the rank itself lives in the pure [`@/lib/roles`](../src/lib/roles.ts), shared with the React client and CLI scripts). Gate by rank, never by `!== "AGENT"`.

The Elysia boundary is [`tenancyPlugin`](../src/api/middlewares/tenancy.ts): it derives `tenantContext` from the authenticated user + `X-Tenant-Id`. Handlers/services then pass it to `runScoped`/`asSuperAdmin`.

## RLS policy shape (see `20260827000000_rls_split_tenant_and_fleet_policies`)

Tenant-scoped tables (`tenant_id NOT NULL`) get `ENABLE` + `FORCE ROW LEVEL SECURITY` and **two** policies:

```sql
CREATE POLICY tenant_isolation ON <table>
  USING      (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);

CREATE POLICY fleet_super_admin ON <table> TO <fleet role> USING (true) WITH CHECK (true);
```

The split is not cosmetic. Until #382 both branches lived in one policy, ORed together
(`current_setting('app.is_super_admin', true) = 'on' OR tenant_id = …`), and a branch that names no
column cannot become an index condition — so neither could the branch beside it, and every
`@@index([tenantId])` and `(tenantId, …)` composite was unreachable through the policy. Measured on
1,000,000 rows, returning a page of 51 to a tenant holding 0.01% of the table: **108 ms and 509,949
rows discarded**, against 0.033 ms and none. Two *permissive* policies do not help — Postgres ORs
those and the qual comes out identical, buffer for buffer. `TO <role>` does, because a policy whose
role does not match the caller is not part of the qual at all.

Two consequences worth knowing before touching this:

- **The tenant policy carries no `TO` clause**, deliberately. The runtime role's *name* is deployment
  configuration (`DATABASE_URL`) and a migration cannot read a deployment's env, so a policy that had
  to name it could not be written in a migration at all. Only the fleet policy names a role, and that
  name is a fixed constant ([`@/lib/tenancy/fleet-role`](../src/lib/tenancy/fleet-role.ts)).
- **The fleet role's NAME carries the database** — `fazerai_fleet_<database>_<8 hex of its md5>`,
  resolved by `public.fazerai_fleet_role()`. Roles are cluster-wide while databases are not, so a
  fixed name would be one role shared by every installation on a server: installation A's runtime
  role could connect to installation B's database (databases grant `CONNECT` to `PUBLIC` by
  default), `SET ROLE` into it, and pick up the grants and the fleet policy B gave it. Measured
  across two databases with distinct app roles: **permission denied before this design, 30 of 30
  rows with a fixed name** — and with the cluster superuser as the migration role on both, the
  second bootstrap wires it with no manual step. The eight hex digits are there because the
  identifier limit is 63 bytes and Postgres truncates silently.
- **The runtime role must hold the fleet role WITHOUT inheriting it, and must be able to `SET` it.**
  Two different questions: `SET ROLE` needs the membership's SET option, while INHERITING it applies
  `fleet_super_admin` to the runtime role passively — and then an ordinary scoped request reads
  every tenant's rows with no error and no plan difference. The grant is made
  `WITH INHERIT FALSE, SET TRUE` and the effective state is asserted in two places — `db-bootstrap`
  refuses to provision, and [`db-guard`](../src/lib/db-guard.ts) refuses to serve. **Both** states
  refuse: inheriting is a silent isolation loss, and being unable to `SET ROLE` is not "only fleet
  administration" — `asSuperAdminOn` is how an API key is verified (the tenant is unknown until the
  key row is read), how a Chatwoot route is resolved, how the scheduler claims work and how the
  first admin is created, so an installation without it starts and then fails every authenticated
  request. On PostgreSQL 16+ the grant's own options are the control: `ALTER ROLE …
  NOINHERIT` does **not** override an existing membership, and `pg_has_role(…, 'MEMBER')` answers
  true for a grant made `SET FALSE` that denies every `SET ROLE`.
- **A database restored under a different name resolves a name its own policies do not carry.**
  Nothing errors — `SET ROLE` succeeds and every fleet read then matches no policy and answers zero
  rows — so `db-guard` refuses to serve and prints the repair, which rewrites the POLICIES to name
  the resolved role. Renaming the role instead is the obvious alternative and does not work: the
  documented boot order is bootstrap → migrate → serve, so by the time the guard fires bootstrap has
  already created the resolved role and `ALTER ROLE … RENAME TO` fails on a name that is taken — and
  roles are cluster-wide, so on a server that also runs the database the dump came from, that rename
  would break the live one. The policy rewrite touches nothing outside this database and is safe to
  re-run.

`tenants` is keyed by `id`; `audit_logs` allows `tenant_id NULL` rows only through the fleet policy
(never leaked to a tenant — `tenant_id = <value>` is never TRUE for a NULL row, and a missing GUC
yields NULL, which is not TRUE either). The `users` and `mcp_oauth_*` tables are **global identity
tables, NOT under tenant RLS** — they are read before a tenant context exists, so isolation there is
by explicit `tenant_id` filtering + the `authorize()` gate (see
[`admin.service.ts`](../src/api/features/admin/admin.service.ts)).

## Roles & first-run

`UserRole` is `SUPER_ADMIN | TENANT_ADMIN | AGENT`. A CHECK constraint enforces "`SUPER_ADMIN` ⟺ `tenant_id IS NULL`". The first account is created via `/setup` as `SUPER_ADMIN` (tenant_id NULL) together with an initial `Tenant`, inside one `asSuperAdmin` transaction with an advisory lock + count re-check. `bun set-admin` promotes to `TENANT_ADMIN` of the first tenant (or `SUPER_ADMIN` when no tenant exists yet).

### Role attributes are not inherited, and the boot guard asks the neighbouring question

`SUPERUSER` and `BYPASSRLS` are **role attributes**, and attributes are not inherited through membership — only object privileges are. Against an RLS table, a role that inherits a `BYPASSRLS` role still sees 1 row; it sees 2 only after `SET ROLE` to it. So `assertRuntimeRoleIsNotSuperuser` (`src/lib/db-guard.ts`) asks `pg_has_role(…, 'USAGE')`, which is inheritance, while the real escalation depends on `set_option`, and it is wrong in both directions:

| membership | escalates? | guard |
| --- | --- | --- |
| INHERIT TRUE, SET TRUE | yes | refuses ✓ |
| INHERIT FALSE, SET TRUE | yes | accepts ✗ |
| INHERIT FALSE, SET FALSE | no | accepts ✓ |
| INHERIT TRUE, SET FALSE | no | refuses ✗ |

Under Postgres defaults the two questions coincide (an `INHERIT` role plus a plain `GRANT` is `INHERIT TRUE, SET TRUE`), which is why the guard works. They diverge on a `NOINHERIT` runtime role, where a plain `GRANT` already yields `inherit_option false, set_option true` and escalates unseen, with no deliberate syntax involved. **Deliberately not fixed** (#197): `set_option` is PG16-only, the real predicate is transitive, and hardening would refuse installs that boot today. `MEMBER` is not a substitute — it is true on all four rows, including the two that do not escalate. The limit is recorded in #197's public body under "Not validated", and the measurement in `tests/scripts/db-bootstrap.test.ts`.

## LangGraph checkpointer

Lives in a separate `langgraph` Postgres schema (outside Prisma). `thread_id` is `${tenantId}:${chatwootInstanceId}:${conversationId}` — a raw Chatwoot conversation id collides across tenants, so the prefix is the tenant fence there.

## Verifying isolation

[`tests/lib/tenancy.integration.test.ts`](../tests/lib/tenancy.integration.test.ts) proves fail-closed, scoped reads, RLS overriding an explicit cross-tenant `WHERE`, blocked cross-tenant writes, and `asSuperAdmin` visibility against a real Postgres. [`tests/lib/rls-policy-shape.test.ts`](../tests/lib/rls-policy-shape.test.ts) proves the other half — that the tenant predicate lands as an `Index Cond` rather than a `Filter`, that `app.is_super_admin` now grants nothing, and that every table under RLS carries the policy pair and the membership is not inherited. It reads `TEST_APP_DATABASE_URL` (the app role) and skips when no DB is reachable, though the suite no longer starts at all in that state unless the run declares `ALLOW_NO_DB=1` (see [`tests/db-gate.ts`](../tests/db-gate.ts)).
