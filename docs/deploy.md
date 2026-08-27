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

> **A fleet role left behind by a previous database of the same name needs one manual grant.** The cross-tenant path is a role whose name carries the database (`fazerai_fleet_<db>_<hash>`, see [tenancy](tenancy.md)). Roles are cluster-wide while databases are not, so dropping and recreating a database leaves the old role standing — and a `CREATEROLE` administrator holds no `ADMIN` over a role it did not create, so the membership grant is refused with `permission denied to grant role`. Bootstrap reports that and finishes: nothing tenant-scoped depends on the membership, and the failure that follows is loud and contained (`permission denied to set role` on every fleet call, tenant traffic unaffected). The boot log names both the statement and who can run it — a superuser, or the administrator that created the role, either directly or after `GRANT <that role> TO <administrator> WITH ADMIN OPTION;`.

> **Rotating `DATABASE_URL` to a new role: name the outgoing role while the two overlap.** During the overlap a rolling deploy has two live containers, and `docs/deploy.md` promises the one still serving on the outgoing role keeps working until it drains. Bootstrap reconciles membership in the fleet role down to this database's runtime role and the administrator, so without being told, it revokes the outgoing role's membership and every `asSuperAdmin` call in the old container — API-key verification included — starts reading zero rows mid-deploy. Declare it for the length of the transfer: set `FLEET_ROLE_RETAIN_MEMBER=<outgoing role>` on the incoming container (comma-separated for more than one), or `SET fazerai.retain_fleet_member = '<outgoing role>';` before `scripts/db-bootstrap.sql`. It is not inferred from an open session, and that was measured rather than chosen: drop a database and recreate it under the same name, and the stale installation's pool reconnects to that name, so its role presents exactly the same live session as a rotation while being the leftover the reconcile exists to remove. The declaration is what authorises keeping the access; the session is what bounds it, so a variable left behind after the deploy clears itself on the first boot with the old process gone.

> **A database restored or cloned under a different name does not serve, and the boot repairs what it can.** The copied `fleet_super_admin` policies still name the source installation's fleet role, and the copied grants still give that role every table, while role memberships are cluster-wide and survive being copied around. Measured: the source's runtime role read 30 of 30 rows of the restored database (0 of 30 without the `SET ROLE`). Bootstrap revokes that foreign role's privileges **in the restored database only** — its cluster-wide membership is deliberately left alone, because it belongs to a source installation still running on its own database — and the app then refuses to start on the mismatched policy names. To make the restored copy usable, rewrite the policies to the name the new database derives — the boot refusal prints the exact `DO` block, which is idempotent and touches only this database. **Re-running the migration is not the repair**: it is recorded as applied in the copy, and `prisma migrate resolve --rolled-back` answers `P3012 … not in a failed state` (measured). That flag is for a migration whose own assertion FAILED, which is a different situation the migration's header covers.

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

> **A DATA migration over a tenant-scoped table needs `ALTER TABLE x NO FORCE ROW LEVEL SECURITY;` … `ALTER TABLE x FORCE ROW LEVEL SECURITY;` around the statement.** Those tables carry `FORCE ROW LEVEL SECURITY`, which subjects even the table OWNER to the tenant policy, and `MIGRATION_DATABASE_URL` is only documented as "superuser **or** owner". On a self-hosted Postgres the migration role is usually a real superuser and the difference never shows; on managed Postgres (RDS/Neon/Supabase) the admin role is typically the owner WITHOUT `rolsuper`, and there a `UPDATE`/`DELETE` across tenants matches **zero rows and reports success**. Lifting FORCE rather than entering the cross-tenant role, and that was measured rather than chosen: `prisma migrate dev` replays every migration into a fresh SHADOW database that bootstrap never touches, so the fleet role there has neither grants nor membership and `set_config('role', …)` answers `permission denied to set role`. Measured in that condition, on the same UPDATE: no bypass reaches 0 of 30 rows, the fleet role cannot be entered, and NO FORCE reaches 30 of 30. Only the OWNER's view changes — the runtime role is not the owner — and the whole file is one transaction, so a failure restores FORCE by itself. Leaving it off is the risk, and [`tests/lib/rls-policy-shape.test.ts`](../tests/lib/rls-policy-shape.test.ts) is the backstop: it asserts every table under RLS also FORCES it. Schema DDL is unaffected.
>
> Migrations dated before `20260827000000` use `SET app.is_super_admin = 'on'` instead, and that is correct for them: they run before the policy split (#382), on a database whose policy still read that GUC. After the split the GUC grants nothing, so the old spelling in a NEW migration reaches zero rows silently — [`tests/prisma/migration-rls-bypass.test.ts`](../tests/prisma/migration-rls-bypass.test.ts) refuses each spelling outside its own era.

Destructive migrations (enum changes, `ACCESS EXCLUSIVE` on `users`) want a maintenance window: on platforms with rolling deploys, run `migrate deploy` as a pre-deploy/one-shot step rather than in every replica's start command. **`20260827000000_rls_split_tenant_and_fleet_policies` is the exception to that advice** — a pre-deploy step is precisely the window it cannot survive: from the moment it commits, a process from the previous release has `app.is_super_admin` granting nothing, so every `asSuperAdmin` read it makes returns zero rows until it exits, including API-key verification and Chatwoot route resolution. Stop the old process, migrate, start the new one.

> **A migration that BACKFILLS a new table from an old one wants the old writer stopped first, and `20260826220000_appointment_record` is one.** It copies every live appointment out of the reminder payloads into `appointments`, and from that release on only `appointments` is read. Whatever the previous release books between the backfill committing and its process exiting is written to `scheduler_jobs` alone, so those bookings lose the follow-up pause, the console indicator and the prompt block until their start passes (their reminders still fire — the jobs are there). The window is the swap itself, and it closes by the same instruction as the paragraph above: stop the old process, then `migrate deploy`, then start the new one. Re-running the backfill afterwards is safe — it is `ON CONFLICT DO NOTHING` — so a later repair migration is the remedy if a rollout was done the other way round.

> **A migration that WIDENS a unique key wants the old writer stopped first too, and `20260827000000_appointment_provider` is one.** It replaces `appointments (tenant_id, external_id)` with `(tenant_id, provider, external_id)`, so a booking now identifies itself by the system that issued it (issue #352). The previous release's `recordAppointment` upserts with `ON CONFLICT (tenant_id, external_id)`, and Postgres infers that arbiter from the index this migration drops: from the commit until the old process exits, a booking it handles arms its reminders and then fails to write its record, which is the same loss of the follow-up pause, the console indicator and the prompt block as the paragraph above. Same instruction, same reason: stop the old process, then `migrate deploy`, then start the new one. There is no version of this that both keeps the old arbiter and lets two booking systems issue the same id, which is the defect being fixed. If a rollout was done the other way round, the repair is to re-book (or re-state) the affected appointments — their reminders are in `scheduler_jobs` and name the thread.

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

### Coolify freezes a compose default at creation time

Measured live on Coolify v4.1.2 with a throwaway service: when a compose uses `${VAR:-default}`, Coolify **materializes `VAR` on the service at creation and freezes the resolved value**. Changing the default in the raw compose and saving does NOT change the effective value of a service that already exists — the deployable compose is regenerated (a composed string like `postgres://…/${VAR:-x}` shows the new default) while the materialized variable keeps the old one, and inside the container both forms converge on the OLD value, because the generated `.env` carries the frozen one. The API reports `value=null`/`real_value=null` for the materialized key, so it is not visible there either.

Practical consequence: changing a default in `docker-compose.coolify.yml` is **safe** for existing installs (they stay on the old value) and only new installs get the new one. It also means a rename cannot reach an existing install at all, which is why `DOCUMENTS_STORAGE_DIR` keeps a `QUOTES_STORAGE_DIR` fallback. Not tested: an operator who destroys and recreates the service while reusing the old Postgres volume — that service is born with the new name and does not find the database.

