import { describe, expect, test } from "bun:test";
import {
  type TenantDeepLinkAction,
  tenantDeepLinkAction,
} from "@/client/lib/tenantDeepLink";

// Decision table for what a `?tenant=<id>` on the URL means (issue #151). Switching is a full
// reload, so a wrong answer here either loops the browser or drops the operator on a tenant that is
// not the one the link was built for, with nothing on screen saying so.

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
        accessible: [A, B],
        isSuperAdmin: true,
      },
      expected: { kind: "none" },
    },
    {
      name: "already on the requested tenant: this is the post-switch reload, and it must not switch again",
      input: {
        requested: A,
        active: A,
        accessible: [A, B],
        isSuperAdmin: true,
      },
      expected: { kind: "none" },
    },
    {
      name: "a different accessible tenant: switch",
      input: {
        requested: B,
        active: A,
        accessible: [A, B],
        isSuperAdmin: true,
      },
      expected: { kind: "switch", tenantId: B },
    },
    {
      name: "no tenant selected yet: still a switch, there is nothing to preserve",
      input: {
        requested: B,
        active: null,
        accessible: [A, B],
        isSuperAdmin: true,
      },
      expected: { kind: "switch", tenantId: B },
    },
    {
      // Ordering matters here: a tenant-scoped user never fetches the list, so this has to answer
      // before the pending case or such a session would wait forever on something it never asked for.
      name: "not a SUPER_ADMIN: the parameter is inert, since the backend ignores X-Tenant-Id for anyone else",
      input: {
        requested: B,
        active: A,
        accessible: [A, B],
        isSuperAdmin: false,
      },
      expected: { kind: "none" },
    },
    {
      name: "a tenant this session cannot open: report it, never switch the console into an empty tenant",
      input: { requested: B, active: A, accessible: [A], isSuperAdmin: true },
      expected: { kind: "unavailable", tenantId: B },
    },
    {
      // "pending", NOT "none": the caller cleans the parameter off the URL on "none", and doing that
      // mid-flight removes the input the pending fetch was going to be judged against, so the switch
      // never happens and the link behaves exactly like the tenant-less one it replaced.
      name: "the accessible list has not arrived: nothing is decided yet, and the parameter must survive",
      input: { requested: B, active: A, accessible: null, isSuperAdmin: true },
      expected: { kind: "pending" },
    },
    {
      name: "an empty accessible list is an answer, unlike a missing one",
      input: { requested: B, active: A, accessible: [], isSuperAdmin: true },
      expected: { kind: "unavailable", tenantId: B },
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(tenantDeepLinkAction(c.input)).toEqual(c.expected);
    });
  }
});
