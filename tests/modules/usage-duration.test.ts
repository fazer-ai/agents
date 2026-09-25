import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { recordDirectUsage } from "@/graph/usage";

// Issue #855: every billed call records how long it took, beside its tokens. The LangChain capture is
// driven by a real turn in tests/graph/runtime.test.ts; this is the other writer, the one vision (and
// any call made outside LangChain) goes through.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;
let tenantId = 0n;

describe.skipIf(!dbUp)("a direct call's duration (issue #855)", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "dur855", slug: `dur855-${process.pid}` },
      })
    ).id;
  });
  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRaw`DELETE FROM llm_usage WHERE tenant_id = ${tenantId}`;
      await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("is written when the caller measured it, and stays null when nobody did", async () => {
    const flow = {
      tenantId,
      turnId: "t-dur-855",
      source: "inbox" as const,
      base: appDb,
    };
    await recordDirectUsage(flow, {
      model: "vision-model",
      node: "vision",
      promptTokens: 10,
      completionTokens: 2,
      durationMs: 1234.6,
    });
    await recordDirectUsage(flow, {
      model: "vision-model",
      node: "vision",
      promptTokens: 11,
      completionTokens: 2,
    });
    const rows = await suDb.llmUsage.findMany({
      where: { tenantId },
      orderBy: { promptTokens: "asc" },
      select: { durationMs: true },
    });
    expect(rows.map((r) => r.durationMs)).toEqual([1235, null]);
  });
});
