// What to do about a `?tenant=<id>` on the URL the operator just followed.
//
// Console links handed out by MCP name the tenant they belong to (`src/modules/mcp/console-links.ts`),
// because the console resolves the tenant from `localStorage` and never from the URL: without it, a
// link built for tenant B resolves against whatever the recipient's browser has selected, and a
// fleet-level session picks its tenant per call, so the two diverge as a matter of course.
//
// Switching is a FULL reload, exactly as the header switcher does, so the decision has to be made
// once and never re-made: after the switch the stored selection equals the requested one, which is
// what stops the reload from repeating.
//
// The two "do nothing" answers are different on purpose. A tenant-scoped user cannot switch at all
// (the backend ignores `X-Tenant-Id` for anyone but a SUPER_ADMIN), so the parameter is inert and
// there is nothing to report. A tenant this session cannot open is a link that will not work here
// no matter what, and switching to it would leave the console pointed at an empty tenant, so it must
// be reported instead of applied.

export type TenantDeepLinkAction =
  // Nothing to do, and nothing left to wait for: the caller may clean the parameter off the URL.
  | { kind: "none" }
  // Not decidable YET. Distinct from "none" for one reason that is easy to get wrong: the caller
  // cleans the parameter up on "none", and cleaning it up while the answer is still loading removes
  // the very input the pending fetch was going to be judged against, so the switch never happens.
  | { kind: "pending" }
  | { kind: "switch"; tenantId: string }
  | { kind: "unavailable"; tenantId: string };

export function tenantDeepLinkAction(params: {
  // The `?tenant` value on the current URL, if any.
  requested: string | null;
  // The tenant the console currently has selected.
  active: string | null;
  // The tenants this session can actually open. `null` means "not loaded yet", which is `pending`
  // and not `none`: deciding early would report a tenant as unavailable that simply had not arrived,
  // and answering `none` would have the caller discard the parameter mid-flight.
  accessible: readonly string[] | null;
  isSuperAdmin: boolean;
}): TenantDeepLinkAction {
  const { requested, active, accessible, isSuperAdmin } = params;
  if (!requested) return { kind: "none" };
  if (requested === active) return { kind: "none" };
  if (!isSuperAdmin) return { kind: "none" };
  if (accessible === null) return { kind: "pending" };
  if (!accessible.includes(requested)) {
    return { kind: "unavailable", tenantId: requested };
  }
  return { kind: "switch", tenantId: requested };
}
