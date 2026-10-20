import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { getKnowledgeActivity } from "@/modules/analytics/activity";
import {
  type DashboardFilter,
  logWhereSql,
  usageWhereSql,
} from "@/modules/analytics/filter";
import { getInstanceMetrics } from "@/modules/analytics/service";
import { runClientTurn } from "@/modules/client-channel/service";
import { listExecutionLogs } from "@/modules/flowlog/read";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { UsageReportingModel } from "../utils/scripted-models";

// Anonymous traffic on the client channel, told apart where the operator reads it: the source stays
// `client` (the tenant's client ceiling covers both), and each usage row and log line of a turn says
// whether that turn served an anonymous visitor's session. The Logs and the dashboard filter on it.

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
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let agentId = 0n;
let ctx: TenantContext;
const threads: Record<"anonymous" | "identified", string> = {
  anonymous: "",
  identified: "",
};

async function turn(userId: string): Promise<string> {
  const r = await runClientTurn({
    ctx,
    agentId,
    user: { id: userId },
    clientTools: [],
    base: appDb,
    message: "Oi",
    deps: {
      makeModel: (() => new UsageReportingModel(["Olá!"])) as never,
      checkpointer: new MemorySaver(),
    },
  });
  return r.threadId;
}

async function countUsage(f: DashboardFilter): Promise<number> {
  const [row] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM llm_usage u
     WHERE u.tenant_id = ${tenantId} AND ${usageWhereSql("u", f)}`);
  return row?.n ?? 0;
}

async function countLines(f: DashboardFilter): Promise<number> {
  const [row] = await suDb.$queryRaw<{ n: number }[]>(Prisma.sql`
    SELECT COUNT(*)::int AS n FROM execution_logs l
     WHERE l.tenant_id = ${tenantId} AND ${logWhereSql("l", f)}`);
  return row?.n ?? 0;
}

describe.skipIf(!dbUp)("anonymous traffic on the client channel", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CCA", slug: `cca-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "cliente",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-6-luna",
            credentialRef: `vault:${key.id}`,
          },
        },
      })
    ).id;
    // A row and a line of another source, never anonymous: an audience is client traffic only.
    await suDb.llmUsage.create({
      data: {
        tenantId,
        model: "gpt-6-luna",
        source: "inbox",
        threadId: "inbox-t",
      },
    });
    await suDb.executionLog.create({
      data: {
        tenantId,
        turnId: "inbox-turn",
        stage: "generate",
        source: "inbox",
      },
    });
    threads.anonymous = await turn("anon:77:sessao");
    threads.identified = await turn("ana");
  });

  afterAll(async () => {
    if (!dbUp) return;
    await clearFlowLog(suDb, { tenantId });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("each turn's usage and lines carry who it served, under the one client source", async () => {
    const usage = await suDb.llmUsage.findMany({
      where: { tenantId },
      select: { threadId: true, source: true, anonymous: true },
    });
    const lines = await flowLogRows(suDb, {
      where: {
        tenantId,
        threadId: { in: [threads.anonymous, threads.identified] },
      },
      select: { threadId: true, source: true, anonymous: true },
    });
    const of = (rows: typeof usage, thread: string) =>
      [
        ...new Set(
          rows
            .filter((r) => r.threadId === thread)
            .map((r) => `${r.source}:${r.anonymous}`),
        ),
      ].sort();
    expect({
      usage: {
        anonymous: of(usage, threads.anonymous),
        identified: of(usage, threads.identified),
      },
      lines: {
        anonymous: of(lines, threads.anonymous),
        identified: of(lines, threads.identified),
      },
    }).toEqual({
      usage: { anonymous: ["client:true"], identified: ["client:false"] },
      lines: { anonymous: ["client:true"], identified: ["client:false"] },
    });
  });

  test("the Logs filter one audience, and an audience with another source matches nothing", async () => {
    const threadsOf = async (opts: Parameters<typeof listExecutionLogs>[1]) => [
      ...new Set(
        (await listExecutionLogs(ctx, opts, appDb)).items.map(
          (i) => `${i.threadId}:${i.anonymous}`,
        ),
      ),
    ];
    expect({
      anonymous: await threadsOf({ source: "client", audience: "anonymous" }),
      identified: await threadsOf({
        source: "client",
        audience: "identified",
      }),
      both: (await threadsOf({ source: "client" })).length,
      elsewhere: await threadsOf({ source: "all", audience: "anonymous" }),
      inbox: await threadsOf({ audience: "anonymous" }),
    }).toEqual({
      anonymous: [`${threads.anonymous}:true`],
      identified: [`${threads.identified}:false`],
      both: 2,
      elsewhere: [`${threads.anonymous}:true`],
      inbox: [],
    });
  });

  test("the dashboard sums one audience, through the ledger and the log fragments alike", async () => {
    const calls = async (f: DashboardFilter) =>
      (await getInstanceMetrics(ctx, f, appDb)).llm.calls;
    const anyLines = await countLines({ source: "client" });
    expect({
      usage: {
        anonymous: await countUsage({
          source: "client",
          audience: "anonymous",
        }),
        identified: await countUsage({
          source: "client",
          audience: "identified",
        }),
        both: await countUsage({ source: "client" }),
        inbox: await countUsage({ source: "inbox", audience: "anonymous" }),
        anySource: await countUsage({ audience: "identified" }),
      },
      metrics: {
        anonymous: await calls({ source: "client", audience: "anonymous" }),
        both: await calls({ source: "client" }),
        inbox: await calls({ source: "inbox", audience: "anonymous" }),
      },
      lines:
        (await countLines({ source: "client", audience: "anonymous" })) +
          (await countLines({ source: "client", audience: "identified" })) ===
        anyLines,
      linesSplit:
        (await countLines({ audience: "anonymous" })) > 0 &&
        (await countLines({ audience: "identified" })) > 0,
      inboxLineOutside:
        (await countLines({ audience: "identified" })) ===
        (await countLines({ source: "client", audience: "identified" })),
    }).toEqual({
      usage: { anonymous: 1, identified: 1, both: 2, inbox: 0, anySource: 1 },
      metrics: { anonymous: 1, both: 2, inbox: 0 },
      lines: true,
      linesSplit: true,
      inboxLineOutside: true,
    });
  });

  test("a knowledge suggestion counts under its thread's owner", async () => {
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "Docs" },
    });
    for (const [n, threadId] of [
      [0, threads.anonymous],
      [1, threads.identified],
      [2, threads.identified],
    ] as const)
      await suDb.approvalQueueItem.create({
        data: {
          tenantId,
          knowledgeBaseId: kb.id,
          agentId,
          threadId,
          proposedContent: "x",
          normalizedHash: `cca-${n}`,
        },
      });
    const proposed = async (f: DashboardFilter) =>
      (await getKnowledgeActivity(ctx, f, appDb)).proposed;
    expect({
      anonymous: await proposed({ source: "client", audience: "anonymous" }),
      identified: await proposed({ source: "client", audience: "identified" }),
      both: await proposed({ source: "client" }),
    }).toEqual({ anonymous: 1, identified: 2, both: 3 });
  });
});
