import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { runClientTurn } from "@/modules/client-channel/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { FailingModel, UsageReportingModel } from "../utils/scripted-models";

// A client turn whose primary provider is down and whose fallback answers is a SUCCESSFUL turn: the
// user gets a reply, and nothing else on it says a provider the operator pays for took none of the
// traffic. The client channel is customer traffic like the inbox, so the trail has to carry the same
// warn the inbox writes, read here from the real flow log table.

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

const PRIMARY_MODEL = "primary-mini";
const FALLBACK_MODEL = "claude-haiku-4-5";
const REPLY = "A nota foi rejeitada pelo GTIN.";

let tenantId = 0n;
let agentId = 0n;
let ctx: TenantContext;

const overloaded = () =>
  Object.assign(new Error("upstream overloaded"), { status: 503 });

describe.skipIf(!dbUp)("a client turn the fallback answers", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CCF", slug: `ccf-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const key = async (name: string) =>
      `vault:${
        (
          await suDb.vaultEntry.create({
            data: { tenantId, name, secret: encryptJson("sk-test") },
            select: { id: true },
          })
        ).id
      }`;
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Copiloto",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: PRIMARY_MODEL,
            credentialRef: await key("primary-key"),
          },
          settings: {
            modelFallback: {
              provider: "anthropic",
              model: FALLBACK_MODEL,
              credentialRef: await key("fallback-key"),
            },
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.$executeRawUnsafe(
        `DELETE FROM llm_usage WHERE tenant_id = ${tenantId}`,
      );
      await suDb.tenant.deleteMany({ where: { id: tenantId } });
    }
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("the trail says the fallback took the turn, and why", async () => {
    const primary = new FailingModel(overloaded());
    const fallback = new UsageReportingModel([REPLY]);
    const out = await runClientTurn({
      ctx,
      agentId,
      user: { id: "ana" },
      message: "por que a nota foi rejeitada?",
      clientTools: [],
      base: appDb,
      deps: {
        makeModel: ((args: { model: string }) =>
          args.model === FALLBACK_MODEL
            ? fallback
            : primary) as unknown as never,
        checkpointer: new MemorySaver(),
      },
    });
    // The primary was really asked and the fallback answered, so this is a fallback turn.
    expect(primary.calls).toBeGreaterThan(0);
    expect(out).toMatchObject({ status: "done", reply: REPLY });

    const rows = await flowLogRows(suDb, {
      where: { tenantId, threadId: out.threadId, stage: "generate" },
      select: { level: true, provider: true, model: true, detail: true },
      orderBy: { id: "asc" },
    });
    const line = rows.find(
      (r) => (r.detail as Record<string, unknown> | null)?.fallbackReason,
    );
    expect(line).toBeDefined();
    expect(line?.level).toBe("warn");
    expect(line?.provider).toBe("anthropic");
    expect(line?.model).toBe(FALLBACK_MODEL);
    expect(
      (line?.detail as Record<string, unknown> | undefined)?.fallbackFrom,
    ).toBe("openai");
  });
});
