import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { resolveTenantSelector } from "@/api/v1/tenants.service";
import { MAX_DB_ID } from "@/lib/db-id";
import { NotFoundError } from "@/lib/errors";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentGet } from "@/modules/mcp/read";
import { resolveEffectivePrincipal } from "@/modules/mcp/tenant-target";

// MCP tenant targeting: a fleet-level SUPER_ADMIN token is tenant-less and picks the target per call
// via a `tenant` selector (slug or id); a tenant-scoped token keeps its tenant implicit and any
// `tenant` arg it sends is ignored (anti-IDOR — it can never cross). The selector→effective-principal
// logic is DB-free for the early-return cases; resolution needs a real Postgres (skipIf).

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("resolveEffectivePrincipal (no DB)", () => {
  test("tenant-scoped token → effective principal is itself (tenant implicit)", async () => {
    const p = principal({ tenantId: 42n });
    const r = await resolveEffectivePrincipal(p, {});
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.eff.tenantId).toBe(42n);
  });

  test("tenant-scoped token IGNORES a `tenant` arg (cannot cross)", async () => {
    const p = principal({ tenantId: 42n });
    // Even handed a different tenant selector, a tenant user stays fenced to its own tenant.
    const r = await resolveEffectivePrincipal(p, { tenant: "999" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.eff.tenantId).toBe(42n);
  });

  test("SUPER_ADMIN without `tenant` → graceful error (not a throw)", async () => {
    const p = principal({ tenantId: null, role: "SUPER_ADMIN" });
    const r = await resolveEffectivePrincipal(p, {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tenant");
  });

  test("SUPER_ADMIN with a blank `tenant` → error before any DB access", async () => {
    const p = principal({ tenantId: null, role: "SUPER_ADMIN" });
    const r = await resolveEffectivePrincipal(p, { tenant: "   " });
    expect(r.ok).toBe(false);
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

describe.skipIf(!dbUp)("MCP tenant targeting (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let slugA = "";
  let slugB = "";
  let agentA = 0n;

  beforeAll(async () => {
    slugA = `tt-a-${process.pid}`;
    slugB = `tt-b-${process.pid}`;
    const a = await suDb.tenant.create({ data: { name: "TT-A", slug: slugA } });
    tenantA = a.id;
    const b = await suDb.tenant.create({ data: { name: "TT-B", slug: slugB } });
    tenantB = b.id;
    const ag = await suDb.agent.create({
      data: { tenantId: tenantA, name: "Targeted", systemPrompt: "hi" },
    });
    agentA = ag.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM agents WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("resolveTenantSelector resolves by numeric id and by slug", async () => {
    const byId = await resolveTenantSelector(String(tenantA), appDb);
    expect(byId.id).toBe(String(tenantA));
    const bySlug = await resolveTenantSelector(slugA, appDb);
    expect(bySlug.id).toBe(String(tenantA));
  });

  test("resolveTenantSelector throws NotFound for an unknown selector", async () => {
    await expect(
      resolveTenantSelector(`ghost-${process.pid}`, appDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // An all-digits selector past what the column holds. The guard here was `/^\d+$/`, which this
  // passes, and the value then reached Postgres as a bind error — a 500 out of a lookup whose only
  // other outcome is a 404. It is also not a slug anyone can register, so NotFound is the whole
  // answer. Issue #407.
  test("resolveTenantSelector answers NotFound for digits past the column, not a bind error", async () => {
    await expect(
      resolveTenantSelector((MAX_DB_ID + 1n).toString(), appDb),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  test("SUPER_ADMIN drives tenant A then tenant B in one session (per-call target)", async () => {
    const su = principal({ tenantId: null, role: "SUPER_ADMIN" });

    const toA = await resolveEffectivePrincipal(su, { tenant: slugA }, appDb);
    expect(toA.ok).toBe(true);
    if (toA.ok) expect(toA.eff.tenantId).toBe(tenantA);

    // Same principal, different `tenant` on the next call → different effective tenant.
    const toB = await resolveEffectivePrincipal(
      su,
      { tenant: String(tenantB) },
      appDb,
    );
    expect(toB.ok).toBe(true);
    if (toB.ok) expect(toB.eff.tenantId).toBe(tenantB);
  });

  test("SUPER_ADMIN with an unknown `tenant` → graceful error", async () => {
    const su = principal({ tenantId: null, role: "SUPER_ADMIN" });
    const r = await resolveEffectivePrincipal(
      su,
      { tenant: `ghost-${process.pid}` },
      appDb,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("tenant_list");
  });

  test("the effective principal scopes the service AND keeps the fence", async () => {
    const su = principal({ tenantId: null, role: "SUPER_ADMIN" });

    // Targeting A: the agent is visible.
    const effA = await resolveEffectivePrincipal(su, { tenant: slugA }, appDb);
    expect(effA.ok).toBe(true);
    if (effA.ok) {
      const r = await agentGet(
        effA.eff,
        { agent_id: String(agentA) },
        { base: appDb },
      );
      expect(r.ok).toBe(true);
    }

    // Targeting B: A's agent is invisible (tenant-fenced → not found, never a cross-tenant read).
    const effB = await resolveEffectivePrincipal(su, { tenant: slugB }, appDb);
    expect(effB.ok).toBe(true);
    if (effB.ok) {
      const r = await agentGet(
        effB.eff,
        { agent_id: String(agentA) },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("not found");
    }
  });

  test("a TENANT_ADMIN cannot target another tenant (arg ignored, stays fenced)", async () => {
    // A tenant admin for B, handed A's slug, still resolves to B → A's agent is invisible.
    const ta = principal({ tenantId: tenantB, role: "TENANT_ADMIN" });
    const eff = await resolveEffectivePrincipal(ta, { tenant: slugA }, appDb);
    expect(eff.ok).toBe(true);
    if (eff.ok) {
      expect(eff.eff.tenantId).toBe(tenantB);
      const r = await agentGet(
        eff.eff,
        { agent_id: String(agentA) },
        { base: appDb },
      );
      expect(r.ok).toBe(false);
    }
  });
});
