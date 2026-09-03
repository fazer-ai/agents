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

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does not
// run, while the mock was installed for the whole worker before `dbUp` was decided.
afterAll(() => {
  mock.module("@/modules/audit/service", () => realAudit);
});

const ADMIN_ID = 9403n;
let tenantId = 0n;
let cookie = "";
let agentCookie = "";
// The session is resolved from the USER ROW, not from the token, so the role the endpoint gates on
// is this one. A cookie signed as AGENT against a row that says TENANT_ADMIN is admitted, which is
// how a "not an admin" assertion passes while proving nothing.
let role: "TENANT_ADMIN" | "AGENT" = "TENANT_ADMIN";

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

async function sign(role: "TENANT_ADMIN" | "AGENT"): Promise<string> {
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
    expect(body.nextCursor).toBe(body.entries[1]?.id ?? "");
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
});
