# Integration: outreach rails (Phase 3 - grey rails, capped + approval-gated)

This worktree adds the tenant-scoped **outreach** module: sends from
operator-owned secondary accounts, with hard caps and an explicit human
approval step. Nothing sends automatically - a job is QUEUED until a person
approves it, and every send writes an `outreach.sent` audit record.

## Feature flag

- `OUTREACH_ENABLED` (config + `.env.example`, default `false`). Every route
  under `/api/v1/merchant/outreach/*` answers **403** while the flag is off.
  The worker lane also no-ops when the flag is off, so a disabled deployment
  never touches a transport.

## What landed

- `src/modules/outreach/`
  - `accounts.ts` - outreach accounts registry: `platform`, `handle`,
    `transport` (`manual` | `zca_bridge`), optional `credentialRef`
    (`vault:<id>`), `dailyCap` (default 20), `cooldownMin` (default 10),
    `status` ACTIVE/PAUSED/BANNED, `sentToday` counter with UTC-day rollover
    semantics (the DTO reports 0 once the counted day has passed).
  - `jobs.ts` - the send queue. Kinds: `GROUP_COMMENT`, `FRIEND_REQUEST`,
    `DM`. Lifecycle:
    `QUEUED -> APPROVED -> SENDING -> SENT` (worker path) or
    `APPROVED -> READY_FOR_MANUAL -> SENT` (operator-confirmed manual send).
    `FAILED` may be requeued back to `QUEUED` (fresh approval required);
    `CANCELLED` is terminal. Unique `(tenant, lead, account, kind)` prevents
    double-sends.
  - `send.ts` - atomic claim + rate control: the daily cap and cooldown are
    enforced inside the same transaction that flips the job to SENDING, so
    concurrent claims cannot overspend the cap. On success the lead moves to
    `CONTACTED` (same effect as the funnel's `DM_OPENER` mark-sent).
  - `transports.ts` - transport registry: `manual` (no side effect, moves the
    job to `READY_FOR_MANUAL` and hands the text to the operator) and
    `zca_bridge` (POSTs `{handle, body, ...}` to the bridge URL from the
    account's credential, with a retry budget and terminal failure).
  - `worker.ts` - standalone worker lane (`startOutreachWorker` in
    `src/index.ts`) with its own tick (`OUTREACH_WORKER_INTERVAL_MS`, 15s
    default), globalThis singleton + non-overlapping tick + FOR UPDATE SKIP
    LOCKED claim. Only started when `OUTREACH_ENABLED=true`; the tick itself
    also no-ops on the flag.
- `src/api/v1/merchant-outreach.controller.ts` - routes under
  `/api/v1/merchant/outreach` (all `TENANT_ADMIN`):
  - `GET/POST /accounts`, `GET/PATCH/DELETE /accounts/:id`
  - `GET/POST /jobs`, `GET /jobs/:id`, `POST /jobs/:id/approve`,
    `/cancel`, `/mark-sent`, `/requeue`
  - `GET /stats` - account totals, today's sends, job counts by status.
- `src/client/merchant/pages/OutreachPage.tsx` - admin page at `/outreach`:
  accounts table (today counter, pause/resume, delete) and the send queue
  (approve / cancel / mark-sent / requeue by status). Renders a disabled
  state when the API answers 403.
- `tests/modules/outreach.test.ts` - 15 tests covering flag gating,
  cap/cooldown, dedupe, the approval gate, cross-tenant fencing, cancel
  rules, and both transports (bridge success, retry, terminal failure).
- `prisma/migrations/20261006000000_outreach/` - `outreach_accounts` +
  `outreach_jobs` tables with RLS policies.
- `.env.example` + `src/config.ts` - `OUTREACH_ENABLED`,
  `OUTREACH_WORKER_INTERVAL_MS`, `ZCA_BRIDGE_URL` (deployment-level bridge
  URL; an account credential can override `baseUrl` per account).

## Safety invariants (do not relax without a product decision)

- A job can only leave `QUEUED` via explicit operator approval.
- Manual transport never auto-sends - the operator marks it sent after doing
  it by hand.
- Daily cap and cooldown are enforced atomically at claim time.
- Banned accounts refuse new jobs; paused accounts stop claiming.
- Every state change writes an audit row (`outreach.*` actions in
  `src/lib/audit/actions.ts`).

## Checklist run in this worktree

- `bun test tests/modules/outreach.test.ts` - 15/15 pass
- `bunx tsc --noEmit` - clean
- `bunx biome check <touched files>` - clean
- `bun i18n:extract` - `nav.outreach` + `merchant.outreach.*` keys extracted
