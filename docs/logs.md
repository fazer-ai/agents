# Execution-flow logs, alerting & retention

Verbose, per-stage operational telemetry for agent turns, plus external alerting and the read/UI surface. Lives in `src/modules/flowlog/`.

## Model

- **`ExecutionLog`** (`execution_logs`): one row per pipeline stage per turn (`stt`, `vision`, `embed`, `generate`, `tts`, `split`, `handoff`) plus errors. `turnId` correlates a turn's stages; `source` is `inbox` | `playground`. High-write, retention-bounded. **NEVER carries message text / PII** — `detail` is allowlisted ids/counts/enums and is passed through `redactSecretsDeep` on write; `errorMessage` through `sanitizeErrorMessage`.
- **`AlertChannel`** (`alert_channels`): a Discord or generic-webhook sink. `url` is an `encryptJson` blob (a Discord URL embeds a token) — stored encrypted, returned only **masked** (`scheme://host/…`); the operator re-enters it to change it (like the vault). `secretRef` is an optional vault ref for the generic-webhook HMAC.
- **`AlertDelivery`** (`alert_deliveries`): the dispatch ledger — **no PII**, only `stage`/`level`/`summary` + a coalesced burst `count`.

All three are in `TENANT_SCOPED_MODELS` with the standard `tenant_isolation` RLS policy.

## Emit (`stages.ts`, `service.ts`)

- `FLOW_STAGES` / `FLOW_LEVELS` are validated Strings, never Prisma enums (adding a stage is no migration).
- `emitFlowEvent(ctx, ev)` is **fire-and-forget**: it schedules the row write without awaiting (unlike `UsageCapture`, which awaits its single billing row) so the hot WhatsApp path never pays log-write latency; losing a line at process shutdown is acceptable. Each emit has its own try/catch — a failed write (or alert dispatch) never escapes into the turn.
- `withFlowStage(ctx, stage, meta, fn)` measures `fn`, emits `ok`/`error` (then **re-throws**), and is a zero-overhead pass-through when `ctx` is absent.
- A turn generates one `turnId` (`crypto.randomUUID()`) in `runLoadedTurn` / `runPlaygroundTurn`. STT is **eager** (before the turn), so it has its own `turnId`; correlate it in the UI by `threadId`.

### Seams wired

`generate` (runtime + playground graph invoke), `stt` (`transcribeInboundAudio`), `vision` (`extractInboundFile` + the playground's `extractPlaygroundFile`; the two-step playground UI logs it under step 1's `extract` call), `tts` (`synthesizeReply`), `split` (`deliverReply`), `handoff` (assignee re-check in `runLoadedTurn`). **`embed` is in the vocabulary but not yet wired** — RAG search runs inside the `generate` span, so an embedding failure surfaces there; threading a flow context through the shared toolset builder is a deferred follow-up.

### Tool lines and integration failures

`ToolFlowLogger` (`src/graph/tool-flowlog.ts`) emits one `tool` line per tool call. A tool that **throws** is logged `warn`/`error` via `handleToolError`. A tool that degrades gracefully — returns a friendly string to the model instead of throwing (toolpacks, operator HTTP tools) — marks provider/credential failures with `toolFailure(...)` (`src/graph/tools/failure.ts`, built via `failableTool`): the model still sees the exact same string, but the line is logged `level: warn`, `status: error`, with the string as `errorMessage` — so alert channels with `minLevel: warn` fire on integration failures (expired OAuth, provider outage, rejected payloads). Business-level replies ("no free slots", policy limits, bad model input) stay `info`/`ok` — they are normal operation. For operator-authored HTTP tools every non-2xx counts as a failure.

A side effect that fails **inside a tool that still returns success** (orphan Asaas correlation ref, missing PIX copy-and-paste code, handoff assignment/customer-message failure, attribute mirror write-through, kanban outbound emit, appointment-reminder arm/cancel) is surfaced as its **own** `tool`-stage `warn` line: the toolset builder (`prepare.ts`) binds `onSideEffectError` on `ToolpackCtx`/`ToolCtx` to `emitFlowEvent`, with `detail.tool` naming the tool and `detail.phase` discriminating the side effect. The tool's own line (and the model-facing return) stays `ok` — the call genuinely succeeded. Absent a flow context (playground), these failures stay stdout-only.

## Alerting (`alerts.ts`, `alert-worker.ts`)

- `dispatchAlertsForEvent` is called fire-and-forget from `emitFlowEvent` for `warn`/`error` events **on `source==="inbox"` only** (a playground error must not page). It matches channels by `minLevel` + stage allowlist and **coalesces**: a pending delivery for the same `(channel, stage, level)` is bumped (`count++`) instead of inserting a new row.
- `alert-worker.ts` copies the outbound-webhook worker (single-leader `globalThis` singleton + reentrancy guard, `FOR UPDATE SKIP LOCKED`, full-jitter retry, `DEAD`, SSRF re-check, `.unref()`). A **coalesce window** (`ALERT_COALESCE_WINDOW_MS`, default 30s) holds fresh rows so the burst count accumulates before the single POST; retries (with `next_attempt_at`) are claimed when due. Discord gets `{ content }` markdown with the `count`; the generic webhook gets a versioned envelope, HMAC-signed when `secretRef` resolves. Gated by `ALERT_WORKER_ENABLED` (off on extra replicas — see `docs/deploy.md`).

## Retention (`retention.ts`)

A per-tenant `FLOWLOG_SWEEP` scheduler job, armed at boot for every tenant and self-rearming every 24h, deletes `execution_logs` (and terminal `alert_deliveries`) older than `FLOWLOG_RETENTION_DAYS` (default 30) in RLS-scoped batches.

## Read / UI

- `GET /v1/logs` (`read.ts` + `logs.controller.ts`, TENANT_ADMIN): **keyset** pagination by `id desc` (high-write table), filters `since/until/level/stage/agentId/conversationId/source/ turnId/search`, `source` default `inbox`.
- `GET/POST/PATCH/DELETE /v1/alert-channels` (`channels.ts` + `alert-channels.controller.ts`).
- Frontend: `/logs` (`LogsPage.tsx`, grouped by turn into collapsible cards, keyset Prev/Next) + the **Alert channels** section on the Webhooks page (`AlertChannelsSection.tsx`).

## Export

`export.ts` is the shared core for a bulk, filtered dump — all three transports project over the one `exportExecutionLogs`. It reuses `buildLogWhere` / `mapExecutionLogRow` from `read.ts` (so an export matches exactly what the list shows), returns rows newest-first up to `MAX_LOG_EXPORT_ROWS` (10000; `maxRows` clamps under it), and serializes to **CSV** (spreadsheet-friendly; the `detail` object lands as one JSON-string cell, RFC 4180 quoting) or **JSON** (structured, lossless). Result carries `content` / `filename` / `contentType` / `count` / `truncated` (never a silent cap — the newest `count` win). Core/additive, like the rest of the logs feature.

- `GET /v1/logs/export` (`logs.controller.ts`, TENANT_ADMIN): same filter surface as the list (minus pagination) + `format` (`csv` default | `json`) + `maxRows`; returns the JSON wrapper (the browser turns `content` into a Blob, like the agent export).
- Frontend: an **Export** button + `LogsExportModal` on the Logs page (picks a time range — presets or a custom window, default last 7 days — and the format, applies the active on-page filters, toasts on truncation / empty).
- MCP: the `logs_export` read tool (`mcp/read.ts` `logsExport` → `server.ts`), same filters + `format` + `max_rows` (default 1000 for MCP, hard cap 10000).

Read before touching anything under `src/modules/flowlog/`, the seam wiring, or the Logs page.
