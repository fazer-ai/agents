// What to do about a `?switchTenant=<id>` on the URL the operator just followed. MCP console links
// name their tenant (`src/modules/mcp/console-links.ts`) because the console resolves the tenant from
// `localStorage`, never the URL. Switching is a FULL reload, like the header switcher, and afterwards
// the stored selection equals the requested one, which stops it repeating. "Is this console on the
// tenant the link names?" has THREE answers, and "I cannot tell" must never collapse into yes or no:
// list not arrived → `pending`; list unreadable → `unverified` (never "the link is bad", never the
// page through); tenant-scoped session → compare against THAT tenant, since `X-Tenant-Id` is inert
// for it but a `createAt`/`configureAt` link for another tenant would silently create there.

// What this session can open. The three fleet-level states are separate on purpose: an empty list
// and an unreadable one are opposite claims, and only one of them is authoritative.
export type TenantScope =
  // Fleet-level (SUPER_ADMIN), list in hand.
  | { kind: "fleet"; accessible: readonly string[] }
  // Fleet-level, list still loading.
  | { kind: "loading" }
  // Fleet-level, list could not be read. NOT an empty list: nothing is known either way.
  | { kind: "unknown" }
  // Scoped to exactly one tenant, for as long as this session lasts.
  | { kind: "tenant"; tenantId: string };

export type TenantDeepLinkAction =
  // Nothing to do, and nothing left to wait for: the caller may clean the parameter off the URL.
  | { kind: "none" }
  // Not decidable YET. Distinct from "none" for one reason that is easy to get wrong: the caller
  // cleans the parameter up on "none", and cleaning it up while the answer is still loading removes
  // the very input the pending fetch was going to be judged against, so the switch never happens.
  | { kind: "pending" }
  | { kind: "switch"; tenantId: string }
  // AUTHORITATIVE: this session cannot open that tenant. Worth reporting, and the console is allowed
  // to carry on where it is, because where it is, is the only place it can be.
  | { kind: "unavailable"; tenantId: string }
  // NOT authoritative: we could not find out. Reported differently, because "you cannot open that"
  // is a claim we have no basis for, and the page underneath must stay shut — it belongs to a tenant
  // this link says is the wrong one.
  | { kind: "unverified"; tenantId: string };

export function tenantDeepLinkAction(params: {
  // The `?switchTenant` value on the current URL, if any.
  requested: string | null;
  // The tenant the console currently has selected. Meaningful for a fleet-level session only; a
  // tenant-scoped browser never writes it, so a stale value there must not be trusted as identity.
  active: string | null;
  scope: TenantScope;
}): TenantDeepLinkAction {
  const { requested, active, scope } = params;
  if (!requested) return { kind: "none" };

  // A scoped session has no list to consult and nothing to wait for: its own tenant IS the answer.
  if (scope.kind === "tenant") {
    return requested === scope.tenantId
      ? { kind: "none" }
      : { kind: "unavailable", tenantId: requested };
  }

  // Already there. Checked before anything that can fail, and that ordering is load-bearing: this is
  // the state every switch lands in after its reload, so making it depend on a readable tenant list
  // would strand the operator on the tenant they asked for whenever the list happens to be down.
  if (requested === active) return { kind: "none" };

  if (scope.kind === "loading") return { kind: "pending" };
  if (scope.kind === "unknown")
    return { kind: "unverified", tenantId: requested };
  if (!scope.accessible.includes(requested)) {
    return { kind: "unavailable", tenantId: requested };
  }
  return { kind: "switch", tenantId: requested };
}
