# Read API, instance identity & outbound webhooks

The substrate for the "one core, three transports" rule: every feature lives in a transport-agnostic service (`src/modules/*/service.ts`, takes `ScopedDb`/`TenantContext` by parameter, no HTTP types); REST v1, the MCP server, and outbound webhooks are thin projections on top. This doc covers the read API, instance identity, and the **outbound** webhook half. The inbound receptor + integration catalog live in [`integrations.md`](integrations.md).

## Read API (`/api/v1/*`)

Versioned, mounted under the `/api` group (so paths are `/api/v1/...`). The same surface serves the React UI and a future fleet dashboard. It goes through `tenancyPlugin` + `requireAuth`; `tenantContext` is derived from the JWT (`X-Tenant-Id` is honored only for `SUPER_ADMIN`, ignored-and-flagged for everyone else — see [`tenancy.md`](tenancy.md)).

Current endpoints: `GET /api/v1/meta`, `GET /api/v1/tenants`, `GET /api/v1/tenants/:id`. Conversations/metrics/funnel projections arrive in their phases.

**A query filter is used or refused, never dropped.** Every read surface parses its filters through `src/api/lib/query-filters.ts` (`parseQueryInstant` / `parseQueryId` / `parseQueryCount`), and a value the server cannot use is answered **400 naming the parameter** (`{ error, field }`, key `errors.invalidQueryParam`). The lenient spellings this replaced each had their own wrong answer: `agentId=abc` dropped the filter and returned the tenant's whole table, `cursor=abc` restarted pagination so a client following `nextCursor` never terminated, `since=2026-02-30T00:00:00Z` normalised to March 2 and queried a window nobody asked for, and `limit=abc` reached Prisma as `take: NaN` — a 500 for a caller's typo. Empty is a value, not an absence: `?agentId=` is what a form submits when its input is blank, and reading it as "no filter" is the same widening. The RANGE of a count lives in the SERVICE (`assertUsableCount` in `src/lib/query-param.ts`), not in the parser, so MCP and the console's own service calls are held to it too. An instant filter takes an ISO 8601 instant with an offset; a date alone is refused. Issues #305 / #361 settled this for the delivery ledger and #372 applied it to the rest.

**A mutation records itself, and the record names what changed and not which door.** `auditMutation` (`src/modules/audit/service.ts`) appends the `AuditLog` row from INSIDE the service performing the write, in the same transaction: `await auditMutation(db, ctx, { action, target, before, after })`. It exists because the trail used to be written by the MCP transport, after the service it called had already committed, which cost both halves of what an audit is for. It covered one door of three, so the console (REST) left no row at all; and its second transaction could fail on its own, landing a change with nothing saying who made it. Because the row now comes from the shared core, the action is `<entity>.<verb>` and the transport is carried by `TenantContext.actorType` (`user` for a cookie session, `api_key` for a Bearer key, `mcp` behind an MCP token, `system` for a mutation no request asked for). The projection is bounded by the seam, so a call site cannot forget; what goes IN it is still the caller's allowlist, never a secret and never a message body. Rows written under the old `mcp.<tool>` names stay as they are. #392 built the seam and moved business hours; the remaining families are sub-issues of #306.

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
- `DELETE /webhooks/subscriptions/:id` — delete (clears its deliveries first, in the same scoped transaction).

Validation: each `event` ∈ `OUTBOUND_EVENTS` (unknown → 400 `errors.unknownWebhookEvent`); `url` passes `assertSafeOutboundUrl` (anti-SSRF, https-only) on create/update. A foreign/missing id under RLS yields 404, never a cross-tenant write. UI: the `/webhooks` page (top-level nav, admin-gated).

### Delivery ledger — `/api/v1/webhooks/deliveries*` (`deliveries.ts`)

TENANT_ADMIN, RLS-scoped, keyset paginated by id desc (same shape as `/v1/logs`). Added by issue #305: before it there was no delivery-facing route at all, so watching for events that never arrived meant reading `outbound_webhook_deliveries` in Postgres — a table whose columns the worker owns and changes without a deprecation window.

- `GET /webhooks/deliveries` — filters `status` (`PENDING|SENDING|DELIVERED|DEAD`, unknown → 400), `subscriptionId`, `event`, `since`/`until`, `limit` (default 50, max 200), `cursor`. `status=DEAD` is the dead-letter view.
- `GET /webhooks/deliveries/:id` — one delivery.
- `POST /webhooks/deliveries/:id/requeue` — put a **DEAD** delivery back in the worker's queue.

**The payload never crosses this surface.** It is the tenant's own data, it does not go through the PII scrub `execution_logs` rows get at write, and the subscriber already receives it at their endpoint — the ledger answers whether the event arrived, not what was in it. Same call as the dead-delivery alert line (#325).

**Requeue semantics.** `status` → `PENDING`, `attempts` → **0**, `nextAttemptAt` → null, `lastError` kept. The reset is what makes it a requeue: `finalizeFailure` gives up at `attempts + 1 >= MAX_ATTEMPTS`, so a row put back at 8 dies on its first post while the same row at 0 earns the full ladder. The count it died at survives in the `webhook` flow-log line. Only `DEAD` is accepted, and the guard is the `status: "DEAD"` in the update's own `where` rather than a branch above it: `SENDING` means a POST is in flight and a second claim would deliver it twice, `PENDING` is already queued, and replaying a `DELIVERED` event is a different promise. Any other status is refused with 409 naming it. The requeue writes one `info` `webhook` flow-log line (`action: "requeued"`, `attemptsBefore`, `subscriptionEnabled`) — `info` never pages, since `dispatchAlertsForEvent` only routes `warn`/`error`.

`subscriptionEnabled` rides on every delivery DTO because the claim joins `enabled = true`: a delivery on a disabled subscription sits at `PENDING` untouched, and without that field a correct requeue is indistinguishable from one that did nothing.

MCP: `webhook_delivery_list`, `webhook_delivery_get` (`mcp:read`), `webhook_delivery_requeue` (`mcp:write`, dry-run by default and audited on apply).

### Delivery worker — `src/modules/webhooks/outbound/worker.ts`

A single-replica tick (`WEBHOOK_WORKER_ENABLED`, `WEBHOOK_WORKER_INTERVAL_MS`) that:

1. **Reaps** stale `SENDING` rows (a crash between claim and outcome would strand them) back to `PENDING` — cross-tenant via `asSuperAdmin`; `attempts` untouched (the claim never bumped it).
2. **Claims** due `PENDING` deliveries cross-tenant (`asSuperAdmin`, the worker has no tenant) with `UPDATE ... FROM (SELECT ... FOR UPDATE OF d SKIP LOCKED LIMIT n) ...` flipping them to `SENDING`. The `enabled = true` join leaves a disabled subscription's deliveries `PENDING` (it does not kill them).
3. For each, **outside any transaction**: `assertSafeOutboundUrl` (anti-SSRF, https-only, no redirects), resolves the per-tenant signing secret via a **tenant-scoped** read (`runScopedOn`, RLS active — least privilege, not the cross-tenant bypass), signs, and POSTs with a timeout.
4. **Records the outcome** scoped to the row's tenant: `DELIVERED` (2xx); back to `PENDING` with `nextAttemptAt` from full-jitter backoff (`nextBackoffMs`); or `DEAD` after `MAX_ATTEMPTS`. An SSRF-blocked URL goes straight to `DEAD` (it can never succeed).

Headers: `x-fazerai-delivery` (the delivery id — a **stable dedupe key**, so at-least-once retries are safe for receivers), and when a secret is configured `x-fazerai-signature` (`sha256=` + HMAC-SHA256 over `"{timestamp}.{rawBody}"`, hex) + `x-fazerai-timestamp` (unix seconds). Receivers verify the timestamp window (anti-replay) and recompute over the raw body. See `signing.ts` (`signOutbound`/`verifyOutboundSignature`); every emit site builds its headers through `outboundHeaders`.

> **Compatibility window.** These headers were named `x-secretaria-*` before the brand rename. Both sets go out on every delivery, carrying identical values, so a receiver configured against either name keeps working. The legacy trio is dropped at `2.0` — point your receivers at `x-fazerai-*` before then.

**Single-replica invariant.** The worker holds a reentrancy guard (`running`) and an interval on `globalThis` (so `bun --hot` does not stack phantom timers); `stopOutboundWorker` runs on `SIGTERM`/`SIGINT`. `FOR UPDATE SKIP LOCKED` already future-proofs the claim, but scaling the app beyond one replica needs a leader election or durable claim before the worker is enabled on every instance. The delivery FK is `ON DELETE CASCADE` at the database (`20260727000000_init`), so what keeps a subscription delete from silently dropping rows the worker is mid-delivery is the service, not the constraint: `deleteWebhookSubscription` clears the deliveries explicitly inside the same RLS-scoped transaction, and that delete is operator-initiated.
