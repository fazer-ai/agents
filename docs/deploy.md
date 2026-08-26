# Deploy

fazer.ai agents is one Bun process (API + bundled SPA + LangGraph runtime + background workers) plus a PostgreSQL with the `pgvector` extension. This doc is the canonical deploy contract; the per-platform sections at the end are thin wrappers over the same model.

## Load-bearing invariants

These are not optional. Two of them are enforced at boot (the process refuses to start when violated), the rest will silently break isolation or migrations if ignored.

### 1. Two database roles (never one)

| Role | Used for | Privilege |
| --- | --- | --- |
| **migration/owner** (`MIGRATION_DATABASE_URL`) | `prisma migrate deploy`, `db-bootstrap.ts`, `CREATE EXTENSION vector`, enum/role DDL | superuser or DB owner |
| **runtime** (`DATABASE_URL`, `LANGGRAPH_DATABASE_URL`) | the running server, every tenant query | **NON-superuser, NON-bypassrls** |

The whole multi-tenant isolation model is Postgres Row-Level Security, and **RLS is a silent no-op for superusers and bypassrls roles**. So the runtime connection must never be privileged. The server calls `assertRuntimeRoleIsNotSuperuser` at boot: in production it **hard-crashes** (crash-loops until the URL is fixed) if the runtime role is superuser/bypassrls (directly or via role membership). Locally you may point `DATABASE_URL` at the superuser and set `ALLOW_SUPERUSER_RUNTIME=true` to downgrade that to a warning — never in production (the flag is ignored when `NODE_ENV=production`).

`FORCE ROW LEVEL SECURITY` is set on every tenant table, so even the table owner is subject to policies — only superuser/bypassrls bypass, which is exactly what the boot guard forbids.

> **The migration role does not have to be a real superuser, and on managed Postgres it never is.** RDS, Coolify and EasyPanel hand you an administrative role that is `CREATEROLE` and owns the database with `rolsuper = false`, and PostgreSQL 16 made two of bootstrap's statements superuser-only: `ALTER ROLE … NOSUPERUSER` (the privilege check fires on the option being *present*, not on its value) and `CREATE SCHEMA … AUTHORIZATION` (creating an object owned by another role now requires being able to `SET ROLE` to it). `db-bootstrap.ts` reads the catalog and picks statements that role may run, so provisioning completes without one. Its log line says which mode it ran in (`admin=superuser` / `admin=non-superuser`, plus the server version). The one thing it still cannot do without a superuser is take `SUPERUSER`/`BYPASSRLS` **off** a runtime role that already has them; it refuses with the exact `ALTER ROLE` a superuser has to run. It also does not take ownership of existing `langgraph` tables away from any role but the migration account itself — re-owning a table strips the previous owner's privileges immediately, which would cut off a container still serving on that role mid-deploy — so when a checkpointer migration needs that ownership, the boot log names the `ALTER TABLE … OWNER TO` to run instead of doing it.

### 2. pgvector image

Postgres must ship the `vector` extension. Use **`pgvector/pgvector:pg17`** (matches the validated isolation spike), not `postgres:17-alpine` — plain Postgres has no `vector` and `CREATE EXTENSION vector` in bootstrap fails.

### 3. Deterministic provisioning, then migrate, then serve

Boot ordering, one-shot per start and safe under restart:

```
bun scripts/db-bootstrap.ts && bun prisma migrate deploy && exec bun src/index.ts
```

- **`db-bootstrap.ts`** connects as the migration superuser and provisions exactly the runtime role encoded in `DATABASE_URL` (creates it NON-superuser/NON-bypassrls, grants on existing + future objects via `ALTER DEFAULT PRIVILEGES`, creates the `langgraph` checkpointer schema). It does **not** rely on Postgres `initdb.d`, which only runs on an empty data volume — managed Postgres (Coolify/EasyPanel) provisions the DB for you with no mount, so `initdb.d` never runs and the app role would never exist. The script is the platform-independent mechanism. (For a bare Postgres you control the volume of, `scripts/db-bootstrap.sql` is the equivalent psql script.)
- **`prisma migrate deploy`** runs as the owner. `prisma.config.ts` prefers `MIGRATION_DATABASE_URL` and substitutes `${POSTGRES_PORT}` manually (the Prisma CLI does not expand it). `prisma` is a runtime **dependency** (not devDependency) so the CLI exists in the `--production` image.
- **`bun src/index.ts`** runs the server interpreted and connects as the runtime role. We do **not** ship a `bun build --compile` binary: bundling this app trips a Bun heap-corruption bug (pinned to `@elysiajs/static`), so the compiled binary segfaults at boot while the interpreted source is immune. Full investigation + repro in [`bun-compile-segfault.md`](bun-compile-segfault.md).

> **Dev gotcha — grants do not survive a reset.** `prisma migrate reset` (and a `migrate dev` that decides to reset on drift) drops and recreates the `public` schema, wiping the runtime role's grants. The next boot then fails every query with Postgres `42501` (`permission denied for schema public`). Fix: re-run `bun db:bootstrap` (idempotent) and restart. Prefer `bun db:reset`, which chains both. The boot log detects `42501` and prints this exact hint.

> **A DATA migration over a tenant-scoped table needs `SET app.is_super_admin = 'on'`.** Those tables carry `FORCE ROW LEVEL SECURITY`, which subjects even the table OWNER to the tenant policy, and `MIGRATION_DATABASE_URL` is only documented as "superuser **or** owner". On a self-hosted Postgres the migration role is usually a real superuser and the difference never shows; on managed Postgres (RDS/Neon/Supabase) the admin role is typically the owner WITHOUT `rolsuper`, and there a `UPDATE`/`DELETE` across tenants matches **zero rows and reports success**. Set the GUC around the statement (and `RESET` after), exactly as `asSuperAdmin` does at runtime. Schema DDL is unaffected.

Destructive migrations (enum changes, `ACCESS EXCLUSIVE` on `users`) want a maintenance window: on platforms with rolling deploys, run `migrate deploy` as a pre-deploy/one-shot step rather than in every replica's start command.

### 4. Single replica (or one leader)

The realtime pub/sub, the scheduler tick, the debounce worker, the outbound-webhook worker, and the alert-delivery worker are single-process by construction (in-process state + reentrancy guards). **Run one replica.** To scale the web tier: run the extra replicas with `SCHEDULER_WORKER_ENABLED=false`, `WEBHOOK_WORKER_ENABLED=false`, `DEBOUNCE_WORKER_ENABLED=false`, and `ALERT_WORKER_ENABLED=false` (workers off), and keep exactly one "leader" replica with them on. Scaling with workers on every replica causes double-fires and lost cross-replica realtime events (a durable claim / leader election / Redis pub/sub bridge is the post-MVP path).

**One more thing now depends on the single process.** The `ingest:<threadId>` critical section (held by continuous ingestion, a reactive turn, the proactive nudge, memory compaction and `/reset`, all on the same key) is serialized by an in-process queue (`withKeyedQueue`), not by the Postgres advisory lock it used before. That lock had to go: those sections span the LangGraph checkpointer, which is a **separate** connection pool, and holding a Prisma transaction open across it drained the main pool and made unrelated queries fail on `maxWait` (issue #225). The in-flight turn registry (`src/graph/inflight.ts`) was already in-process, so the invariant is not new; its scope is wider.

**The half that loses data no longer depends on it** (issue #203). A turn now takes its claim on the thread's own row and continuous ingestion takes the same claim before appending, so an append and an invoke cannot overlap across replicas: the append stands down with nothing written and the message stays owed, and the thread's watermark is merged under a row lock rather than from a read taken before the checkpointer round-trips. The claim carries a lease, so a crashed replica releases the thread by itself. What still depends on one process is what cannot lose a message: the follow-up nudge may race one reply, and a compaction rewrite undone by a concurrent turn is re-armed at the next attendance boundary.

`/reset` is the one member that still holds a transaction across the checkpointer, deliberately: there the rollback is what keeps a failed checkpoint delete from leaving an operator told the memory was cleared while the thread still answers from it (`src/modules/memory/reset.ts`).

> **Route-token invalidation is process-local.** The Chatwoot receiver caches what a route token resolves to, and every writer that retires one (disconnect, reconnect, re-provision, instance or agent or deployment deletion) clears the cache in **its own** process. With extra web replicas, a change handled by replica A leaves replica B holding the old answer until B's own entry ages past its TTL, at which point B serves that one delivery from the retired route and the refresh it fires behind the ack corrects it. One delivery per replica per change, self-healing. Closing it needs the same cross-replica bridge as the rest of this section. Note the alternative is worse, not better: a longer hard TTL widens the same window instead of correcting it, and a shorter one puts a Postgres round trip back inside the 5s ack budget, which is the failure the cache exists to prevent.

### 5. CSP / build

Production serves `dist/index.html`; its inline-script hashes are baked into the CSP at build time. Rebuild (`bun run build`) after editing any inline script. Per-tenant theming uses `setProperty` (DOM API, no inline `<style>`) precisely so it does not break the CSP hash.

## Environment variables

See `.env.example` for the full list. Deploy-critical:

- `MIGRATION_DATABASE_URL` — superuser/owner (migrations + bootstrap).
- `DATABASE_URL` — runtime role (non-superuser). Boot fails if privileged.
- `LANGGRAPH_DATABASE_URL` — checkpointer pool; use the runtime (non-superuser) role, **not** the migration URL (a superuser checkpointer pool would ignore any future RLS on `langgraph`).
- `JWT_SECRET`, `ENCRYPTION_KEY` — strong unique secrets. Rotating `ENCRYPTION_KEY` invalidates all encrypted-at-rest data (vault, Chatwoot tokens).
- `PUBLIC_URL`, `CORS_ORIGIN`, `PORT`.
- Langfuse is **per-tenant** (a `langfuse` vault entry), never a global env var. To self-host the Langfuse instance itself (optional companion service), use [`deploy/langfuse/`](../deploy/langfuse/): it bundles the **MinIO blob storage that v3 ingestion requires** — the upstream one-click omits it, so reads (and the credential "test") pass while every ingest 500s and traces silently vanish. Coolify (magic vars) + Portainer/generic flavors and a verify-ingestion recipe are in its README.

## Platforms

### Coolify (first-class)

Use `docker-compose.coolify.yml`. Coolify auto-generates the magic env vars:

- `SERVICE_USER_DBUSER` / `SERVICE_PASSWORD_64_DBPASSWORD` — the Postgres superuser (owner; migrations + bootstrap).
- `SERVICE_USER_APPDBUSER` / `SERVICE_PASSWORD_64_APPDBPASSWORD` — the runtime app role (created by bootstrap).
- `SERVICE_PASSWORD_64_JWTSECRET`, `SERVICE_PASSWORD_64_ENCRYPTIONKEY`, `SERVICE_URL_AGENTS`.

The compose runs bootstrap → migrate → serve in the app `command`. Keep a single replica.

### Portainer (Tier B)

The onboarding's Tier B adapter drives Portainer over its API and bundles **Caddy** for automatic TLS. Use [`docker-compose.portainer.yml`](../docker-compose.portainer.yml) (self-contained app + Postgres + Caddy; `gen-onboarding-env.ts` fills the `.env`). The full headless flow (install → admin/setup-token → API key → registry creds → `POST /stacks/create/standalone/string` → verify), the brownfield discovery, and the Chatwoot Pro/OSS + Langfuse companions live in the `agents-onboarding` skill (`references/deploy-b-portainer.md`).

### EasyPanel / plain compose

Same model, bring-your-own-proxy. Use [`docker-compose.prod.yml`](../docker-compose.prod.yml) (publishes the app's HTTP port; terminate TLS in front), provide a `pgvector/pgvector:pg17` Postgres, set the two URL pairs (superuser vs app role), and keep the image's bootstrap→migrate→serve command. On EasyPanel set the env vars in the service UI; for a plain VM, `gen-onboarding-env.ts` writes the `.env` and `docker compose -f docker-compose.prod.yml up -d` brings up the stack.
