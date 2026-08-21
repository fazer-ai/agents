import { describe, expect, test } from "bun:test";
import {
  type TenantDeepLinkAction,
  tenantDeepLinkAction,
} from "@/client/lib/tenantDeepLink";

// Decision table for what a `?switchTenant=<id>` on the URL means (issue #151). Switching is a full
// reload, so a wrong answer here either loops the browser or drops the operator on a tenant that is
// not the one the link was built for, with nothing on screen saying so.
//
// The axis this table exists to pin is not "can it switch" but "does it KNOW". Three of the rows
// below are states where the answer is not available, and each one is a different obligation: wait
// for it, say we could not get it, or answer from the session's own tenant because there is nothing
// to wait for. Collapsing any of them into a definite answer is the bug this table keeps catching.

const A = "10";
const B = "20";

describe("tenantDeepLinkAction", () => {
  const cases: Array<{
    name: string;
    input: Parameters<typeof tenantDeepLinkAction>[0];
    expected: TenantDeepLinkAction;
  }> = [
    {
      name: "no parameter: an ordinary navigation decides nothing",
      input: {
        requested: null,
        active: A,
        scope: { kind: "fleet", accessible: [A, B] },
      },
      expected: { kind: "none" },
    },
    {
      name: "already on the requested tenant: this is the post-switch reload, and it must not switch again",
      input: {
        requested: A,
        active: A,
        scope: { kind: "fleet", accessible: [A, B] },
      },
      expected: { kind: "none" },
    },
    {
      name: "a different accessible tenant: switch",
      input: {
        requested: B,
        active: A,
        scope: { kind: "fleet", accessible: [A, B] },
      },
      expected: { kind: "switch", tenantId: B },
    },
    {
      name: "no tenant selected yet: still a switch, there is nothing to preserve",
      input: {
        requested: B,
        active: null,
        scope: { kind: "fleet", accessible: [A, B] },
      },
      expected: { kind: "switch", tenantId: B },
    },
    {
      name: "a tenant this session cannot open: report it, never switch the console into an empty tenant",
      input: {
        requested: B,
        active: A,
        scope: { kind: "fleet", accessible: [A] },
      },
      expected: { kind: "unavailable", tenantId: B },
    },
    {
      name: "an empty accessible list is an answer, unlike a missing one",
      input: {
        requested: B,
        active: A,
        scope: { kind: "fleet", accessible: [] },
      },
      expected: { kind: "unavailable", tenantId: B },
    },
    {
      // "pending", NOT "none": the caller cleans the parameter off the URL on "none", and doing that
      // mid-flight removes the input the pending fetch was going to be judged against, so the switch
      // never happens and the link behaves exactly like the tenant-less one it replaced.
      name: "the accessible list has not arrived: nothing is decided yet, and the parameter must survive",
      input: { requested: B, active: A, scope: { kind: "loading" } },
      expected: { kind: "pending" },
    },
    {
      // The finding this row was written for: the failure used to become the EMPTY LIST, which is
      // the claim "you can open no tenant" — a claim nothing supports — and which then opened the
      // gate on tenant A's live controls under a URL naming B.
      name: "the accessible list could not be READ: that is not the same claim as an empty one",
      input: { requested: B, active: A, scope: { kind: "unknown" } },
      expected: { kind: "unverified", tenantId: B },
    },
    {
      // Load-bearing ordering: this is the state every switch lands in after its reload. Deciding it
      // from a list that may be unreadable would strand the operator on the very tenant they asked
      // for, every time the tenants endpoint happens to be down.
      name: "already on the requested tenant, with the list unreadable: still nothing to do",
      input: { requested: A, active: A, scope: { kind: "unknown" } },
      expected: { kind: "none" },
    },
    {
      name: "a tenant-scoped session, link for its OWN tenant: nothing to do and nothing to say",
      input: {
        requested: A,
        active: null,
        scope: { kind: "tenant", tenantId: A },
      },
      expected: { kind: "none" },
    },
    {
      // The other finding. `createAt`/`configureAt` name a route and carry no id, so there is no
      // lookup that could miss: staying silent here puts the operator on their own tenant's page
      // believing they followed the link, and what they create is created in the wrong tenant.
      name: "a tenant-scoped session, link for ANOTHER tenant: say so, do not pretend the link applies here",
      input: {
        requested: B,
        active: null,
        scope: { kind: "tenant", tenantId: A },
      },
      expected: { kind: "unavailable", tenantId: B },
    },
    {
      // A scoped session never writes the active-tenant key, so a value found there is someone
      // else's leftover and must not be read as this session's identity.
      name: "a tenant-scoped session is judged by its own tenant, not by a stale stored selection",
      input: {
        requested: B,
        active: B,
        scope: { kind: "tenant", tenantId: A },
      },
      expected: { kind: "unavailable", tenantId: B },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(tenantDeepLinkAction(c.input)).toEqual(c.expected);
    });
  }
});
