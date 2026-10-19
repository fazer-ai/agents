import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { runPlaygroundTurn } from "@/modules/playground/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";
import { FailingModel, UsageReportingModel } from "../utils/scripted-models";

// The playground writes the fallback's lines the way a real turn does: the line where the fallback
// took the turn names the provider it took it from, and the line that closes the stage is labelled
// with the model that answered. Read from the real `execution_logs` rows.

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

let tenantId = 0n;
let agentId = 0n;
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const overloaded = () =>
  Object.assign(new Error("upstream overloaded"), { status: 503 });

function turn(primary: unknown, fallback: unknown) {
  return runPlaygroundTurn({
    ctx: ctx(),
    agentId,
    message: "oi",
    guardrails: false,
    base: appDb,
    deps: {
      makeModel: ((args: { model: string }) =>
        args.model === FALLBACK_MODEL ? fallback : primary) as never,
      checkpointer: new MemorySaver(),
    },
  });
}

async function generateRows() {
  const rows = await flowLogRows(suDb, {
    // flowlog-scope: agent — the file's one agent, whose lines beforeEach clears.
    where: { tenantId, agentId, stage: "generate" },
    select: {
      level: true,
      status: true,
      provider: true,
      model: true,
      detail: true,
    },
    orderBy: { id: "asc" },
  });
  return rows.map((r) => ({
    ...r,
    detail: (r.detail ?? {}) as Record<string, unknown>,
  }));
}

describe.skipIf(!dbUp)(
  "the playground's lines about the model fallback",
  () => {
    beforeAll(async () => {
      tenantId = (
        await suDb.tenant.create({
          data: { name: "PFL", slug: `pfl-1540-${process.pid}` },
        })
      ).id;
      const key = async (name: string) =>
        (
          await suDb.vaultEntry.create({
            data: { tenantId, name, secret: encryptJson(`sk-${name}`) },
            select: { id: true },
          })
        ).id;
      const primaryKey = await key("primary");
      const fallbackKey = await key("fallback");
      agentId = (
        await suDb.agent.create({
          data: {
            tenantId,
            name: "Com reserva",
            systemPrompt: "x",
            modelConfig: {
              provider: "openai",
              model: PRIMARY_MODEL,
              credentialRef: `vault:${primaryKey}`,
            },
            settings: {
              modelFallback: {
                provider: "anthropic",
                model: FALLBACK_MODEL,
                credentialRef: `vault:${fallbackKey}`,
              },
            },
          },
        })
      ).id;
    });

    beforeEach(async () => {
      await clearFlowLog(suDb, { tenantId });
    });

    afterAll(async () => {
      if (su && tenantId) {
        await clearFlowLog(su, { tenantId });
        await su.tenant.delete({ where: { id: tenantId } });
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("the fallback's line names the provider it took the turn from, and the closing line the model that answered", async () => {
      await turn(
        new FailingModel(overloaded()),
        new UsageReportingModel(["Olá!"]),
      );
      const rows = await generateRows();
      const took = rows.filter((r) => r.detail.fallbackReason);
      expect(took).toHaveLength(1);
      expect(took[0]).toMatchObject({
        level: "warn",
        status: "ok",
        provider: "anthropic",
        model: FALLBACK_MODEL,
      });
      expect(took[0]?.detail).toMatchObject({
        fallbackFrom: "openai",
        fallbackReason: "HTTP 503",
        primaryFailure: "HTTP 503",
      });
      // No line of this turn calls the primary that never answered a success.
      expect(
        rows.filter((r) => r.status === "ok" && r.model === PRIMARY_MODEL),
      ).toEqual([]);
    });

    test("a fallback that fails too leaves no ok line, and the primary's failure a line of its own", async () => {
      await turn(
        new FailingModel(overloaded()),
        new FailingModel(
          Object.assign(new Error("fallback down"), { status: 500 }),
        ),
      ).catch(() => "failed");
      const rows = await generateRows();
      expect(rows.filter((r) => r.detail.fallbackReason)).toEqual([]);
      expect(
        rows.filter((r) => r.status === "ok" && r.model === FALLBACK_MODEL),
      ).toEqual([]);
      expect(rows.find((r) => r.detail.handedToFallback)).toMatchObject({
        level: "info",
        status: "error",
        provider: "openai",
        model: PRIMARY_MODEL,
        detail: { failure: "HTTP 503", handedToFallback: true },
      });
      expect(rows.find((r) => r.detail.fallbackFailed)).toMatchObject({
        status: "error",
        model: FALLBACK_MODEL,
        detail: { failure: "HTTP 500" },
      });
      expect(rows.filter((r) => r.level === "error")).toHaveLength(1);
    });

    test("a primary that answers leaves no fallback line, and closes under its own name", async () => {
      const fallback = new UsageReportingModel(["nunca"]);
      await turn(new UsageReportingModel(["Olá!"]), fallback);
      const rows = await generateRows();
      expect(fallback.calls).toHaveLength(0);
      expect(
        rows.filter(
          (r) =>
            r.detail.fallbackReason ||
            r.detail.fallbackFailed ||
            r.detail.handedToFallback,
        ),
      ).toEqual([]);
      expect(rows.filter((r) => r.model === FALLBACK_MODEL)).toEqual([]);
      // The rows are written fire-and-forget, so the closing line is found by what it says, not by id.
      expect(
        rows.filter(
          (r) =>
            r.status === "ok" &&
            r.provider === "openai" &&
            r.model === PRIMARY_MODEL,
        ),
      ).not.toEqual([]);
    });
  },
);
