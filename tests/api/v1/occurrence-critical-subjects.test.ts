// The critical subjects over REST and MCP (docs/occurrences.md, "Critical themes"): the monitor's list
// saved and read back in order, refused when it is not a list of texts or when the caller is not an
// admin, previewed by MCP before it applies; and every theme read carries whether it is critical, the
// critical flagged ones first.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { generateApiKey } from "@/modules/api-keys/verify";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { criticalBasis } from "@/modules/occurrences/critical";
import type { OccurrencesPatch } from "@/modules/occurrences/settings";
import { dbProbeFailed } from "@/tests/db-gate";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

setupPrismaMock();

const verify = await import("@/modules/api-keys/verify");
const realVerify = { ...verify };
mock.module("@/modules/api-keys/verify", () => ({
  ...realVerify,
  verifyApiKey: (token: string) => realVerify.verifyApiKey(token, app),
}));

const monitors = await import("@/modules/occurrences/monitors");
const realMonitors = { ...monitors };
mock.module("@/modules/occurrences/monitors", () => ({
  ...realMonitors,
  requireMonitor: (ctx: TenantContext, id: bigint) =>
    realMonitors.requireMonitor(ctx, id, app),
  updateMonitorConfig: (
    ctx: TenantContext,
    target: bigint | "first",
    patch: OccurrencesPatch,
  ) => realMonitors.updateMonitorConfig(ctx, target, patch, app),
}));

const views = await import("@/modules/occurrences/views");
const realViews = { ...views };
mock.module("@/modules/occurrences/views", () => ({
  ...realViews,
  listThemes: (
    ctx: TenantContext,
    monitorId: bigint,
    opts: { flaggedOnly?: boolean; limit?: number } = {},
  ) => realViews.listThemes(ctx, monitorId, opts, app),
  countThemes: (
    ctx: TenantContext,
    monitorId: bigint,
    opts: { flaggedOnly?: boolean } = {},
  ) => realViews.countThemes(ctx, monitorId, opts, app),
}));

const server = (await import("@/app")).default;
const { occurrencesGet, occurrencesSet, occurrenceThemesList } = await import(
  "@/modules/mcp/write-occurrences"
);

afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/occurrences/monitors", () => realMonitors);
  mock.module("@/modules/occurrences/views", () => realViews);
});

let tenantId = 0n;
let monitorA = 0n;
let monitorB = 0n;
let adminKey = "";
let agentKey = "";

function call(
  method: string,
  path: string,
  key: string,
  body?: unknown,
): Promise<Response> {
  return server.handle(
    new BunRequest(`http://localhost/api/v1${path}`, {
      method,
      headers: {
        authorization: `Bearer ${key}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
const configOf = async (id: bigint) =>
  (
    (await (
      await call("GET", `/occurrences/monitors/${id}/config`, adminKey)
    ).json()) as { occurrences: { criticalSubjects: string[] } }
  ).occurrences;
const updates = () =>
  su?.auditLog.count({
    where: { tenantId, action: "occurrence_monitor.updated" },
  }) ?? Promise.resolve(0);

describe.skipIf(!dbUp)("critical subjects over REST and MCP", () => {
  const principal = (): VerifiedToken => ({
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  });

  beforeAll(async () => {
    if (!su) return;
    tenantId = (
      await su.tenant.create({
        data: { name: "CRIT428", slug: `crit-428-${process.pid}` },
      })
    ).id;
    monitorA = (
      await su.occurrenceMonitor.create({
        data: { tenantId, name: "A", position: 0, config: {} },
      })
    ).id;
    monitorB = (
      await su.occurrenceMonitor.create({
        data: { tenantId, name: "B", position: 1, config: {} },
      })
    ).id;
    const key = async (role: "TENANT_ADMIN" | "AGENT") => {
      const { token, hash, prefix } = generateApiKey();
      await su?.apiKey.create({
        data: {
          tenantId,
          displayName: `${role}-428`,
          keyHash: hash,
          keyPrefix: prefix,
          role,
          createdByUserId: 9428n,
          stepUpAt: new Date(),
        },
      });
      return token;
    };
    adminKey = await key("TENANT_ADMIN");
    agentKey = await key("AGENT");
  });

  afterAll(async () => {
    if (!tenantId) return;
    await su?.$executeRawUnsafe(
      `DELETE FROM api_keys WHERE tenant_id = ${tenantId}`,
    );
    await su?.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("REST saves the list in order, only on the monitor named, and keeps the rest of the block", async () => {
    expect((await configOf(monitorA)).criticalSubjects).toEqual([]);
    const before = await configOf(monitorA);
    const res = await call(
      "PUT",
      `/occurrences/monitors/${monitorA}/config`,
      adminKey,
      { criticalSubjects: ["falha no pagamento", "sistema fora do ar"] },
    );
    expect(res.status).toBe(200);
    const after = await configOf(monitorA);
    expect(after).toEqual({
      ...before,
      criticalSubjects: ["falha no pagamento", "sistema fora do ar"],
    });
    expect((await configOf(monitorB)).criticalSubjects).toEqual([]);
    const audit = await su?.auditLog.findFirst({
      where: {
        tenantId,
        action: "occurrence_monitor.updated",
        target: `occurrence_monitor:${monitorA}`,
      },
      orderBy: { id: "desc" },
    });
    expect(JSON.stringify(audit?.before)).toContain('"criticalSubjects":[]');
    expect(JSON.stringify(audit?.after)).toContain(
      '"criticalSubjects":["falha no pagamento","sistema fora do ar"]',
    );
  });

  test("REST refuses a list that is not one, and a caller who is not an admin, and nothing changes", async () => {
    await call("PUT", `/occurrences/monitors/${monitorA}/config`, adminKey, {
      criticalSubjects: ["falha no pagamento"],
    });
    const n = await updates();
    const bad = await call(
      "PUT",
      `/occurrences/monitors/${monitorA}/config`,
      adminKey,
      { criticalSubjects: 42 },
    );
    expect(bad.status).toBe(422);
    const agent = await call(
      "PUT",
      `/occurrences/monitors/${monitorA}/config`,
      agentKey,
      { criticalSubjects: ["outro"] },
    );
    expect(agent.status).toBe(403);
    expect((await configOf(monitorA)).criticalSubjects).toEqual([
      "falha no pagamento",
    ]);
    expect(await updates()).toBe(n);
    // An empty list empties it.
    await call("PUT", `/occurrences/monitors/${monitorA}/config`, adminKey, {
      criticalSubjects: [],
    });
    expect((await configOf(monitorA)).criticalSubjects).toEqual([]);
  });

  test("MCP previews the list, applies it on dry_run false, and reads it back", async () => {
    const preview = await occurrencesSet(
      principal(),
      {
        monitor_id: String(monitorB),
        criticalSubjects: ["cobrança sem entrega"],
      },
      { base: app },
    );
    expect(preview).toMatchObject({ ok: true });
    expect(JSON.stringify(preview)).toContain("cobrança sem entrega");
    expect((await configOf(monitorB)).criticalSubjects).toEqual([]);
    await occurrencesSet(
      principal(),
      {
        monitor_id: String(monitorB),
        criticalSubjects: ["cobrança sem entrega"],
        dry_run: false,
      },
      { base: app },
    );
    const got = await occurrencesGet(
      principal(),
      { monitor_id: String(monitorB) },
      { base: app },
    );
    expect(JSON.stringify(got)).toContain(
      '"criticalSubjects":["cobrança sem entrega"]',
    );
    expect((await configOf(monitorB)).criticalSubjects).toEqual([
      "cobrança sem entrega",
    ]);
  });

  test("REST and MCP list each theme's mark, the critical flagged one first", async () => {
    if (!su) return;
    const instance = await seedChatwootInstance(su, {
      tenantId,
      accountId: 3,
      baseUrl: `https://cw-428-${process.pid}.example.com`,
      adminToken: encryptJson("ADMIN"),
    });
    const inbox = await su.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instance.id,
        chatwootInboxId: 428,
        name: "SAC",
      },
    });
    await su.occurrenceMonitor.update({
      where: { id: monitorA },
      data: { config: { inboxIds: [String(inbox.id)] } },
    });
    let cw = 4280;
    const theme = async (
      title: string,
      critical: boolean,
      flaggedMinutesAgo: number,
      n: number,
    ) => {
      const t = await su?.occurrenceTheme.create({
        data: {
          tenantId,
          monitorId: monitorA,
          title,
          critical,
          // The monitor's block here has no list and no context: the basis of nothing.
          criticalBasis: criticalBasis(undefined),
          flags: ["new"],
          flaggedAt: new Date(Date.now() - flaggedMinutesAgo * 60_000),
        },
      });
      for (let i = 0; i < n; i += 1) {
        const c = await su?.conversation.create({
          data: {
            tenantId,
            chatwootInstanceId: instance.id,
            chatwootConversationId: ++cw,
            inboxId: inbox.id,
            threadId: `crit-428-${cw}`,
            status: "open",
          },
        });
        await su?.occurrenceThemeMember.create({
          data: {
            tenantId,
            monitorId: monitorA,
            themeId: t?.id as bigint,
            conversationId: c?.id as bigint,
            sentence: `${title} ${i}`,
            readAt: new Date(),
          },
        });
      }
    };
    await theme("Comum", false, 1, 6);
    await theme("Grave", true, 20, 2);
    const res = await call(
      "GET",
      `/occurrences/monitors/${monitorA}/themes`,
      adminKey,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      themes: { title: string; critical: boolean }[];
    };
    expect(body.themes.map((t) => [t.title, t.critical])).toEqual([
      ["Grave", true],
      ["Comum", false],
    ]);
    const viaMcp = await occurrenceThemesList(
      principal(),
      { monitor_id: String(monitorA), limit: 1 },
      { base: app },
    );
    expect(JSON.stringify(viaMcp)).toContain('"title":"Grave"');
    expect(JSON.stringify(viaMcp)).toContain('"critical":true');
    expect(JSON.stringify(viaMcp)).not.toContain("Comum");
  });
});
