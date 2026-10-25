// The flag history over REST and MCP (docs/occurrences.md, "Flag history"): the episodes overlapping the
// period, the same list on both; a period that is not two instants in order is refused naming it.

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { generateApiKey } from "@/modules/api-keys/verify";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { dbProbeFailed } from "@/tests/db-gate";
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

const views = await import("@/modules/occurrences/views");
const realViews = { ...views };
mock.module("@/modules/occurrences/views", () => ({
  ...realViews,
  listFlagEpisodes: (
    ctx: TenantContext,
    monitorId: bigint,
    window: { since: Date; until: Date },
    opts: { limit?: number } = {},
  ) => realViews.listFlagEpisodes(ctx, monitorId, window, opts, app),
  countFlagEpisodes: (
    ctx: TenantContext,
    monitorId: bigint,
    window: { since: Date; until: Date },
  ) => realViews.countFlagEpisodes(ctx, monitorId, window, app),
}));

const server = (await import("@/app")).default;
const { occurrenceFlagEpisodesList } = await import(
  "@/modules/mcp/write-occurrences"
);

afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/occurrences/views", () => realViews);
});

const HOUR = 3_600_000;
const NOW = Date.now();
let tenantId = 0n;
let otherTenantId = 0n;
let monitorId = 0n;
let otherMonitorId = 0n;
let adminKey = "";

function get(path: string): Promise<Response> {
  return server.handle(
    new BunRequest(`http://localhost/api/v1${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${adminKey}` },
    }),
  );
}
const iso = (h: number) => new Date(NOW - h * HOUR).toISOString();
const path = (id: bigint, since: string, until: string) =>
  `/occurrences/monitors/${id}/flag-episodes?since=${encodeURIComponent(since)}&until=${encodeURIComponent(until)}`;

describe.skipIf(!dbUp)("flag episodes over REST and MCP", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "EPI402", slug: `epi-402-${process.pid}` },
    });
    tenantId = t.id;
    otherTenantId = (
      await su.tenant.create({
        data: { name: "EPI402B", slug: `epi-402-b-${process.pid}` },
      })
    ).id;
    monitorId = (
      await su.occurrenceMonitor.create({
        data: { tenantId, name: "M", config: {} },
      })
    ).id;
    otherMonitorId = (
      await su.occurrenceMonitor.create({
        data: { tenantId: otherTenantId, name: "M", config: {} },
      })
    ).id;
    const theme = await su.occurrenceTheme.create({
      data: { tenantId, monitorId, title: "Ingresso nao chegou" },
    });
    for (const [title, from, to] of [
      ["Ontem a tarde", 30, 28.5],
      ["Agora", 1, null],
    ] as const)
      await su.occurrenceFlagEpisode.create({
        data: {
          tenantId,
          monitorId,
          themeId: theme.id,
          title,
          kinds: ["new"],
          startedAt: new Date(NOW - from * HOUR),
          lastFlaggedAt: new Date(NOW - (to ?? 0) * HOUR),
          endedAt: to === null ? null : new Date(NOW - to * HOUR),
          peak: 6,
        },
      });
    const { token, hash, prefix } = generateApiKey();
    await su.apiKey.create({
      data: {
        tenantId,
        displayName: "admin-402",
        keyHash: hash,
        keyPrefix: prefix,
        role: "TENANT_ADMIN",
        createdByUserId: 9402n,
        stepUpAt: new Date(),
      },
    });
    adminKey = token;
  });

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      if (!tid) continue;
      await su?.$executeRawUnsafe(
        `DELETE FROM api_keys WHERE tenant_id = ${tid}`,
      );
      await su?.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("REST lists the episodes overlapping the period, and MCP returns the same", async () => {
    const res = await get(path(monitorId, iso(29), iso(0)));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      episodes: { title: string; endedAt: string | null }[];
      total: number;
    };
    expect(body.total).toBe(2);
    const capped = (await (
      await get(`${path(monitorId, iso(29), iso(0))}&limit=1`)
    ).json()) as { episodes: unknown[]; total: number };
    expect(capped.episodes).toHaveLength(1);
    expect(capped.total).toBe(2);
    expect(body.episodes.map((e) => e.title)).toEqual([
      "Agora",
      "Ontem a tarde",
    ]);
    expect(body.episodes[0]?.endedAt).toBeNull();
    const yesterdayOnly = (await (
      await get(path(monitorId, iso(48), iso(24)))
    ).json()) as { episodes: { title: string }[] };
    expect(yesterdayOnly.episodes.map((e) => e.title)).toEqual([
      "Ontem a tarde",
    ]);
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      clientId: "c",
      jti: "j",
    };
    const viaMcp = await occurrenceFlagEpisodesList(
      principal,
      { monitor_id: String(monitorId), since: iso(29), until: iso(0) },
      { base: app },
    );
    expect(viaMcp).toMatchObject({ ok: true });
    expect(JSON.stringify(viaMcp)).toContain("Ontem a tarde");
    expect(JSON.stringify(viaMcp)).toContain("Agora");
  });

  test("a period that is not two instants in order is refused naming the parameter", async () => {
    const bad = await get(path(monitorId, "ontem", iso(0)));
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("since");
    const backwards = await get(path(monitorId, iso(0), iso(5)));
    expect(backwards.status).toBe(400);
    expect(await backwards.text()).toContain("until");
    const principal: VerifiedToken = {
      userId: 1n,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read"],
      clientId: "c",
      jti: "j",
    };
    expect(
      await occurrenceFlagEpisodesList(
        principal,
        { monitor_id: String(monitorId), since: iso(0), until: iso(5) },
        { base: app },
      ),
    ).toMatchObject({ ok: false });
  });

  test("another account's monitor is a 404", async () => {
    const res = await get(path(otherMonitorId, iso(29), iso(0)));
    expect(res.status).toBe(404);
  });
});
