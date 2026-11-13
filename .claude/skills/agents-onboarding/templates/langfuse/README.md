# Langfuse (self-hosted) for fazer.ai

Optional companion service for **agent tracing**. Langfuse is wired into fazer.ai agents **per-tenant
via a `langfuse` vault credential** (never a global env var); see `docs/deploy.md`
and `docs/graph.md`. This folder vendors a deploy that actually works, in the
project's three flavors (Coolify primary; Portainer and a generic "Outros" path, per
`docs/deploy.md`).

## Why this exists (the bug the one-click hides)

Langfuse v3 **requires S3-compatible blob storage for ingestion**: on every
`POST /api/public/ingestion`, the web container uploads the raw event JSON to S3 **before** queueing
it to ClickHouse. The official Langfuse one-click / Coolify template declares the `LANGFUSE_S3_*`
variable **names** but ships them **empty** and bundles **no** object-storage service.

Result, observed in production-like testing:

- `GET /api/public/projects` reads **Postgres only** → returns `200`. A naive "test connection"
  (which is exactly what the Langfuse credential test does) **passes**, so the instance looks healthy.
- `POST /api/public/ingestion` tries to upload to S3 with empty creds → the AWS SDK throws
  `Could not load credentials from any providers` → `Failed to upload events to blob storage,
  aborting event processing` → **HTTP 500** (plain text, not JSON).
- The Langfuse client SDK then chokes parsing the non-JSON 500 body, and in its background flush
  path the error is swallowed. Net effect: **traces silently never arrive**, with no client-side
  error and nothing in the producing app's logs.

This is **not** a bug in fazer.ai agents (the trace handler builds, enqueues, and POSTs correctly) and
**not** a flush/runtime issue: it is a missing-storage deploy gap. These compose files bundle
**MinIO** and wire all three S3 families (`EVENT_UPLOAD`, `MEDIA_UPLOAD`, `BATCH_EXPORT`) to it.

## Files

| File | Use |
| --- | --- |
| `docker-compose.coolify.yml` | **Coolify** (primary). Uses Coolify magic vars (`SERVICE_*`); secrets auto-generated. |
| `docker-compose.yml` | **Generic**: Portainer / EasyPanel / Dokploy / plain Docker. Secrets from `.env`. |
| `.env.example` | Template for the generic flavor. `cp .env.example .env`, fill every `CHANGE_ME`. |

Both composes are identical in topology, `langfuse` (web) + `langfuse-worker` + `postgres` +
`redis` + `clickhouse` + **`minio`**, and differ only in how secrets are supplied.

## Deploy

### Coolify (primary)

1. New Resource → **Docker Compose** → paste `docker-compose.coolify.yml`.
2. Set the service **Domain** to your Langfuse FQDN (Coolify fills `SERVICE_FQDN_LANGFUSE_3000` /
   `SERVICE_URL_LANGFUSE`). Coolify generates `SERVICE_USER_MINIO`, `SERVICE_PASSWORD_MINIO`, and all
   other `SERVICE_*` secrets automatically; **do not** set them by hand.
3. Deploy. Confirm `minio` becomes healthy, then verify ingestion (below).

> The blob-storage creds are the same Coolify magic vars used by the `minio` service, so the web,
> the worker, and MinIO always agree without you copying a secret around. That is the point of using
> magic vars here instead of hardcoded `LANGFUSE_S3_*` values.

### Portainer / EasyPanel / Dokploy / plain Docker (generic)

```sh
cp .env.example .env      # fill every CHANGE_ME (see the openssl hints in the file)
docker compose up -d
```

Portainer: paste `docker-compose.yml` as a Stack and provide the same variables via the Stack env
editor instead of a `.env` file. Put your own TLS-terminating reverse proxy in front of port 3000.

### Magic var ↔ generic env mapping

| Coolify magic var | Generic `.env` | Purpose |
| --- | --- | --- |
| `SERVICE_USER_MINIO` / `SERVICE_PASSWORD_MINIO` | `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO creds = the S3 access key/secret |
| `SERVICE_USER_POSTGRES` / `SERVICE_PASSWORD_POSTGRES` | `POSTGRES_USER` / `POSTGRES_PASSWORD` | Postgres |
| `SERVICE_USER_CLICKHOUSE` / `SERVICE_PASSWORD_CLICKHOUSE` | `CLICKHOUSE_USER` / `CLICKHOUSE_PASSWORD` | ClickHouse |
| `SERVICE_PASSWORD_REDIS` | `REDIS_PASSWORD` | Redis |
| `SERVICE_PASSWORD_SALT` | `LANGFUSE_SALT` | Langfuse salt |
| `SERVICE_PASSWORD_64_LANGFUSE` | `LANGFUSE_ENCRYPTION_KEY` | 256-bit encryption key (64 hex) |
| `SERVICE_BASE64_NEXTAUTHSECRET` | `LANGFUSE_NEXTAUTH_SECRET` | NextAuth secret |
| `SERVICE_URL_LANGFUSE` | `LANGFUSE_PUBLIC_URL` | Public URL |

## Seed everything headless (agent-driven, one deploy)

The agent does **not** ask the user to copy keys out of the UI, and does **not** open signup. It
provisions everything on the first boot (Langfuse's own recommended headless-init pattern):

1. The agent generates a `pk-lf-…` / `sk-lf-…` key pair, an org id + name, a project id + name, and a
   strong temporary password (include a non-alphanumeric char). The user email is the operator's, reused
   from the Chatwoot admin so they have one login across tools.
2. The agent sets, on the service env (Coolify) or `.env` (generic), and deploys **once** with
   `AUTH_DISABLE_SIGNUP=true` (the template default):
   - `LANGFUSE_INIT_USER_EMAIL` / `_NAME` / `_PASSWORD`
   - `LANGFUSE_INIT_ORG_ID` / `_NAME`
   - `LANGFUSE_INIT_PROJECT_ID` / `_NAME` / `_PUBLIC_KEY` / `_SECRET_KEY`

   On boot Langfuse creates the **user (org OWNER) + org + project + keys**. The user requires the org
   (seed them together); it upserts by id, so a redeploy never duplicates.
3. The operator **signs in** at `/auth/sign-in` (never signs up) with the seeded email + the generated
   password (the agent shows it) and changes it on first login. The seed is create-if-not-exists
   (verified: the password change survives redeploys), so the operator's real password never passes
   through the agent. The agent already holds the keys and wires them into fazer.ai agents (below).

Empirically validated with this template's compose: the `LANGFUSE_INIT_USER` becomes org `OWNER`, the
seeded user signs in (session shows `role: OWNER`), the seeded keys authenticate ingestion, and
signup returns `422 Sign up is disabled` from the start, with no open-signup window.

## Verify ingestion actually works

A green health check is **not** enough (it only proves Postgres). Confirm a trace round-trips:

```sh
# 1) use the seeded pk-lf-…/sk-lf-… pair (or create one in the UI), then:
PK=pk-lf-...; SK=sk-lf-...; BASE=https://langfuse.example.com

# 2) POST one OTLP span (the endpoint the app exports to), expect HTTP 200 (NOT 500):
NOW=$(date +%s)000000000
curl -s -u "$PK:$SK" -H 'Content-Type: application/json' -X POST "$BASE/api/public/otel/v1/traces" \
  -d '{"resourceSpans":[{"resource":{"attributes":[]},"scopeSpans":[{"scope":{"name":"langfuse-sdk"},"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","name":"verify","kind":1,"startTimeUnixNano":"'$NOW'","endTimeUnixNano":"'$NOW'","attributes":[{"key":"langfuse.observation.type","value":{"stringValue":"span"}}]}]}]}]}' \
  -w '\n[http %{http_code}]\n'

# 3) read it back (give the worker a few seconds to flush to ClickHouse):
curl -s -u "$PK:$SK" "$BASE/api/public/traces?limit=5"
```

A `500` here means blob storage is still misconfigured: check the `langfuse` (web) container logs
for `Failed to upload events to blob storage`.

## Wire into fazer.ai agents

Tracing is per-tenant. The agent uses the MCP **`langfuse_connect`** tool: it takes the public key +
secret key + base URL inline, creates the `langfuse` vault credential, and turns tracing on in one call
(`docs/mcp.md`). The equivalent by hand is a `langfuse` vault credential (`POST /v1/vault` with
`kind:"langfuse"`, `value:{publicKey, secretKey}`, `baseUrl:"https://langfuse.example.com"`) then
`PUT /v1/tenant-settings/langfuse {enabled:true, credentialRef:"vault:<id>"}`. The connection test on
the credential checks reachability + auth (Postgres path); the **ingestion** verification above is what
proves traces will land. See `references/05-langfuse.md`.
