# Merchant console operating guide

The merchant vertical turns discovered social posts into orders: catalog in,
sources scan, leads score, a human follows up, orders close. Every piece of
data is tenant-scoped under the same RLS rules as the rest of the platform
(see `docs/tenancy.md`).

This guide covers the operator-facing surface: catalog, sources, leads,
nurture sequences and the outbox, orders, analytics, and the onboarding
checklist.

## Setup

The console lives at `/` on the dev server (`bun dev`, port `3000`). Merchant
pages sit under the "Merchant" sidebar section and are admin-only
(`TENANT_ADMIN` role): leads, sources, catalog, orders, nurture, analytics,
and the "Getting started" checklist at `/onboarding`.

There are no merchant-specific environment variables - the feature set uses
the platform's `DATABASE_URL`, the tenancy middleware, and the vault. The one
optional credential is for the Threads scanner, and it lives in the vault,
not in `.env` (see "Sources" below).

For a fresh tenant, `/onboarding` walks the same four checks in order:
import products, create and run a source, try an agent, review leads. Each
step is computed live from the API, so it reflects the real state.

## Catalog (`/catalog`)

The catalog is the product list the scorer matches posts against and orders
price from.

- `GET/POST /api/v1/merchant/products`, `PATCH/DELETE .../products/:id` -
  CRUD, one product at a time.
- `POST /api/v1/merchant/products/import` - bulk import from a JSON array or
  CSV paste. Rows carry `name`, `price` (VND), optional `description`,
  `tags`, `category`, `stock`. The importer upserts on name.
- `POST /api/v1/merchant/products/:id/retag` - re-run tag extraction on a
  product whose description changed.

Tags are what the lead scorer matches against; keep them in the words
customers use (`"serum"`, `"trị mụn"`, `"váy suông"`).

## Sources (`/sources`)

A lead source is a configured rail that scans a platform and feeds the
ingest pipeline (normalize -> dedupe on `(tenant, platform, external_id)` ->
score -> product match).

- `file_import` - paste a JSONL or CSV export and run it by hand. Safe for
  demos and for platforms with no search API.
- `threads_api` - real keyword search on Threads. Needs
  `config.credentialRef` pointing at a vault entry holding a Meta Threads
  access token (`vault:<id>`). Without a resolvable credential the run
  refuses cleanly.
- `tiktok_comments` - `mode: "fixture"` serves bundled sample comments
  (optional keyword filter). `mode: "api"` refuses: TikTok exposes no public
  keyword comment search.

Runs are manual: `POST /api/v1/merchant/sources/:id/run` or the page's "Run
now". `intervalMin`/`enabled` are stored for a future scheduler lane but
nothing consumes them yet.

## Leads (`/leads`)

Scored posts land in the leads list, newest first. Each row carries author,
platform, score, product matches, status, and the source that produced it.
The funnel statuses are `NEW -> CONTACTED -> QUALIFIED -> CONVERTED`, with
`DEAD` for dead ends. Status edits are manual (`PATCH
/api/v1/merchant/leads/:id`) - a lead's stage is the operator's call.

## Nurture (`/nurture`)

Nurture sequences are operator-authored follow-up plans, walked per enrolled
lead by the `NURTURE_DRAIN` scheduler job. The output is the outbox: a queue
of rendered messages a human sends **by hand**. Nothing in this feature
posts to an external platform - there is deliberately no send integration.

- Sequences: an ordered list of `{delayMin, bodyTemplate, channel}` steps.
  `delayMin` waits after the previous step (0 = next drain pass). Templates
  render `{{name}}` (lead author), `{{product}}` (top product match),
  `{{platform}}`; unknown tokens are left verbatim.
- Enrollments: one ACTIVE enrollment per (tenant, sequence, lead),
  enforced by a partial unique index. Re-enrolling an ACTIVE pair answers
  the live row. Pausing a sequence freezes its enrollments; resuming fires
  due steps at once.
- Outbox: each drain pass claims due enrollments (`FOR UPDATE SKIP
  LOCKED`), renders the step, inserts a `PENDING` row and advances the
  enrollment (or marks it `DONE` after the last step). The operator copies
  the body out and records `POST .../outbox/:id/send` (PENDING -> SENT) or
  `:id/cancel`. Both are CAS transitions: a second transition returns 409.

API surface (all under `/api/v1/merchant/nurture`, writes TENANT_ADMIN):

- `GET/POST /sequences`, `GET/PATCH/DELETE /sequences/:id`
- `GET/POST /enrollments`, `DELETE /enrollments/:id` (cancel)
- `GET /outbox?status=PENDING`, `POST /outbox/:id/send`,
  `POST /outbox/:id/cancel`

The drain is one perpetual self-rescheduling job row per tenant
(`dedupeKey: nurture-drain`), armed at boot and nudged on every enroll. It
sleeps at the next due `next_run_at`, or 15 minutes when idle.

## Orders (`/orders`)

Orders are drafted from a lead (or by hand) with line items priced off the
catalog. Statuses: `DRAFT -> CONFIRMED -> PAID` or `CANCELLED`. `leadId`
keeps the attribution chain post -> lead -> order, which is what the
analytics conversion number reads.

## Analytics (`/analytics`)

`GET /api/v1/merchant/analytics/summary` is read-only and answers the whole
page in one call: leads by status/platform/source, top matched products,
orders count and `totalAmount` by status, lead-to-order conversion
(CONVERTED leads over all leads, percent), and leads per day for the last
14 days (UTC buckets, zero-padded) for the sparkline.

## Drafts and the outbox - safety and compliance

The nurture outbox is a **human-executed rail by design**:

- No automatic external outreach exists in this feature. A `PENDING` row is
  a draft; delivery is the operator copying text into the platform's own
  composer. This keeps the platform outside platform-automation ToS risk
  (bulk DM tooling is what gets accounts restricted) and keeps a human in
  the loop on every customer touch.
- Enroll leads who asked for contact or engaged publicly; the sequence is
  follow-up, not cold spam. Keep step counts low (1-3) and delays honest.
- `channel` on a step is a label for the operator (`dm` vs `reply`), not a
  delivery mechanism.
- Every stage and transition is audited (`nurture_sequence.*`,
  `nurture_enrollment.*`, `nurture_outbox.*`), so the record shows who
  marked what sent and when.
- Personal data in rendered bodies stays inside the tenant's RLS fence;
  the outbox row carries the lead's display name and platform, nothing
  more.

## Onboarding checklist (`/onboarding`)

Admin-only first-run checklist, computed live - no checklist state is
stored server-side:

1. Import products (done when `products > 0`).
2. Create and run a source (done when a source exists AND leads landed).
3. Test an agent in the playground (informational - links to `/agents`).
4. Review leads (done when at least one lead is past `NEW`).

A "Dismiss" control writes a localStorage flag for the browser only.
