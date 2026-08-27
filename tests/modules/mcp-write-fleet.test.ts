import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { tenantCreate, tenantGet, tenantList } from "@/modules/mcp/write-fleet";

// Fleet/admin write tools: the admin gate (mcp:admin + SUPER_ADMIN role) is DB-free; cross-tenant
// create/list/get need a real Postgres (skipIf). These run as the audited asSuperAdmin path.

function superAdmin(over: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    userId: 1n,
    tenantId: null,
    role: "SUPER_ADMIN",
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("MCP fleet gate (no DB)", () => {
  test("tenant_list without mcp:admin → insufficient_scope", async () => {
    const r = await tenantList(
      superAdmin({ scopes: ["mcp:read", "mcp:write"] }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("tenant_create with mcp:admin but non-SUPER_ADMIN → forbidden", async () => {
    const r = await tenantCreate(
      superAdmin({ role: "TENANT_ADMIN", tenantId: 1n }),
      { name: "x", slug: "x" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("forbidden");
  });
});

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

// NOTE: The read tools (tenant_list/tenant_get) work in EVERY edition, so their fixture tenant is
// seeded straight through Prisma rather than through tenant_create. Provisioning is the only
// Pro-side surface here (tenantCreate calls the paired tenants.admin.service, a ProEditionError stub
// in Free), so only that one case is @full-only — routing the whole fixture through it would have
// dragged the reads down with it in the Free tree.
describe.skipIf(!dbUp)("MCP fleet tools (DB)", () => {
  const prefix = `fleet-${process.pid}`;
  const slug = `${prefix}-seed`;
  let seededId = 0n;

  beforeAll(async () => {
    const t = await suDb.tenant.create({ data: { name: "Fleet Co", slug } });
    seededId = t.id;
  });

  // Covers both the seeded tenant and the one the Full-only case provisions, so the cleanup needs no
  // marker of its own.
  afterAll(async () => {
    const rows = await suDb.tenant.findMany({
      where: { slug: { startsWith: prefix } },
      select: { id: true },
    });
    for (const { id } of rows) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target = 'tenant:${id}'`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${id}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("tenant_list (cross-tenant) includes the seeded tenant", async () => {
    const r = await tenantList(superAdmin(), { base: appDb });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const tenants = r.data.tenants as { id: string; slug: string }[];
      expect(tenants.find((t) => t.slug === slug)).toBeDefined();
    }
  });

  test("tenant_get returns any tenant by id", async () => {
    const r = await tenantGet(
      superAdmin(),
      { tenant_id: String(seededId) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const tenant = r.data.tenant as { slug: string };
      expect(tenant.slug).toBe(slug);
    }
  });

  test("tenant_get invalid id → error", async () => {
    const r = await tenantGet(
      superAdmin(),
      { tenant_id: "nope" },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid tenant_id");
  });

  // The other half of "invalid", and the half a `try`/`catch` around `BigInt` cannot see: these all
  // CONVERT. Before the fix the first reached Postgres and came back as a bind error rather than as
  // this tool's own refusal, and the rest addressed a row the caller never named (`0x11` is 17).
  // Every other MCP surface already shared `parseMcpId`; this one had its own `try`. Issue #407.
  test("tenant_get an id BigInt would convert but a column would not → error", async () => {
    const wrong: string[] = [];
    for (const raw of [
      "99999999999999999999",
      "0x11",
      " 7 ",
      "+7",
      "1e3",
      "",
    ]) {
      const r = await tenantGet(
        superAdmin(),
        { tenant_id: raw },
        { base: appDb },
      );
      if (r.ok || !r.error.includes("invalid tenant_id")) {
        wrong.push(`${JSON.stringify(raw)} -> ${JSON.stringify(r)}`);
      }
    }
    expect(wrong).toEqual([]);
  });
});
