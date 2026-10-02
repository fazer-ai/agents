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
