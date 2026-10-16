# Dashboards

Pro edition. Panels an admin arranges over the account's conversations and AI usage, each dashboard at its own address (`/dashboards/<slug>`). Not to be confused with the operator dashboard at `/` ([`dashboard.md`](dashboard.md)), whose blocks are fixed.

## Model

- `dashboards`: `name`, `slug` (unique per tenant), `default_range` (`24h`, `today`, `7d`, `30d`), `refresh_seconds` (`0`, `60`, `300`).
- `dashboard_panels`: `position`, `width` (`third`, `half`, `two_thirds`, `full` of a six-column grid; one column on a phone), `title`, `description`, `visualization` (`number`, `timeseries`, `bars`, `table`) and `query` (JSON).
- Both tables carry the RLS policy pair and cascade from the tenant and the dashboard. **The schema is identical in Free**: only the code is dropped by the derivation, so a Free database upgraded to Pro needs no migration and the two never diverge.

## The query

`query` is validated by `panelQuerySchema` (`src/modules/dashboards/query-schema.ts`), a closed vocabulary rather than SQL, so a panel can only ask what the module knows how to answer under the tenant's RLS and the metrics budget.

- `source: "conversations"`: counts the mirrored `conversations` created in the window. `groupBy` is `none`, `time` (`hour`/`day`, buckets filled in the viewer's timezone), `attribute` (a Chatwoot custom attribute key), `label`, `inbox`, `status` or `outcome` (the operator dashboard's: `outcomeSql()` among the conversations the agent ran on, `agentRanSql()`, and `agent_not_involved` for the rest, so the categories add up to every conversation and "resolved by the agent" and "handed off" equal `GET /v1/metrics/kpis` for the same window). Filters: inboxes, one label (case-insensitive), one attribute equal to a value.
- `source: "usage"`: `measure` is `cost` (`llm_usage.cost_usd`, the same ledger and the same total as the operator dashboard's cost by model), `calls` or `tokens`, grouped by `none`, `time`, `model`, `agent` or `inbox`. A number with nothing in the period nor in the previous one shows the empty state ("nothing matches"), as a grouping with no rows does: a removed inbox or a value no conversation has would otherwise read as a bare 0. A cost result carries how many calls have a price and how many do not, for the window and for each value, group and bucket (`priced`, `unpriced`): a cost sums the priced calls only, so a value, group or bucket whose calls are all unpriced shows "No price" instead of zero, a chart leaves that bucket as a gap, and a bucket of free-model calls is a zero with calls behind it, which keeps the panel from reading as empty.
- `compare: { threshold }` (conversations, categorical groupings only): each group also gets its daily average over the 7 days before `since` (`usualDaily`), the ratio of the period to that average (`ratio`, null when the group has no history) and `hot` when the ratio reaches the threshold. This is the "which event is getting more contacts than usual" panel the Guichê Web SAC asked for.
- Categorical groupings return the top `limit` rows (max 50) and the remainder as `other`.

`queryFitsVisualization` decides which visualization can draw which grouping (a number needs `none`, a series needs `time`, bars need a category, a table takes anything but `none`). The API refuses a mismatch with 422, and the editor only offers what fits.

A stored query that no longer parses (written by another version) is returned as `query: null`, and its data route answers `{ broken: true }`: the panel says so and asks to be edited, instead of failing the whole dashboard.

## Routes

All under `/api/v1/dashboards`, `TENANT_ADMIN`, in `src/api/v1/dashboards.controller.ts`. `GET /:id` takes the id and `GET /slug/:slug` the address's slug; a slug is never read as an id, so a slug made only of digits still opens its own dashboard. Each panel reads its own data (`GET /:id/panels/:panelId/data?since&until&tz`), so a panel past `METRICS_TIMEOUT_MS` shows its own 503 and the others still render. `POST /query` runs an unsaved query, which is the editor's live preview. Every write is audited (`dashboard.*`, `dashboard_panel.*`).

The window is cut by the client in the viewer's timezone (`src/client/pages/dashboards/period.ts`), once per period choice and per refresh, so every panel of a screen reads the same instants. The server refuses windows longer than 92 days or with `until <= since`.

A time series drawn as a chart is `SeriesChart.tsx`, loaded with `lazyWithReload`: the dashboards route is a static import of the app, so a static import of Recharts there would load it on every screen. `biome-plugins/no-static-chart-import.grit` refuses a static import of `recharts` or of `pages/dashboard/charts` outside the chart modules. Every panel write on the dashboard screen (order, width, the editor's save and a removal) goes through one queue, in the order the admin made them, so a write still queued cannot land after a later one and undo it.

## Free edition

`DashboardsRoutes.tsx` is paired with `DashboardsRoutes.free.tsx`, which shows the feature with `<ProGate feature="dashboards"/>`. The sidebar item stays in Free. The module, the controller, the pages and the tests are Free-only drops in `tooling/derivation/manifest.ts`; the controller's mount and the audit actions are `@full-only`. The catalogs are JSON, which carries no markers, so the Free derivation prunes the `dashboards` namespace (`pruneLocaleNamespaces` in the manifest, `tooling/derivation/locales.ts`): every key of it with no literal call left in the Free sources goes, as `i18n:extract` would remove it there, and the title and upgrade copy stay.

## Not yet

Tracked as their own issues: viewer access (a viewer account allowed by e-mail domain or address, Google sign-in or an e-mail code, so a client reads a dashboard without an admin login), an HTTP JSON source for figures that live outside the agents database, and a TV mode.
