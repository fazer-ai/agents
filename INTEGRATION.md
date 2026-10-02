# Integration: merchant lead sources (Phase 1)

This worktree adds tenant-scoped **lead sources**: configured rails that scan
social platforms and feed the existing lead ingest pipeline (score + product
match + dedupe on `(tenant, platform, external_id)`).

What landed:

- `src/modules/discovery/` - scanner framework + registry keyed by
  `LeadSource.kind`:
  - `file_import` - working rail; pasted/uploaded JSONL or CSV exports,
    auto-detected format, per-run content override, optional default platform.
  - `threads_api` - real code path against `graph.threads.net/v1.0/search`
    (keyword search). Requires `config.credentialRef` pointing at a filled
    vault entry (`vault:<id>`, a `bearer_token`/`generic` style string secret);
    without one the run refuses with `errors.merchantSourceCredentialRequired`.
  - `tiktok_comments` - `mode: "fixture"` serves a bundled Vietnamese-comment
    sample (`fixtures/tiktok-comments.json`) with an optional keyword filter;
    `mode: "api"` refuses with `errors.merchantSourceModeUnsupported` (TikTok
    has no public comment-search API for arbitrary keywords; the real rail is
    the documented next step).
- Endpoints under `/api/v1/merchant/sources` (CRUD + `POST :id/run` +
  `GET :id/leads`), TENANT_ADMIN-gated writes, audit actions
  `merchant_source.create|update|delete|run`.
- Lead DTOs now carry `sourceId` / `sourceName` / `externalId`; the per-source
  leads list is `GET /v1/merchant/sources/:id/leads` (404s on a missing
  source).
- `src/client/merchant/pages/SourcesPage.tsx` - the sources table + create/edit
  dialog + Run now + per-source leads drawer. Not routed yet (see below).
- `LeadsPage` shows a source badge on leads that came from a source.

## UI wiring required (not done here - shared files)

`src/client/App.tsx` - add the import next to the other merchant pages and a
route inside the merchant block:

```tsx
import { SourcesPage } from "@/client/merchant/pages/SourcesPage";
```

```tsx
<Route
  path="/sources"
  element={
    <ProtectedRoute requireAdmin>
      <SourcesPage />
    </ProtectedRoute>
  }
/>
```

`src/client/lib/navigation.tsx` - add a nav item in the MERCHANT section
(before or after `/leads`):

```tsx
{
  to: "/sources",
  labelKey: "nav.sources",
  defaultLabel: "Sources",
  icon: Radar, // from lucide-react
  requireAdmin: true,
  section: MERCHANT,
},
```

## i18n

Client keys were extracted into `src/client/locales/{en,pt-BR}.json` under
`merchant.sources.*` (plus `merchant.leads.sourceDeleted`, `common.saving`).
If you add the nav item above, also add `nav.sources` - e.g. `"Sources"` /
`"Fontes"` - to both client locale files (or add a
`t('nav.sources', 'Sources')` magic comment in navigation.tsx and re-run
`bun i18n:extract`).

API error keys added under `errors.merchantSource*` in
`src/api/locales/{en,pt-BR}.json` (extracted from the `translate(...)` ledger
comments in `merchant.controller.ts`).

## Scheduling

`enabled` + `intervalMin` now drive recurring scans through the durable
scheduler (the homegrown `scheduler_jobs` worker, not a new table or lock):

- New job kind `LEAD_SOURCE_SCAN` (Postgres enum + `scheduler_jobs` row per
  source, dedupe key `lead-source:<id>`). Migration:
  `prisma/migrations/20261003120000_scheduler_lead_source_scan_kind/migration.sql`
  (`ALTER TYPE ... ADD VALUE`, add-value only; `prisma migrate deploy` applies
  it, no backfill).
- `src/modules/discovery/scan-jobs.ts` - the row primitives:
  `leadSourceScanKey`, `leadSourceScanDueAt` (`lastRunAt + intervalMin`, or now
  for a never-run source), `armLeadSourceScan`, `cancelLeadSourceScanOn`.
- `src/modules/discovery/sources.ts` - `createLeadSource` arms the row
  due-now when `enabled`; `updateLeadSource` re-arms at the source's due time
  or retires the row when disabled; `deleteLeadSource` retires it. All inside
  the writer's own transaction, so a source cannot commit enabled and
  un-scheduled.
- `src/modules/discovery/schedule.ts` - `registerLeadSourceScanHandler()`
  (registered in `src/index.ts` beside the other handler registrations, inside
  `if (config.schedulerWorker.enabled)`) and `ensureAllLeadSourceScans()`
  (boot re-arm, also in `src/index.ts`, best-effort).
- The handler re-reads the source under its tenant scope: missing or disabled
  ends the row; not-due reschedules to the real due time (a manual run can
  have moved `lastRunAt`); due runs the same `runLeadSource` as
  `POST .../run`, so `lastRunAt`/`lastStatus`/`lastError` and the
  `merchant_source.run` audit entry are identical. Success reschedules at
  `lastRunAt + intervalMin`; a scan failure logs a warning and reschedules
  from `now + intervalMin`, so a broken source keeps its interval instead of
  dead-lettering its schedule, and one source never blocks another (the
  shared tick drains claimed rows with `Promise.allSettled`).
- Lane classification (all exhaustive maps in `src/modules/scheduler/lanes.ts`
  and mirrored in `tests/modules/scheduler-lanes.test.ts`): `shared` lane, not
  provider-spending, not traffic-proportional, kept on DONE (re-armed, not
  deleted), death level `warn`, retry base 2s.

### Poll cadence / env

No new env var: the due-source poller IS the shared scheduler tick. A due scan
is at most `SCHEDULER_WORKER_INTERVAL_MS` late (default 15000; already in
`.env.example`), and `intervalMin` (minutes, per source) is the scan cadence.
The claim is the same `FOR UPDATE SKIP LOCKED` path every shared-lane kind
uses, so the single-replica invariant is unchanged.

### Manual verification (curl)

Requires the enum migration applied to the server's database. With the dev
server on `:3000`:

```bash
# Login (dev seed account) -> cookie jar
curl -c /tmp/cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"gateway-admin@vinvin.dev","password":"GatewayAdmin-2026!"}'

# Create an enabled source; armed for now because it never ran
curl -b /tmp/cookies.txt -X POST http://localhost:3000/api/v1/merchant/sources \
  -H 'Content-Type: application/json' -H 'X-Tenant-Id: 1' \
  -d '{"name":"scan","kind":"file_import","intervalMin":1,
       "config":{"format":"jsonl","content":"{\"platform\":\"tiktok\",\"id\":\"x1\",\"author\":\"Lan\",\"text\":\"cần mua serum BHA\"}"}}'

# Within one tick the row runs and re-arms +intervalMin:
#   SELECT status, run_at FROM scheduler_jobs WHERE dedupe_key='lead-source:<id>';
#   SELECT last_status, last_run_at FROM lead_sources WHERE id=<id>;
#   GET /api/v1/merchant/sources/:id/leads lists the ingested lead.

# Disable retires the row (status DONE); manual run still works while disabled:
curl -b /tmp/cookies.txt -X PATCH http://localhost:3000/api/v1/merchant/sources/<id> \
  -H 'Content-Type: application/json' -H 'X-Tenant-Id: 1' -d '{"enabled":false}'
curl -b /tmp/cookies.txt -X POST http://localhost:3000/api/v1/merchant/sources/<id>/run \
  -H 'Content-Type: application/json' -H 'X-Tenant-Id: 1' -d '{}'
```

Verified end-to-end on a local server pointed at the per-checkout test DB
(scheduler tick at 2s): create armed `lead-source:12` PENDING; the tick ran it
(`lastStatus=ok`, one lead ingested); it re-armed and ran again one interval
later (lead deduped, count unchanged); `enabled:false` set the row DONE; the
manual `/run` still ran while disabled; `enabled:true` re-armed at
`lastRunAt + intervalMin` and the tick resumed the loop.

### Tests

```bash
bun db:test:setup
bun test tests/modules/discovery-source-scan.test.ts tests/modules/scheduler-lanes.test.ts
```

Result: 15 pass, 0 fail. The scan file covers due-source selection (never-run
due now, `lastRunAt + intervalMin` due/pending), the disabled skip (no row on
create, retire on disable, stray row finishes without running), interval
gating (an early-firing armed row waits out the interval instead of
rescanning), failure isolation (a failing source records `lastStatus=error`,
reschedules, and does not block the source beside it), and the boot re-arm
covering every enabled source without postponing an already-pending run. The
lanes suite keeps the new kind's exhaustive map entries honest.

## Credentials still missing for real scans

- `threads_api`: needs a Meta Threads API access token (threads.net app with
  `threads_keyword_search` capability) stored as a vault entry, then referenced
  via `config.credentialRef`.
- `tiktok_comments` `api` mode: no public TikTok API searches comments by
  keyword; realistic paths are TikTok Research API (comment list on known
  videos, region-gated) or a third-party scraper feeding `file_import`.
