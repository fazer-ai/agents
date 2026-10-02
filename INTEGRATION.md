# Integration: merchant polish (Phase 4)

Phase 4 lands the rest of the merchant console loop: nurture sequences with a
human-executed outbox, a read-only analytics rollup, an onboarding checklist,
and the operator guide (`docs/merchant.md`). It builds on the Phase 1-3
surface below (catalog, sources, leads, orders).

## What landed

- `src/modules/nurture/` - sequences (validated step lists in JSONB),
  enrollments (one ACTIVE per tenant+sequence+lead, partial unique index),
  the outbox (rendered bodies a human sends by hand - **no auto-send to
  external platforms, ever**), template rendering (`{{name}}`, `{{product}}`,
  `{{platform}}`), and the drain.
- `src/modules/merchant/analytics.ts` - the read-only rollup behind
  `GET /v1/merchant/analytics/summary`.
- `src/api/v1/merchant-nurture.controller.ts` +
  `src/api/v1/merchant-analytics.controller.ts`, both mounted in
  `src/api/index.ts`.
- Client: `/nurture`, `/analytics`, `/onboarding` (all admin-only) plus nav
  items under the Merchant section.
- `docs/merchant.md` - setup/operations/safety guide.

## New tables (migration `20261003000000_nurture`)

- `nurture_sequences` - tenant_id, name, steps JSONB
  `[{delayMin, bodyTemplate, channel(dm|reply)}]`, active.
- `nurture_enrollments` - tenant_id, sequence_id FK (cascade), lead_id FK
  (cascade), step_index, next_run_at, status ACTIVE|DONE|CANCELLED. Partial
  unique index `WHERE status='ACTIVE'` on (tenant_id, sequence_id, lead_id)
  is the hard one-active-enrollment guard.
- `nurture_outbox` - tenant_id, enrollment_id FK (cascade), lead_id FK
  (cascade), body, status PENDING|SENT|CANCELLED, sent_at.

All three carry the standard tenant-table RLS pattern (`ENABLE`/`FORCE` +
`tenant_isolation` + `fleet_super_admin`), and `SchedulerJobKind` gained
`NURTURE_DRAIN`.

## Scheduler lane

`NURTURE_DRAIN` - shared lane, `error` death level, no provider spend, not
traffic-proportional, not delete-on-done. One perpetual self-rescheduling
row per tenant (`dedupeKey: nurture-drain`): each pass claims due ACTIVE
enrollments (`FOR UPDATE SKIP LOCKED`, batch 50), renders the step, inserts
the PENDING outbox row, advances `step_index`/`next_run_at` or marks the
enrollment DONE, then reschedules itself at the next due `next_run_at`
(15-minute floor when idle). `enrollLead` nudges the row so a fresh
enrollment never waits out an idle sleep; `ensureAllNurtureDrains` re-arms
at boot. System-attributed audit rows (`nurture_outbox.render`) record every
staged message.

## Endpoints (all TENANT_ADMIN for writes, under `/api/v1`)

- `GET/POST /merchant/nurture/sequences`,
  `GET/PATCH/DELETE /merchant/nurture/sequences/:id`
- `GET/POST /merchant/nurture/enrollments`,
  `DELETE /merchant/nurture/enrollments/:id` (cancel)
- `GET /merchant/nurture/outbox?status=PENDING&leadId=&cursor=&limit=`,
  `POST /merchant/nurture/outbox/:id/send`,
  `POST /merchant/nurture/outbox/:id/cancel`
- `GET /merchant/analytics/summary`

## Manual E2E (dev :3000)

```bash
# login (cookie jar), tenant header on every call
curl -s -c /tmp/mc.jar -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"gateway-admin@vinvin.dev","password":"GatewayAdmin-2026!"}'
H='-b /tmp/mc.jar -H content-type:application/json -H X-Tenant-Id:1'

# sequence + enroll + outbox
curl -s $H -X POST http://localhost:3000/api/v1/merchant/nurture/sequences \
  -d '{"name":"Follow-up","steps":[{"delayMin":0,"bodyTemplate":"Hi {{name}}, the {{product}} is still available","channel":"dm"}]}'
curl -s $H -X POST http://localhost:3000/api/v1/merchant/nurture/enrollments \
  -d '{"sequenceId":"<seq>","leadId":"<lead>"}'
# drain runs on the scheduler tick (or wait ~5s after the enroll nudge)
curl -s $H 'http://localhost:3000/api/v1/merchant/nurture/outbox?status=PENDING'
curl -s $H -X POST http://localhost:3000/api/v1/merchant/nurture/outbox/<row>/send

# analytics
curl -s $H http://localhost:3000/api/v1/merchant/analytics/summary
```

## Tests

- `tests/modules/nurture.test.ts` - templates, step schema, and the whole
  rail under real RLS: CRUD+audit, idempotent enroll, paused-sequence skip,
  drain render/advance/DONE, CAS 409s, cross-tenant fencing. 11 pass.
- `tests/modules/merchant-analytics.test.ts` - the rollup's breakdowns,
  totals, conversion, 14-day series, tenant isolation. 6 pass.
- `tests/client/merchant/AnalyticsPage.test.tsx` - page render against a
  stubbed fetch. 1 pass.
- `tests/modules/scheduler-lanes.test.ts` - expected maps extended for
  `NURTURE_DRAIN`; all lane tests green.

`bun run db:test:setup` then `bun test tests/modules/nurture.test.ts
tests/modules/merchant-analytics.test.ts
tests/client/merchant/AnalyticsPage.test.tsx
tests/modules/scheduler-lanes.test.ts` -> 27 pass, 0 fail.

## Known gaps

- The outbox is deliberately human-executed; there is no send integration
  and no plan for one without a separate safety review (see
  `docs/merchant.md` for the compliance rationale).
- Enrollments read `steps` at fire time: editing a sequence mid-flight
  changes the steps ACTIVE enrollments have not reached yet (documented in
  the PATCH route's OpenAPI text).
- Lead pickers in the UI list the first 100 leads; no search box yet.
- `leadsPerDay` buckets are UTC (documented in the response shape); no
  tenant-timezone preference exists yet.

---

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

Runs are manual/API-triggered (`POST /api/v1/merchant/sources/:id/run`, or the
page's "Run now"). The durable scheduler's job kinds are a Postgres enum; a
discovery job kind would need a migration, so none was added. `intervalMin` +
`enabled` are stored and editable but nothing consumes them yet - wire a
scheduler lane later if recurring scans are wanted.

## Credentials still missing for real scans

- `threads_api`: needs a Meta Threads API access token (threads.net app with
  `threads_keyword_search` capability) stored as a vault entry, then referenced
  via `config.credentialRef`.
- `tiktok_comments` `api` mode: no public TikTok API searches comments by
  keyword; realistic paths are TikTok Research API (comment list on known
  videos, region-gated) or a third-party scraper feeding `file_import`.
