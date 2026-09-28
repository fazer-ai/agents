// Names the SERVER writes and the BROWSER reads back: query parameters, routes, and one response
// header. Import-free because `src/modules/mcp/console-links.ts` builds the URLs with `config`
// (server-only), and importing `config` in the browser throws before any route renders
// (`docs/frontend-env-vars.md`); `tests/client/bundle-boundary.test.ts` checks the boundary.

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
// stored `X-Tenant-Id`), separated by `ActiveTenantNotFoundError` from every other 404 (src/lib/errors.ts).
// A header rather than a body code: Eden's `onResponse` sees the `Response` before the body is parsed,
// and reading it there consumes the stream. The body's `field` key means an INPUT the operator can fix
// (src/api/lib/refusal.ts), which an ambient target is not.
//
// NOTE: readable from script because the console is same-origin with the API. A cross-origin reader
// would need it in `Access-Control-Expose-Headers`, which this app does not send.
export const REJECTED_TENANT_SELECTOR_HEADER = "X-Tenant-Id-Invalid";
