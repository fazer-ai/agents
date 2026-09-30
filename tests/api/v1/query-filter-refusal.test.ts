import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import { authPlugin } from "@/api/lib/auth";
import {
  type MockUserEntity,
  mockFindUnique,
  mockUser,
  setupPrismaMock,
} from "@/tests/utils/prisma-mock";

// A filter the caller typed is either used or refused. Driven through the REAL app, not the parsers
// alone, because what matters is the ANSWER: an unusable filter that is dropped widens the result
// (`agentId=abc` answers the whole tenant, `cursor=abc` the same page forever), and one that reaches
// Prisma unparsed is a 500 (`limit=abc`, `page=-5`).
//
// The services are stubbed so the assertion is about the boundary, not the query: a request that
// reaches the stub was ACCEPTED, and what it carries is the filter the handler built.

setupPrismaMock();

const seen: Record<string, unknown> = {};
const record =
  (key: string) =>
  (...args: unknown[]) => {
    seen[key] = args[1];
    return Promise.resolve({
      items: [],
      nextCursor: null,
      entries: [],
      latestAt: null,
    });
  };

// Spies on the module objects, not registry rewrites: undoing a rewrite with the namespace
// `await import()` returned hands back the LIVE object the rewrite already changed, so the stub
// leaks into every later file in the shard (tests/lib/module-mock-package.test.ts).
const flowlogRead = await import("@/modules/flowlog/read");
// `record` answers an empty page for all three readers, so it cannot carry one derived return type.
// The cast NAMES the function it is standing in for rather than erasing to `never`, so a signature
// change points here instead of passing silently.
const listExecutionLogs = spyOn(
  flowlogRead,
  "listExecutionLogs",
).mockImplementation(
  record("logs") as unknown as typeof flowlogRead.listExecutionLogs,
);

const auditService = await import("@/modules/audit/service");
const listAudit = spyOn(auditService, "listAudit").mockImplementation(
  record("audit") as unknown as typeof auditService.listAudit,
);

const conversationsService = await import("@/modules/conversations/service");
const listConversations = spyOn(
  conversationsService,
  "listConversations",
).mockImplementation(
  record(
    "conversations",
  ) as unknown as typeof conversationsService.listConversations,
);

const adminService = await import("@/api/features/admin/admin.service");
const getUsers = spyOn(adminService, "getUsers").mockImplementation(
  (async () => ({
    users: [],
    total: 0,
    page: 1,
    totalPages: 0,
  })) as unknown as typeof adminService.getUsers,
);

const app = (await import("@/app")).default;

afterAll(() => {
  listExecutionLogs.mockRestore();
  listAudit.mockRestore();
  listConversations.mockRestore();
  getUsers.mockRestore();
});

// TENANT_ADMIN, which is what these routes ask for.
const admin: MockUserEntity = { ...mockUser, role: "TENANT_ADMIN" };
mockFindUnique.mockImplementation(() => Promise.resolve(admin));
const tokenApp = new Elysia()
  .use(authPlugin)
  .post("/mint", async ({ setAuthCookie }) => ({
    token: await setAuthCookie(admin, admin.passwordHash),
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
  // The audit cursor, date range and actor are the same question, and a silently dropped actorType
  // is the worst: it answers the whole trail, which on that page reads as "nothing else happened".
  ["/v1/audit?cursor=abc", "cursor"],
  ["/v1/audit?cursor=9223372036854775808", "cursor"],
  ["/v1/audit?actorId=abc", "actorId"],
  ["/v1/audit?actorType=robot", "actorType"],
  ["/v1/audit?since=yesterday", "since"],
  ["/v1/audit?since=2026-01-01", "since"],
  ["/v1/audit?until=garbage", "until"],
  ["/v1/conversations?limit=abc", "limit"],
  ["/v1/conversations?limit=3.5", "limit"],
  ["/v1/knowledge/bases/1/documents?limit=abc", "limit"],
  ["/v1/knowledge/bases/1/documents?cursor=abc", "cursor"],
  ["/v1/conversations?agentId=abc", "agentId"],
  ["/v1/conversations/1/messages?before=abc", "before"],
  // `page=-5` is a well-formed integer, refused one layer down by the service that owns the range
  // (tests/lib/query-param.test.ts); `getUsers` is stubbed here, so asserting it would be vacuous.
  ["/admin/users?page=abc", "page"],
  ["/admin/users?page=2.5", "page"],
  ["/v1/metrics?since=garbage", "since"],
  ["/v1/metrics/kpis?since=2026-02-30T00:00:00Z", "since"],
  ["/v1/metrics/timeseries?since=08/26/2026 10:00", "since"],
  ["/v1/metrics/costs?since=2026-01-01", "since"],
  // A cursor that restarts the page and a status that widens to every status are failures this
  // endpoint's siblings already refuse; an empty `tenantId=` would be the fleet-wide listing
  // answering a request narrowed to one tenant.
  ["/v1/conversations?cursor=abc", "cursor"],
  ["/v1/conversations?cursor=", "cursor"],
  ["/v1/conversations?cursor=9223372036854775808", "cursor"],
  // `status` and `maxRows=0` are refused one layer down, by the services that own the vocabulary and
  // the range, which are stubbed here; tests/modules/service-count-range.test.ts drives both.
  ["/v1/logs/export?source=all&maxRows=abc", "maxRows"],
  ["/v1/metrics/timeseries?tz=Not/AZone", "tz"],
  ["/v1/metrics/timeseries?tz=", "tz"],
  // `Number` reads spellings a count does not have, two of them as a DIFFERENT number, and all pass
  // `Number.isInteger`: only the decimal regex refuses them.
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
  // The EMPTY value in the text and vocabulary filters: `level=` is dropped by `buildLogWhere`'s
  // truthiness and would answer the tenant's whole table, while an unknown `level` reaches the query
  // and correctly answers zero rows.
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
  // NOTE: `level=bogus` reaches the query and answers zero rows, a correct answer the client can
  // tell apart from a widened one. Refusing it would make the server own a vocabulary it does not
  // (`stage`/`level` are validated Strings on purpose, so a new stage needs no deploy to be queried).
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
          token: await setAuthCookie(su, su.passwordHash),
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

  // Every caller of the shared `resolveScope`, since each one can answer this 400.
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
