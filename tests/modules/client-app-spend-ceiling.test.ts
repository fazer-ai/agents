import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { assertAppSpendCeiling } from "@/modules/client-apps/limits";
import {
  createClientApp,
  getClientApp,
  updateClientApp,
} from "@/modules/client-apps/service";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { clientAppUpdate } from "@/modules/mcp/write-client-apps";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { wantsSpendPoll } from "@/modules/spend-ceiling/arm";
import {
  pollTenantSpend,
  spendPollHandler,
} from "@/modules/spend-ceiling/poll";
import { dbProbeFailed } from "@/tests/db-gate";

// An embedding app's own monthly spend ceiling. The tenant's spend poll also sums each app's share of
// the client source: the calls on threads owned by its signed-in users or its anonymous visitors,
// never another app's or a proxy-route user's, and only this month's. The SDK turn reads that figure
// and refuses past the app's number. The poll runs while the tenant's ceiling is on OR an app has one.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const NOW = new Date();
const LAST_MONTH = new Date(
  Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15),
);
let tenantId = 0n;
let agentId = 0n;
let ctx: TenantContext;
const apps: Record<"a" | "b" | "c", bigint> = { a: 0n, b: 0n, c: 0n };

async function threadOf(externalId: string): Promise<string> {
  const user = await suDb.externalUser.upsert({
    where: {
      tenantId_channel_externalId: { tenantId, channel: "client", externalId },
    },
    create: { tenantId, channel: "client", externalId },
    update: {},
    select: { id: true },
  });
  const threadId = `${tenantId}:client:${agentId}:${crypto.randomUUID()}`;
  await suDb.detachedThread.create({
    data: {
      threadId,
      tenantId,
      agentId,
      kind: "client",
      externalUserId: user.id,
    },
  });
  return threadId;
}

async function spent(
  threadId: string,
  costUsd: number,
  at = NOW,
  source = "client",
) {
  await suDb.llmUsage.create({
    data: { tenantId, model: "m", source, threadId, costUsd, createdAt: at },
  });
}

describe.skipIf(!dbUp)("an embedding app's own spend ceiling", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CASC", slug: `casc-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    agentId = (
      await suDb.agent.create({
        data: { tenantId, name: "a", systemPrompt: "x", modelConfig: {} },
      })
    ).id;
    for (const k of ["a", "b", "c"] as const)
      apps[k] = BigInt(
        (
          await createClientApp(
            ctx,
            agentId,
            {
              name: k,
              allowedOrigins: ["https://x.exemplo.com"],
              ...(k === "c" ? {} : { monthlyCeilingUsd: 10 }),
            },
            appDb,
          )
        ).app.id,
      );
    const a1 = await threadOf(`app:${apps.a}:1`);
    const aAnon = await threadOf(`anon:${apps.a}:AAAAAAAAAAAAAAAAAAAAAA`);
    const b1 = await threadOf(`app:${apps.b}:1`);
    const c1 = await threadOf(`app:${apps.c}:1`);
    const proxy = await threadOf(`ana-${apps.a}:1`);
    await spent(a1, 2.5);
    await spent(aAnon, 1.25);
    await spent(a1, 9, LAST_MONTH);
    await spent(a1, 0.5, NOW, "inbox");
    await spent(b1, 4);
    await spent(c1, 3);
    await spent(proxy, 7);
  });

  afterAll(async () => {
    if (tenantId) await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("creating an app with a ceiling arms the tenant's poll, its ceiling off", async () => {
    const jobs = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "SPEND_CEILING_POLL" },
      select: { dedupeKey: true },
    });
    expect(jobs.map((j) => j.dedupeKey)).toEqual(["spend-ceiling"]);
  });

  test("the poll sums each app's share of this month's client cost, for the apps with a ceiling", async () => {
    await pollTenantSpend(tenantId, { base: appDb, now: NOW });
    const rows = await suDb.spendCostSnapshot.findMany({
      where: { tenantId, source: { startsWith: "app:" } },
      select: { source: true, costUsd: true },
      orderBy: { source: "asc" },
    });
    expect(rows.map((r) => [r.source, Number(r.costUsd)])).toEqual(
      [
        [`app:${apps.a}`, 3.75],
        [`app:${apps.b}`, 4],
      ].sort(),
    );
  });

  test("the turn is refused once the app's share reaches its ceiling, and the figure shows on the app", async () => {
    const at = (cents: number | null, id = apps.a) =>
      assertAppSpendCeiling(
        { id, tenantId, monthlyCeilingCents: cents },
        NOW,
        appDb,
      ).then(
        () => "allowed",
        (e: { statusCode: number; translationKey: string }) => [
          e.statusCode,
          e.translationKey,
        ],
      );
    await updateClientApp(ctx, apps.a, { monthlyCeilingUsd: 12.5 }, appDb);
    expect({
      reached: await at(375),
      under: await at(376),
      none: await at(null),
      notPolled: await at(1, apps.c),
      dto: await getClientApp(ctx, apps.a, appDb).then((d) => [
        d.monthlyCeilingUsd,
        d.monthSpendUsd,
      ]),
    }).toEqual({
      reached: [429, "errors.clientAppSpendCeilingReached"],
      under: "allowed",
      none: "allowed",
      notPolled: "allowed",
      dto: [12.5, 3.75],
    });
  });

  test("a figure that cannot be read lets the turn through", async () => {
    const broken = appDb.$extends({
      query: {
        spendCostSnapshot: {
          async findUnique() {
            throw new Error("pool timeout");
          },
        },
      },
    }) as unknown as PrismaClient;
    expect(
      await assertAppSpendCeiling(
        { id: apps.a, tenantId, monthlyCeilingCents: 1 },
        NOW,
        broken,
      ).then(() => "allowed"),
    ).toBe("allowed");
  });

  test("the MCP preview of an unchanged ceiling shows no change, in dollars", async () => {
    const was = config.clientChannel.enabled;
    config.clientChannel.enabled = true;
    try {
      const principal = {
        userId: 1n,
        tenantId,
        clientId: "c",
        jti: "j",
        role: "TENANT_ADMIN",
        scopes: ["mcp:read", "mcp:write"],
      } as unknown as VerifiedToken;
      const preview = (usd: number) =>
        clientAppUpdate(
          principal,
          { client_app_id: String(apps.a), monthly_ceiling_usd: usd },
          { base: appDb },
        );
      await updateClientApp(ctx, apps.a, { monthlyCeilingUsd: 12.5 }, appDb);
      const changes = async (usd: number) =>
        (
          (await preview(usd)) as {
            data?: { changes?: Record<string, unknown> };
          }
        ).data?.changes?.monthlyCeilingUsd ?? null;
      expect({ same: await changes(12.5), moved: await changes(20) }).toEqual({
        same: null,
        moved: { before: 12.5, after: 20 },
      });
    } finally {
      config.clientChannel.enabled = was;
    }
  });

  test("the poll runs while an app has a ceiling, even with the tenant's ceiling off", async () => {
    const job = { tenantId } as unknown as ClaimedJob;
    const withApp = [
      await wantsSpendPoll(tenantId, appDb),
      (await spendPollHandler(job, appDb)).outcome,
    ];
    for (const k of ["a", "b"] as const)
      await updateClientApp(ctx, apps[k], { monthlyCeilingUsd: null }, appDb);
    const without = [
      await wantsSpendPoll(tenantId, appDb),
      (await spendPollHandler(job, appDb)).outcome,
    ];
    expect({ withApp, without }).toEqual({
      withApp: [true, "reschedule"],
      without: [false, "done"],
    });
  });
});
