// Names the SERVER writes and the BROWSER reads back: query parameters, routes, and one response
// header.
//
// They live here, with no imports of their own, because both ends need them and the two ends have
// opposite constraints: `src/modules/mcp/console-links.ts` builds the URLs and needs `config`
// (server-only, reads `process.env`), while the console reads them in the browser, where importing
// `config` throws before any route renders (`docs/frontend-env-vars.md`). A constant shared through
// the builder would drag the whole server config into the SPA bundle; the boundary is checked by
// `tests/client/bundle-boundary.test.ts`.

// Asks the console to OPEN a given tenant. Deliberately not `tenant`: `/admin/users?tenant=<id>`
// already exists as that page's fleet-wide filter, linked to from the tenants list, and a component
// that switches the whole console on sight of `tenant` would hijack that link, reload, and then
// strip the filter the operator had just chosen.
export const SWITCH_TENANT_PARAM = "switchTenant";

// The console routes a tool is allowed to point at, spelled as the router spells them
// (`src/client/App.tsx`). Naming them in one place is what keeps a route rename from quietly turning
// a link into a redirect to the dashboard, which is where the `path="*"` catch-all sends anything
// else.
export const CONSOLE_ROUTES = {
  vault: "/resources/vault",
  integrations: "/resources/integrations",
} as const;

// Names the id on the 404 that refuses the tenant SELECTOR a request was carrying (the console's
// stored `X-Tenant-Id`), which `ActiveTenantNotFoundError` separates from every other 404 answering
// the same key and sentence (src/lib/errors.ts).
//
// A header rather than a code in the body because of who reads it: Eden's `onResponse` sees the
// `Response` before the body is parsed, and reading the body there consumes the stream Eden is about
// to read. The body's one machine-readable key is `field`, whose contract is an INPUT the operator
// can go and fix (src/api/lib/refusal.ts); an ambient target is not one. Issue #252.
//
// NOTE: readable from script because the console is same-origin with the API. A cross-origin reader
// would need it in `Access-Control-Expose-Headers`, which this app does not send.
export const REJECTED_TENANT_SELECTOR_HEADER = "X-Tenant-Id-Invalid";
