# Read API, instance identity & outbound webhooks

The substrate for the "one core, three transports" rule: every feature lives in a transport-agnostic service (`src/modules/*/service.ts`, takes `ScopedDb`/`TenantContext` by parameter, no HTTP types); REST v1, the MCP server, and outbound webhooks are thin projections on top. This doc covers the read API, instance identity, and the **outbound** webhook half. The inbound receptor + integration catalog live in [`integrations.md`](integrations.md).

## Read API (`/api/v1/*`)

Versioned, mounted under the `/api` group (so paths are `/api/v1/...`). The same surface serves the React UI and a future fleet dashboard. It goes through `tenancyPlugin` + `requireAuth`; `tenantContext` is derived from the JWT (`X-Tenant-Id` is honored only for `SUPER_ADMIN`, ignored-and-flagged for everyone else — see [`tenancy.md`](tenancy.md)).

Current endpoints: `GET /api/v1/meta`, `GET /api/v1/tenants`, `GET /api/v1/tenants/:id`. Conversations/metrics/funnel projections arrive in their phases.

**Isolation-preserving projection.** Fleet-facing surfaces (read API, outbound webhooks, MCP read resources, SUPER_ADMIN cross-tenant) expose metrics + state + control by default, never message bodies or PII. A per-instance toggle opts a tenant into raw detail.

## Instance identity

`instanceIdentity` (`src/lib/instance.ts`) = `{ instanceId, name, version }`, stamped on every read-API response and outbound webhook payload so a fleet can attribute events to the emitting instance. `instanceId` is `INSTANCE_ID` (pinned across restarts/replicas) or a per-process random UUID for the single-replica MVP.

## Outbound webhooks (`src/modules/webhooks/outbound/`)

Three parts: the **closed event set + envelope** (`events.ts`), the deterministic **emit** side (called inline by domain code), the background **delivery worker**, and a **REST CRUD** for the subscription targets.

### Event set & envelope — `events.ts`

`OUTBOUND_EVENTS` is the single closed set; `OutboundEvent` is its union (emit is typed to it, the REST CRUD validates each subscribed event against it, the UI lists it via `GET .../webhooks/events`). The canonical events and their sanitized `data` projections (ids/status/counters/money only — never message bodies, contact PII, tokens, or raw entities):

| event                          | seam                                              | `data`                                                                                  |
| ------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `conversation.created`         | `chatwoot/mirror.ts` (Conversation create)        | `conversation_id, inbox_id, status, assignee_type`                                       |
| `conversation.status_changed`  | `chatwoot/mirror.ts` (status differs)             | `conversation_id, inbox_id, status, previous_status, assignee_type`                      |
| `conversation.handoff`         | `chatwoot/mirror.ts` (assignee → `User`)          | `conversation_id, inbox_id`                                                              |
| `kanban.card_moved`            | `graph/tools/native.ts` (`kanban_move_card`)      | `card_id, to_step, conversation_id`                                                      |
| `llm.usage`                    | `graph/usage.ts` (`defaultUsagePersist`)          | `agent_id, conversation_id, model, node, prompt_tokens, completion_tokens`               |
| `tenant.created`               | `api/v1/tenants.service.ts` (`createTenant`)      | `tenant_id, slug`                                                                        |
| `heartbeat`                    | `webhooks/outbound/heartbeat.ts` (periodic)       | `at, version`                                                                            |

Every emission is wrapped by `buildOutboundEnvelope(tenantId, event, data)` into a **versioned envelope** stored verbatim as the delivery payload and POSTed as-is by the worker:

```json
{ "version": 1, "instance_id": "…", "event": "conversation.created",
  "occurred_at": "2026-…Z", "tenant_id": "42", "data": { … } }
```

`occurred_at` is stamped at emit time (when the event happened), not at delivery. The delivery id (retry dedupe key) is NOT in the envelope — it travels in the `x-fazerai-delivery` header.

**Emit is best-effort for the domain.** Each seam wraps `emitOutbound` in a try/catch and logs on failure: enqueueing a fan-out row must never break the primary effect (the mirror write, the usage row, the tenant create). When viable the emit runs inside the same scoped tx as that effect.

`heartbeat` is a periodic liveness ping. It rides the scheduler (not a wall-clock cron) via a single self-re-arming `HEARTBEAT` `SchedulerJob` **per tenant** (`webhooks/outbound/heartbeat.ts`): the `dedupeKey` is constant, so `unique(tenant, kind, dedupeKey)` guarantees **at most one job per tenant** no matter how many heartbeat subscriptions exist (0 subs → no job, 1..N → 1 job). It is armed **lazily** — `syncTenantHeartbeat` runs after every subscription mutation and arms the job when an enabled `heartbeat` subscription exists, or cancels it when the last one is gone; the handler also self-terminates (`emitOutbound` returns 0 matched subs → the job ends) as a backstop. Each tick emits `{ at, version }` and re-arms `config.heartbeat.intervalMs` later (`HEARTBEAT_INTERVAL_MS`, default 1 min). Like every emitter, deliveries only go to subscriptions that list `heartbeat`.

### Emit — `emitOutbound(db, tenantId, event, data)`

Called inside the caller's scoped transaction. Wraps `data` in the envelope (above) and inserts one `OutboundWebhookDelivery` (status `PENDING`) per enabled `WebhookSubscription` that lists the event. `data` MUST be the allowlist-sanitized projection. Returns the number of deliveries enqueued.

### REST CRUD — `/api/v1/webhooks/*` (`webhooks.controller.ts` + `subscriptions.ts`)

TENANT_ADMIN. RLS fences every read/write to the active tenant; the secret value never crosses the surface — `secretRef` is a NAME into the tenant vault.

- `GET /webhooks/events` — the closed `OUTBOUND_EVENTS` set (for the UI multiselect).
- `GET /webhooks/subscriptions` — list this tenant's subscriptions.
- `POST /webhooks/subscriptions` — create (`url`, `events[]`, optional `secretRef`, `enabled`).
- `PATCH /webhooks/subscriptions/:id` — update any of those (`secretRef: null` clears it).
- `DELETE /webhooks/subscriptions/:id` — delete (clears its deliveries first, FK is `Restrict`).

Validation: each `event` ∈ `OUTBOUND_EVENTS` (unknown → 400 `errors.unknownWebhookEvent`); `url` passes `assertSafeOutboundUrl` (anti-SSRF, https-only) on create/update. A foreign/missing id under RLS yields 404, never a cross-tenant write. UI: the `/webhooks` page (top-level nav, admin-gated).

### Delivery worker — `src/modules/webhooks/outbound/worker.ts`

A single-replica tick (`WEBHOOK_WORKER_ENABLED`, `WEBHOOK_WORKER_INTERVAL_MS`) that:

1. **Reaps** stale `SENDING` rows (a crash between claim and outcome would strand them) back to `PENDING` — cross-tenant via `asSuperAdmin`; `attempts` untouched (the claim never bumped it).
2. **Claims** due `PENDING` deliveries cross-tenant (`asSuperAdmin`, the worker has no tenant) with `UPDATE ... FROM (SELECT ... FOR UPDATE OF d SKIP LOCKED LIMIT n) ...` flipping them to `SENDING`. The `enabled = true` join leaves a disabled subscription's deliveries `PENDING` (it does not kill them).
3. For each, **outside any transaction**: `assertSafeOutboundUrl` (anti-SSRF, https-only, no redirects), resolves the per-tenant signing secret via a **tenant-scoped** read (`runScopedOn`, RLS active — least privilege, not the cross-tenant bypass), signs, and POSTs with a timeout.
4. **Records the outcome** scoped to the row's tenant: `DELIVERED` (2xx); back to `PENDING` with `nextAttemptAt` from full-jitter backoff (`nextBackoffMs`); or `DEAD` after `MAX_ATTEMPTS`. An SSRF-blocked URL goes straight to `DEAD` (it can never succeed).

Headers: `x-fazerai-delivery` (the delivery id — a **stable dedupe key**, so at-least-once retries are safe for receivers), and when a secret is configured `x-fazerai-signature` (`sha256=` + HMAC-SHA256 over `"{timestamp}.{rawBody}"`, hex) + `x-fazerai-timestamp` (unix seconds). Receivers verify the timestamp window (anti-replay) and recompute over the raw body. See `signing.ts` (`signOutbound`/`verifyOutboundSignature`); every emit site builds its headers through `outboundHeaders`.

> **Compatibility window.** These headers were named `x-secretaria-*` before the brand rename. Both sets go out on every delivery, carrying identical values, so a receiver configured against either name keeps working. The legacy trio is dropped at `2.0` — point your receivers at `x-fazerai-*` before then.

**Single-replica invariant.** The worker holds a reentrancy guard (`running`) and an interval on `globalThis` (so `bun --hot` does not stack phantom timers); `stopOutboundWorker` runs on `SIGTERM`/`SIGINT`. `FOR UPDATE SKIP LOCKED` already future-proofs the claim, but scaling the app beyond one replica needs a leader election or durable claim before the worker is enabled on every instance. `WebhookSubscription.onDelete` is `Restrict` (never `Cascade`, which would drop in-flight deliveries).
