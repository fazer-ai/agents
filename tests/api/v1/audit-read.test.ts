import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";
import { syntheticAction } from "../../utils/audit-action";

// THE READ ENDPOINT (issue #401), driven through real requests.
//
// `tests/modules/audit-read.test.ts` proves the service pages and filters. This one proves the door
// the console page will actually knock on: that every filter the caller types reaches the service,
// that the page shape (`entries` + `nextCursor` + `latestAt`) is on the wire rather than an array,
// and that the endpoint still refuses a caller who is not a TENANT_ADMIN.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

setupPrismaMock();

const auditService = await import("@/modules/audit/service");
// A COPY taken before the mock is installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const realAudit = { ...auditService };

mock.module("@/modules/audit/service", () => ({
  ...realAudit,
  // Call-through, with the test database the controller has no way to inject. Never a stub: the
  // module is mocked for the whole worker, and a swallowed implementation would turn somebody
  // else's file green for the wrong reason.
  listAudit: (
    ctx: TenantContext,
    opts: Parameters<typeof auditService.listAudit>[1],
  ) => realAudit.listAudit(ctx, opts, app),
}));

const auditExport = await import("@/modules/audit/export");
const realExport = { ...auditExport };
mock.module("@/modules/audit/export", () => ({
  ...realExport,
  exportAudit: (
    ctx: TenantContext,
    opts: Parameters<typeof auditExport.exportAudit>[1],
  ) => realExport.exportAudit(ctx, opts, app),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does not
// run, while the mock was installed for the whole worker before `dbUp` was decided.
afterAll(() => {
  mock.module("@/modules/audit/service", () => realAudit);
  mock.module("@/modules/audit/export", () => realExport);
});

const ADMIN_ID = 9403n;
let tenantId = 0n;
let cookie = "";
let agentCookie = "";
// The session is resolved from the USER ROW, not from the token, so the role the endpoint gates on
// is this one. A cookie signed as AGENT against a row that says TENANT_ADMIN is admitted, which is
// how a "not an admin" assertion passes while proving nothing.
let role: "SUPER_ADMIN" | "TENANT_ADMIN" | "AGENT" = "TENANT_ADMIN";

interface Page {
  entries: {
    id: string;
    action: string;
    actorType: string;
    createdAt: string;
  }[];
  nextCursor: string | null;
  latestAt: string | null;
}

async function get(qs: string, jar = cookie): Promise<Response> {
  return server.handle(
    new BunRequest(`http://localhost/api/v1/audit${qs}`, {
      headers: { cookie: jar },
    }),
  );
}

async function sign(
  role: "SUPER_ADMIN" | "TENANT_ADMIN" | "AGENT",
): Promise<string> {
  const token = await new SignJWT({
    userId: ADMIN_ID.toString(),
    email: "admin@example.com",
    role,
    tenantId: tenantId.toString(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.jwtSecret));
  return `fazerai_auth_token=${token}`;
}

describe.skipIf(!dbUp)("the trail has a door the console can use", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    const t = await su.tenant.create({
      data: { name: "AUDREAD", slug: `audread-${process.pid}` },
    });
    tenantId = t.id;
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId,
        email: "admin@example.com",
        passwordHash: null,
        googleId: null,
        name: null,
        role,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    cookie = await sign("TENANT_ADMIN");
    agentCookie = await sign("AGENT");
    const ctx: TenantContext = {
      tenantId,
      userId: ADMIN_ID,
      role: "TENANT_ADMIN",
    };
    for (const [action, actorType] of [
      ["one.a", "user"],
      ["two.b", "mcp"],
      ["three.c", "user"],
    ] as const) {
      await runScopedOn(app, ctx, (db) =>
        realAudit.recordAudit(db, tenantId, {
          action: syntheticAction(action),
          actorId: ADMIN_ID,
          actorType,
          after: { x: 1 },
        }),
      );
    }
  });

  afterAll(async () => {
    if (dbUp && su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the page comes back as a page, not as a bare list", async () => {
    const res = await get("?limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body.entries.map((e) => e.action)).toEqual(["three.c", "two.b"]);
    // Without this the caller has no way to reach row three, and no way to tell a full page from
    // the end of the trail.
    // The cursor names the row the page stopped on, in BOTH columns the walk is ordered by (#530).
    // Opaque by contract, so this reads it apart rather than rebuilding it.
    expect(body.nextCursor).toBe(
      `${body.entries[1]?.createdAt}|${body.entries[1]?.id}`,
    );
    expect(body.latestAt).toBe(body.entries[0]?.createdAt ?? "");
  });

  test("the cursor the page returned reaches the next page", async () => {
    const first = (await (await get("?limit=2")).json()) as Page;
    const second = (await (
      await get(`?limit=2&cursor=${first.nextCursor}`)
    ).json()) as Page;
    expect(second.entries.map((e) => e.action)).toEqual(["one.a"]);
    expect(second.nextCursor).toBeNull();
  });

  test("every filter the caller types reaches the query", async () => {
    expect(
      (
        ((await (await get("?actorType=mcp")).json()) as Page).entries ?? []
      ).map((e) => e.action),
    ).toEqual(["two.b"]);
    expect(
      (((await (await get("?action=one.a")).json()) as Page).entries ?? []).map(
        (e) => e.action,
      ),
    ).toEqual(["one.a"]);
    expect(
      (
        ((await (await get(`?actorId=${ADMIN_ID}`)).json()) as Page).entries ??
        []
      ).length,
    ).toBe(3);
    // A window that starts after every row exists: the range is applied, not dropped.
    expect(
      (
        ((await (await get("?since=2099-01-01T00:00:00Z")).json()) as Page)
          .entries ?? []
      ).length,
    ).toBe(0);
  });

  // The newest row of the whole trail, past a filter that hides it: the number an operator compares
  // against a record's own updatedAt to learn that a change happened which the trail cannot describe.
  test("the newest row is reported past a filter that excludes it", async () => {
    const all = (await (await get("?limit=1")).json()) as Page;
    const narrowed = (await (await get("?action=one.a")).json()) as Page;
    expect(narrowed.entries.map((e) => e.action)).toEqual(["one.a"]);
    expect(narrowed.latestAt).toBe(all.latestAt);
    expect(narrowed.latestAt).not.toBeNull();
  });

  test("a caller who is not a tenant admin is refused", async () => {
    expect((await get("", "")).status).toBe(401);
    role = "AGENT";
    try {
      expect((await get("", agentCookie)).status).toBe(403);
    } finally {
      role = "TENANT_ADMIN";
    }
  });

  // WHICH TRAIL THE DOOR OPENS ON (#520). The rows keyed to no tenant are unreachable from the
  // tenant read -- the policy compares `tenant_id` to the GUC and NULL satisfies no comparison -- so
  // asking for them is a scope, and the scope is SUPER_ADMIN's.
  describe("the fleet scopes", () => {
    afterAll(() => {
      role = "TENANT_ADMIN";
    });

    // REFUSED, NOT NARROWED. A scope that answered with the caller's own rows would report a fleet
    // trail that is empty, which is the misreading this issue exists to end.
    for (const scope of ["fleet", "all"]) {
      test(`a tenant admin asking for ${scope} gets 403`, async () => {
        role = "TENANT_ADMIN";
        const res = await get(`?scope=${scope}`, await sign("TENANT_ADMIN"));
        expect(res.status).toBe(403);
      });
    }

    // THE CURSOR FROM BEFORE #530 IS A BARE ID, and it is refused with the same 400 as any other
    // malformed parameter. Read as the new key it would silently answer from another place in the
    // trail, under a pager that goes on saying "Page 2" -- so a stored bookmark fails loudly and its
    // holder starts the walk again, instead of quietly reading the wrong page.
    test("a cursor from before the keyset change is refused, not reinterpreted", async () => {
      role = "TENANT_ADMIN";
      for (const bad of ["115", "abc", "|", "2026-01-01T00:00:00.000Z|x"]) {
        const res = await get(
          `?cursor=${encodeURIComponent(bad)}`,
          await sign("TENANT_ADMIN"),
        );
        expect(res.status).toBe(400);
      }
      // ...and the cursor the endpoint itself just handed out is accepted.
      const first = await get("?limit=1", await sign("TENANT_ADMIN"));
      const { nextCursor } = (await first.json()) as { nextCursor: string };
      const next = await get(
        `?limit=1&cursor=${encodeURIComponent(nextCursor)}`,
        await sign("TENANT_ADMIN"),
      );
      expect(next.status).toBe(200);
    });

    test("a scope that is not one of the three is refused at the door", async () => {
      role = "TENANT_ADMIN";
      const res = await get("?scope=everything", await sign("TENANT_ADMIN"));
      expect(res.status).toBe(400);
    });

    test("a super admin reads the fleet trail, and this tenant's rows are not in it", async () => {
      role = "SUPER_ADMIN";
      const res = await get("?scope=fleet", await sign("SUPER_ADMIN"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      // Every row this file seeded belongs to a tenant, so a fleet read must hold none of them.
      const seeded = new Set(["one.a", "two.b", "three.c"]);
      expect(body.entries.filter((e) => seeded.has(e.action))).toEqual([]);
    });

    test("a super admin reading all sees this tenant's rows again", async () => {
      role = "SUPER_ADMIN";
      const res = await get("?scope=all", await sign("SUPER_ADMIN"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      const seeded = new Set(["one.a", "two.b", "three.c"]);
      expect(body.entries.filter((e) => seeded.has(e.action)).length).toBe(3);
    });

    test("the tenant scope is still the default", async () => {
      role = "TENANT_ADMIN";
      const res = await get("", await sign("TENANT_ADMIN"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      expect(body.entries.length).toBeGreaterThan(0);
    });
  });
  // THE DOOR THE EXPORT BUTTON USES (#521). The console cannot serialize this itself -- the Logs
  // page's own button downloads through its REST endpoint and turns the body into a Blob -- so the
  // route is not an extra surface, it is the button's transport.
  describe("the export door", () => {
    interface Dump {
      filename: string;
      contentType: string;
      content: string;
      count: number;
      truncated: boolean;
      truncatedBy: "rows" | "bytes" | null;
    }
    const dump = async (qs: string, jar = cookie) => {
      const res = await server.handle(
        new BunRequest(`http://localhost/api/v1/audit/export${qs}`, {
          headers: { cookie: jar },
        }),
      );
      return { res, body: (await res.json()) as Dump };
    };

    test("it hands back a named CSV of the tenant's own rows", async () => {
      role = "TENANT_ADMIN";
      const { res, body } = await dump("", await sign("TENANT_ADMIN"));
      expect(res.status).toBe(200);
      expect(body.filename).toMatch(/^agents-audit-.+\.csv$/);
      expect(body.contentType).toBe("text/csv;charset=utf-8");
      expect(body.content.split("\r\n")[0]).toBe(
        "id,created_at,action,actor_type,actor_id,target,tenant_id,before,after",
      );
      expect(body.count).toBeGreaterThan(0);
    });

    // The filter is the point: the export is quoted, so it has to be the screen's answer.
    test("it carries the same filter the list does", async () => {
      role = "TENANT_ADMIN";
      const jar = await sign("TENANT_ADMIN");
      const listed = (await (await get("?action=two.b", jar)).json()) as Page;
      const { body } = await dump("?action=two.b", jar);
      expect(body.count).toBe(listed.entries.length);
      expect(body.content).toContain("two.b");
      expect(body.content).not.toContain("one.a");
    });

    test("a bad instant is refused here too, rather than exported as no filter", async () => {
      role = "TENANT_ADMIN";
      const { res } = await dump(
        "?since=2026-01-01",
        await sign("TENANT_ADMIN"),
      );
      expect(res.status).toBe(400);
    });

    test("the cap is reported, not applied in silence", async () => {
      role = "TENANT_ADMIN";
      const { body } = await dump("?maxRows=1", await sign("TENANT_ADMIN"));
      expect(body.count).toBe(1);
      expect(body.truncated).toBe(true);
      expect(body.truncatedBy).toBe("rows");
    });

    test("a tenant admin exporting the fleet trail is refused, not narrowed", async () => {
      role = "TENANT_ADMIN";
      const { res, body } = await dump(
        "?scope=fleet",
        await sign("TENANT_ADMIN"),
      );
      expect(res.status).toBe(403);
      expect(body.content).toBeUndefined();
    });

    test("and an agent has no door here at all", async () => {
      role = "AGENT";
      const { res } = await dump("", await sign("AGENT"));
      expect(res.status).toBe(403);
    });
  });
});
