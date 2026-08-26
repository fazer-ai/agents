import { afterAll, describe, expect, mock, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  type MockUserEntity,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// ── ISSUE #372: A FILTER THE CALLER TYPED IS EITHER USED OR REFUSED ──
//
// Driven through the REAL app rather than against the parsers alone, because what the issue is
// about is the ANSWER the caller gets. Measured against a running instance before this branch, on
// a tenant holding five log rows across two agents:
//
//   agentId=101   -> 200, 3 items          agentId=abc  -> 200, 5 items (the whole tenant)
//   cursor=360141 -> 200, next=360139      cursor=abc   -> 200, next=360141 (the same page, forever)
//   limit=abc     -> 500                   page=-5      -> 500 (a negative skip reaches Prisma)
//
// The services are stubbed so the assertion is about the boundary, not the query: a request that
// reaches the stub was ACCEPTED, and what it carries is the filter the handler built.

setupPrismaMock();

const seen: Record<string, unknown> = {};
const record =
  (key: string) =>
  (...args: unknown[]) => {
    seen[key] = args[1];
    return Promise.resolve({ items: [], nextCursor: null, entries: [] });
  };

const flowlogRead = await import("@/modules/flowlog/read");
mock.module("@/modules/flowlog/read", () => ({
  ...flowlogRead,
  listExecutionLogs: mock(record("logs")),
}));
const auditService = await import("@/modules/audit/service");
mock.module("@/modules/audit/service", () => ({
  ...auditService,
  listAudit: mock(async (..._a: unknown[]) => []),
}));

const conversationsService = await import("@/modules/conversations/service");
mock.module("@/modules/conversations/service", () => ({
  ...conversationsService,
  listConversations: mock(record("conversations")),
}));
const adminService = await import("@/api/features/admin/admin.service");
mock.module("@/api/features/admin/admin.service", () => ({
  ...adminService,
  getUsers: mock(async (..._a: unknown[]) => ({
    users: [],
    total: 0,
    page: 1,
    totalPages: 0,
  })),
}));

const app = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/flowlog/read", () => flowlogRead);
  mock.module("@/modules/audit/service", () => auditService);
  mock.module("@/modules/conversations/service", () => conversationsService);
  mock.module("@/api/features/admin/admin.service", () => adminService);
});

// TENANT_ADMIN, which is what these routes ask for.
const admin: MockUserEntity = { ...mockUser, role: "TENANT_ADMIN" };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(admin),
  }));
const { token } = (await (
  await tokenApp.handle(
    new Request("http://localhost/mint", { method: "POST" }),
  )
).json()) as { token: string };

const BunReq = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

async function get(path: string): Promise<Response> {
  return app.handle(
    new BunReq(`http://localhost/api${path}`, {
      headers: { cookie: `fazerai_auth_token=${token}` },
    }),
  );
}

// Every leg of the same question, one row per (route, parameter, value).
const REFUSED: Array<[path: string, param: string]> = [
  ["/v1/logs?source=all&agentId=abc", "agentId"],
  ["/v1/logs?source=all&agentId=", "agentId"],
  ["/v1/logs?source=all&agentId=9223372036854775808", "agentId"],
  ["/v1/logs?source=all&conversationId=abc", "conversationId"],
  ["/v1/logs?source=all&cursor=abc", "cursor"],
  ["/v1/logs?source=all&since=yesterday", "since"],
  ["/v1/logs?source=all&since=2026-02-30T00:00:00Z", "since"],
  ["/v1/logs?source=all&since=2026-01-01", "since"],
  ["/v1/logs?source=all&until=garbage", "until"],
  ["/v1/logs?source=all&limit=abc", "limit"],
  ["/v1/logs?source=all&limit=3.5", "limit"],
  ["/v1/logs/export?source=all&agentId=abc", "agentId"],
  ["/v1/logs/export?source=all&since=yesterday", "since"],
  ["/v1/logs/export?source=all&maxRows=abc", "maxRows"],
  ["/v1/audit?limit=abc", "limit"],
  ["/v1/conversations?limit=abc", "limit"],
  ["/v1/conversations?limit=3.5", "limit"],
  ["/v1/conversations/1/messages?before=abc", "before"],
  // `page=-5` is a well-formed integer, so it is refused one layer down by the service that owns
  // the range (see query-param.test.ts) — and `getUsers` is stubbed here, which would make an
  // assertion about it vacuous. The live A/B in the PR body drives that one end to end.
  ["/admin/users?page=abc", "page"],
  ["/admin/users?page=2.5", "page"],
  ["/v1/metrics?since=garbage", "since"],
  ["/v1/metrics/kpis?since=2026-02-30T00:00:00Z", "since"],
  ["/v1/metrics/timeseries?since=08/26/2026 10:00", "since"],
  ["/v1/metrics/costs?since=2026-01-01", "since"],
  // Round 1 of review found these four: the same question in four places the first sweep missed.
  // A cursor that restarts the page and a status that widens to every status are the two failures
  // this endpoint's siblings already refuse; `tenantId=` empty is the fleet-wide listing answering
  // a request narrowed to one tenant.
  ["/v1/conversations?cursor=abc", "cursor"],
  ["/v1/conversations?cursor=", "cursor"],
  ["/v1/conversations?cursor=9223372036854775808", "cursor"],
  // `status` and `maxRows=0` are refused one layer down, by the services that own the vocabulary
  // and the range — and those services are stubbed here, so asserting them over HTTP would be
  // vacuous. service-count-range.test.ts drives both.
  ["/v1/logs/export?source=all&maxRows=abc", "maxRows"],
  ["/v1/metrics/timeseries?tz=Not/AZone", "tz"],
  ["/v1/metrics/timeseries?tz=", "tz"],
  // Round 2: `Number` reads spellings a count does not have, and two of them as a DIFFERENT
  // number. All of these passed `Number.isInteger` before the decimal regex.
  ["/v1/logs?source=all&limit=1e3", "limit"],
  ["/v1/logs?source=all&limit=0x10", "limit"],
  ["/v1/logs?source=all&limit=0b11", "limit"],
  ["/v1/logs?source=all&limit=%2B7", "limit"],
  ["/v1/logs?source=all&limit=12.0", "limit"],
  ["/v1/logs?source=all&limit=%2012%20", "limit"],
  ["/v1/logs?source=all&limit=-5", "limit"],
  // `9007199254740993` comes back from `Number` as `...992`: a count the caller never named.
  ["/v1/logs?source=all&limit=9007199254740993", "limit"],
  ["/v1/conversations/1/messages?before=9007199254740993", "before"],
  // Round 3: the EMPTY value in the text and vocabulary filters. An unknown `level` reaches the
  // query and answers zero rows, which is correct; `level=` is dropped by `buildLogWhere`'s
  // truthiness and answers the tenant's whole table, which is the widening this branch is about.
  ["/v1/logs?source=all&level=", "level"],
  ["/v1/logs?source=all&stage=", "stage"],
  ["/v1/logs?source=all&turnId=", "turnId"],
  ["/v1/logs?source=all&search=", "search"],
  ["/v1/logs?source=all&search=%20%20", "search"],
  ["/v1/logs/export?source=all&level=", "level"],
  ["/v1/logs/export?source=all&search=", "search"],
  ["/v1/audit?action=", "action"],
  ["/v1/conversations?q=", "q"],
  ["/v1/agents?q=", "q"],
];

describe("a query filter the server cannot use is a 400 that names it", () => {
  for (const [path, param] of REFUSED) {
    test(`${path} → 400 on ${param}`, async () => {
      const res = await get(path);
      // The status FIRST: 429 would mean the rate limiter answered instead of the boundary.
      expect(`${path}: ${res.status}`).toBe(`${path}: 400`);
      const body = (await res.json()) as { field?: string };
      expect(body.field).toBe(param);
    });
  }
});

describe("an unknown value is not an unusable one", () => {
  // The line this branch draws: `level=bogus` reaches the query and answers zero rows, which is a
  // correct answer to a filter nothing matches and is distinguishable by the client from a widened
  // one. Refusing it would mean the server owning a vocabulary it does not own (`stage`/`level` are
  // validated Strings on purpose, so a new stage does not need a deploy to be queryable).
  for (const q of [
    "level=bogus",
    "stage=nosuchstage",
    "turnId=nope",
    "search=zzz",
  ]) {
    test(`${q} is accepted and narrows, not refused`, async () => {
      const res = await get(`/v1/logs?source=all&${q}`);
      expect(`${q}: ${res.status}`).toBe(`${q}: 200`);
    });
  }
});

describe("the admin tenant filter, which only a SUPER_ADMIN can send", () => {
  // `resolveScope` reads `tenantId` ONLY for a SUPER_ADMIN; for every other role the parameter is
  // ignored on purpose (a tenant admin must never be able to aim a read at another tenant). So the
  // refusal lives in that branch, and asserting it as a TENANT_ADMIN would pass with the parse
  // deleted.
  const su: MockUserEntity = {
    ...mockUser,
    role: "SUPER_ADMIN",
    tenantId: null,
  };

  async function asSuperAdmin(path: string): Promise<Response> {
    mockFindUnique.mockImplementation(() => Promise.resolve(su));
    const minted = (await (
      await new Elysia()
        .use(authPlugin)
        .post("/mint", async ({ setAuthCookie }) => ({
          token: await setAuthCookie(su),
        }))
        .handle(new Request("http://localhost/mint", { method: "POST" }))
    ).json()) as { token: string };
    try {
      return await app.handle(
        new BunReq(`http://localhost/api${path}`, {
          headers: { cookie: `fazerai_auth_token=${minted.token}` },
        }),
      );
    } finally {
      mockFindUnique.mockImplementation(() => Promise.resolve(admin));
    }
  }

  // Every route that reads the shared `resolveScope`, not just the one the issue named: round 2 of
  // review found /admin/stats and /v1/mcp/admin/tokens publishing only 401/403 while their handlers
  // could now answer 400, and sweeping the callers turned up /admin/invitations as a third.
  const SUPER_ADMIN_ROUTES = [
    "/admin/users",
    "/admin/stats",
    "/admin/invitations",
    "/v1/mcp/admin/tokens",
  ];

  for (const route of SUPER_ADMIN_ROUTES) {
    for (const value of ["abc", "", "9223372036854775808"]) {
      test(`${route}?tenantId=${value} → 400`, async () => {
        const res = await asSuperAdmin(`${route}?tenantId=${value}`);
        expect(`${route} ${value}: ${res.status}`).toBe(
          `${route} ${value}: 400`,
        );
        expect(((await res.json()) as { field?: string }).field).toBe(
          "tenantId",
        );
      });
    }
  }

  test("a usable tenant id still scopes the listing", async () => {
    const res = await asSuperAdmin("/admin/users?tenantId=7");
    expect(res.status).toBe(200);
  });
});

describe("a filter the server CAN use still reaches the service", () => {
  test("every good value arrives parsed, and none of them is dropped", async () => {
    const res = await get(
      "/v1/logs?source=all&agentId=101&conversationId=7&cursor=42&since=2026-01-01T00:00:00Z&limit=2",
    );
    expect(res.status).toBe(200);
    expect(seen.logs).toMatchObject({
      agentId: 101n,
      conversationId: 7n,
      cursor: 42n,
      since: new Date("2026-01-01T00:00:00Z"),
      limit: 2,
    });
  });

  test("an ABSENT filter is not a refusal", async () => {
    const res = await get("/v1/logs?source=all");
    expect(res.status).toBe(200);
    expect(seen.logs).toMatchObject({
      agentId: undefined,
      cursor: undefined,
      since: undefined,
      limit: undefined,
    });
  });
});
