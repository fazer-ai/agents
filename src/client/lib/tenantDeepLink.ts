// What to do about a `?switchTenant=<id>` on the URL the operator just followed.
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
// The whole rule is one question — "is this console on the tenant the link names?" — and the thing
// that makes it hard is that there are THREE answers, not two. Collapsing "I cannot tell" into
// either "yes" or "no" is the same mistake in every place it has been made here, and it has been
// made in three of them:
//
//   - the tenant list has not arrived yet   → `pending`: hold, decide when it does
//   - the tenant list could not be READ     → `unverified`: say so; never claim the link is bad,
//                                             and never let the page through, because the page is
//                                             the wrong tenant's
//   - the session is scoped to one tenant   → compare against THAT tenant, not against the browser's
//                                             stored selection, which such a session never sets
//
// The last one is why a tenant-scoped session is not simply "the parameter is inert". It is inert as
// far as switching goes — the backend ignores `X-Tenant-Id` for anyone but a SUPER_ADMIN — but a link
// built for another tenant is still a link that will not do what it says here. `fillAt` survives that
// on its own, because the id it carries is not in this tenant and the vault panel reports the miss.
// `createAt` and `configureAt` name a ROUTE and nothing else: there is no lookup to miss, so silence
// puts the operator on their own tenant's page believing they followed the link, and whatever they
// create there is created in the wrong tenant.

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
