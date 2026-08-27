import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import {
  runPlaygroundFollowup,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import { extractInboundFile } from "@/modules/vision/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog } from "../utils/flowlog";

// The two paths the webhook gate does NOT stand in front of (issue #146).
//
// The playground is a second ledger with a second ceiling: an operator testing a prompt in a loop is
// the cheapest way to discover there was no ceiling at all, and the point of keeping the numbers
// apart is that spending the playground one must never silence the agent for customers. Here the
// refusal THROWS, because the operator is looking at the screen.
//
// Vision is the one billed call that runs BEFORE any turn gate decides anything: it reads the
// incoming attachment while the webhook is still working out whether the agent even owns the
// conversation (the same asymmetry #316 measured for attribution). So it asks for itself, and it
// skips rather than throws, because the webhook must never be stranded on it.

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

let tenantId = 0n;
let agentId = 0n;
let visionRef = "";
let instanceId = 0n;
let ctx: TenantContext;

async function setCeiling(
  patch: Record<string, string | number | boolean | null>,
) {
  await suDb.tenant.update({
    where: { id: tenantId },
    data: { settings: { spendCeiling: patch } },
  });
}

async function spend(source: string, prompt: number) {
  await suDb.llmUsage.create({
    data: {
      tenantId,
      model: "gpt-4o-mini",
      source,
      promptTokens: prompt,
      completionTokens: 0,
    },
  });
}

// The refusal as DATA, so a call that does not throw is a visible `null` rather than a test that
// silently asserts nothing.
async function refusal(
  run: () => Promise<unknown>,
): Promise<{ statusCode: number; key: string | undefined } | null> {
  try {
    await run();
    return null;
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return { statusCode: e.statusCode, key: e.translationKey };
  }
}

// A turn that runs at all fails the test: the model factory is the assertion.
function refusingModel() {
  return () => {
    throw new Error("the model must not be invoked over the ceiling");
  };
}

describe.skipIf(!dbUp)("the spend ceiling on the playground and vision", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SCP", slug: `scp-${process.pid}` },
    });
    tenantId = t.id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 52,
      baseUrl: "https://203.0.113.31:9",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Com teto",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          vision: {
            enabled: true,
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${llmKey.id}`,
          },
        },
      },
      select: { id: true },
    });
    agentId = agent.id;
    visionRef = `vault:${llmKey.id}`;
  });

  beforeEach(async () => {
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    if (!dbUp || tenantId === 0n) return;
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
    await clearFlowLog(suDb, { tenantId });
    await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("a playground turn over its ceiling never reaches the model", async () => {
    await setCeiling({ enabled: true, monthlyPlaygroundTokens: 1000 });
    await spend("playground", 1200);
    // The KEY is the assertion, not the class: `runPlaygroundTurn` throws AppError for half a dozen
    // reasons (no agent, no credential, a model that will not build), so a test that only checked
    // the class would pass on a gate that never ran.
    expect(
      await refusal(() =>
        runPlaygroundTurn({
          ctx,
          agentId,
          message: "oi",
          base: appDb,
          deps: { makeModel: refusingModel(), checkpointer: new MemorySaver() },
        }),
      ),
    ).toEqual({ statusCode: 429, key: "errors.spendCeilingReached" });
  });

  test("a simulated follow-up over the ceiling never reaches the model", async () => {
    await setCeiling({ enabled: true, monthlyPlaygroundTokens: 1000 });
    await spend("playground", 1200);
    expect(
      await refusal(() =>
        runPlaygroundFollowup({
          ctx,
          agentId,
          base: appDb,
          deps: { makeModel: refusingModel(), checkpointer: new MemorySaver() },
        }),
      ),
    ).toEqual({ statusCode: 429, key: "errors.spendCeilingReached" });
  });

  // THE SEPARATION, and the reason there are two numbers rather than one. Same tenant, same month,
  // an inbox ceiling long since blown: the playground still answers, because the ledger tells the
  // two kinds of traffic apart and each answers to its own.
  test("a blown INBOX ceiling does not close the playground", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 100,
      monthlyPlaygroundTokens: 1_000_000,
    });
    await spend("inbox", 999_999);
    const res = await runPlaygroundTurn({
      ctx,
      agentId,
      message: "oi",
      base: appDb,
      deps: {
        makeModel: () =>
          new FakeListChatModel({ responses: ["Claro, posso ajudar."] }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(res.reply).toBe("Claro, posso ajudar.");
  });

  // ...and the other direction, which is the half an operator actually feels: testing all month
  // must not be able to stop the agent from answering a customer.
  test("a blown PLAYGROUND ceiling does not close the inbox", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 1_000_000,
      monthlyPlaygroundTokens: 100,
    });
    await spend("playground", 999_999);
    const { spendCeilingVerdict } = await import(
      "@/modules/spend-ceiling/service"
    );
    const verdict = await spendCeilingVerdict({
      tenantId,
      source: "inbox",
      base: appDb,
    });
    expect(verdict.state).toBe("allowed");
  });

  // Vision asks BEFORE it spends anything, which is what this proves: the Chatwoot client factory
  // throws, so an extraction that got as far as downloading the attachment fails the test.
  test("vision over the ceiling reads no attachment", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1000 });
    await spend("inbox", 1200);
    const result = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 77,
      messageId: 78,
      attachmentId: 79,
      dataUrl: "https://203.0.113.31:9/a.png",
      cfg: {
        enabled: true,
        provider: "openai",
        model: "gpt-4o-mini",
        // A credential that RESOLVES, so the only thing that can stop this before the download is
        // the ceiling. A dangling ref would make the test pass on `credential_not_found` and go on
        // passing with the gate deleted, which is exactly what it did until the mutation said so.
        credentialRef: visionRef,
        baseURL: null,
        extractionPrompt: "descreva",
      },
      base: appDb,
      deps: {
        makeClient: (() => {
          throw new Error(
            "the attachment must not be downloaded over the ceiling",
          );
        }) as never,
      },
    });
    expect(result).toBeNull();
  });

  // ONE REFUSED MESSAGE, ONE `spend_ceiling` LINE. Vision runs on the same customer message the
  // webhook gate refuses moments later, so a gate that announced here as well would put two `over`
  // rows and two alert bumps on the Logs page for one refusal — and the count of refusals is what an
  // operator reads off that page. What this step did is not lost: the `vision` line says `skipped`
  // with `spend_ceiling` as the reason, which is the stage the reader filters by when the question
  // is why an attachment was never read.
  test("vision refused by the ceiling writes its own line and not the gate's", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1000 });
    await spend("inbox", 1200);
    const turnId = `vision-ceiling-${process.pid}`;
    const result = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 77,
      messageId: 78,
      attachmentId: 79,
      dataUrl: "https://203.0.113.31:9/a.png",
      cfg: {
        enabled: true,
        provider: "openai",
        model: "gpt-4o-mini",
        credentialRef: visionRef,
        baseURL: null,
        extractionPrompt: "descreva",
      },
      base: appDb,
      flow: { tenantId, turnId, source: "inbox", base: appDb },
      deps: {
        makeClient: (() => {
          throw new Error(
            "the attachment must not be downloaded over the ceiling",
          );
        }) as never,
      },
    });
    expect(result).toBeNull();
    // NOTE: the assertion is that a line EXISTS and another does NOT, so the settle is required
    // rather than a poll: polling for the absence would only spend the timeout before answering.
    await settleFlowEvents();
    const rows = await suDb.executionLog.findMany({
      where: { turnId },
      select: { stage: true, status: true, detail: true },
    });
    expect(rows.map((r) => r.stage).sort()).toEqual(["vision"]);
    expect(rows[0]?.status).toBe("skipped");
    expect((rows[0]?.detail as { reason?: string })?.reason).toBe(
      "spend_ceiling",
    );
    await clearFlowLog(suDb, { tenantId });
  });

  test("vision under the ceiling is not stopped by the gate", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1_000_000 });
    await spend("inbox", 10);
    // Past the gate it fails on the client, which is exactly how far this test needs it to get:
    // reaching the download is the proof that the ceiling let it through.
    await expect(
      extractInboundFile({
        tenantId,
        instanceId,
        conversationId: 77,
        messageId: 78,
        attachmentId: 79,
        dataUrl: "https://203.0.113.31:9/a.png",
        cfg: {
          enabled: true,
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: visionRef,
          baseURL: null,
          extractionPrompt: "descreva",
        },
        base: appDb,
        deps: {
          makeClient: (() => {
            throw new Error("reached the download");
          }) as never,
        },
      }),
    ).rejects.toThrow("reached the download");
  });
});
