import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// The configuration warnings, over the console's own door. `tests/modules/config-health-read.test.ts`
// proves the module computes them; it cannot see the half this issue is about — whether a caller who
// is not the editor page can ASK. The route is the second of the two non-browser surfaces (the MCP
// tool is the first), and it is also the only one that answers in the operator's own language, so
// the Accept-Language case below is the only place `currentLocale` is exercised end to end.
//
// The service is WRAPPED rather than stubbed, for the reason `mock.module` always demands here: it is
// global to the worker and outlives this file. All the wrapper does is record the context the route
// handed down and give the read the test database, which the controller has no way to inject.

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

const health = await import("@/modules/agents/config-health-read");
const real = { ...health };
const seen: TenantContext[] = [];
mock.module("@/modules/agents/config-health-read", () => ({
  ...real,
  readAgentConfigHealth: mock(
    async (
      ctx: TenantContext,
      id: bigint,
      opts: Parameters<typeof health.readAgentConfigHealth>[2],
    ) => {
      seen.push(ctx);
      return real.readAgentConfigHealth(ctx, id, { ...opts, base: app });
    },
  ),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does NOT
// run, and `mock.module` has already installed the wrapper for the whole worker by then.
afterAll(() => {
  mock.module("@/modules/agents/config-health-read", () => real);
});

const ADMIN_ID = 9467n;
let tenantId = 0n;
let agentId = "";
let cookie = "";

describe.skipIf(!dbUp)("GET /v1/agents/:id/config-health", () => {
  beforeAll(async () => {
    if (!su || !app) return;
    tenantId = (
      await su.tenant.create({
        data: { name: "CHREST", slug: `chrest-${process.pid}` },
      })
    ).id;
    mockFindUnique.mockImplementation(() =>
      Promise.resolve({
        id: ADMIN_ID,
        tenantId,
        email: "admin@example.com",
        passwordHash: null,
        googleId: null,
        name: null,
        role: "TENANT_ADMIN" as const,
        lastLoginAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    );
    cookie = `fazerai_auth_token=${await new SignJWT({
      userId: ADMIN_ID.toString(),
      email: "admin@example.com",
      role: "TENANT_ADMIN",
      tenantId: tenantId.toString(),
    })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(config.jwtSecret))}`;
    const key = await su.vaultEntry.create({
      data: {
        tenantId,
        name: "model-key",
        kind: "generic",
        secret: encryptJson("sk-live"),
      },
    });
    const agent = await su.agent.create({
      data: {
        tenantId,
        name: "REST subject",
        systemPrompt: "x",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${key.id}`,
        },
        // The issue's own example: the switch reads "on" and nothing screens anything.
        settings: { guardrails: { enabled: true }, stt: { enabled: false } },
      },
      select: { id: true },
    });
    agentId = String(agent.id);
  });

  afterAll(async () => {
    if (dbUp && su && tenantId) {
      for (const table of ["agents", "vault_entries"]) {
        await su.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("no session is refused before the read runs", async () => {
    seen.length = 0;
    const res = await server.handle(
      new BunRequest(
        `http://localhost/api/v1/agents/${agentId}/config-health`,
        {},
      ),
    );
    expect(res.status).toBe(401);
    expect(seen).toEqual([]);
  });

  test("a console session gets the warnings, with the tenant it asked as", async () => {
    seen.length = 0;
    const res = await server.handle(
      new BunRequest(
        `http://localhost/api/v1/agents/${agentId}/config-health`,
        { headers: { cookie } },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      healthy: boolean;
      counts: Record<string, number>;
      issues: { key: string; severity: string; message: string }[];
    };
    expect(seen.length).toBe(1);
    expect(seen[0]?.tenantId).toBe(tenantId);
    expect(body.healthy).toBe(false);
    const guardrails = body.issues.find((i) => i.key === "guardrails");
    expect(guardrails?.severity).toBe("blocking");
    expect(guardrails?.message).toContain("unscreened");
    expect(body.counts.blocking).toBeGreaterThanOrEqual(1);
  });

  test("the sentence follows Accept-Language", async () => {
    const res = await server.handle(
      new BunRequest(
        `http://localhost/api/v1/agents/${agentId}/config-health`,
        { headers: { cookie, "accept-language": "pt-BR" } },
      ),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      issues: { key: string; message: string }[];
    };
    const guardrails = body.issues.find((i) => i.key === "guardrails");
    // The pt-BR copy, from the same catalog the console reads. Asserted on a word that only exists
    // in the translation, so an English fallback leaking through fails here.
    expect(guardrails?.message).toContain("sem triagem");
  });
});
