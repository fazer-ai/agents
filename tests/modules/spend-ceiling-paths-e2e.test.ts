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
import { clearContactAuthState } from "@/modules/contact-auth/state";
import { settleFlowEvents } from "@/modules/flowlog/scheduled";
import {
  runPlaygroundFollowup,
  runPlaygroundTurn,
} from "@/modules/playground/service";
import {
  extractInboundFile,
  extractPlaygroundFile,
} from "@/modules/vision/service";
import { seedChatwootInstance } from "../utils/chatwoot";
import { clearFlowLog, flowLogRows } from "../utils/flowlog";

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

// A Chatwoot that SERVES the attachment, because the inbound gate now sits after the download: the
// download is what tells that path the file's type, and a ceiling asked before it would be refusing
// a call that an unsupported type was going to stop anyway. What the assertion moves to is the
// PROVIDER — the billed call the ceiling exists in front of — so `providerCalls` is the count that
// matters and the download is just setup.
function visionStub(contentType = "image/png") {
  const providerCalls: string[] = [];
  return {
    providerCalls,
    deps: {
      makeClient: (() => ({
        downloadAttachment: async () => ({
          bytes: new ArrayBuffer(8),
          contentType,
        }),
        updateAttachmentMeta: async () => {},
      })) as never,
      fetchImpl: (async (url: string | URL | Request) => {
        providerCalls.push(String(url));
        throw new Error("the provider must not be called over the ceiling");
      }) as never,
      // So a provider failure does not wait out the retry backoff.
      sleep: async () => {},
    },
  };
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
    // The warning's window is in-process and per (tenant, source, month), so a test that ran before
    // this one could otherwise hold it and turn a missing line into a passing assertion.
    clearContactAuthState();
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

  // A TARGET THAT DOES NOT EXIST WAS NEVER GOING TO SPEND. The same request in a month with budget
  // to spare answers 404, so a 429 here reports a refusal that did not happen and points the
  // operator at their budget over a selector that was simply wrong.
  test("a playground turn on a missing agent is not found, not refused", async () => {
    await setCeiling({ enabled: true, monthlyPlaygroundTokens: 1000 });
    await spend("playground", 1200);
    expect(
      await refusal(() =>
        runPlaygroundTurn({
          ctx,
          agentId: agentId + 9_999_999n,
          message: "oi",
          base: appDb,
          deps: { makeModel: refusingModel(), checkpointer: new MemorySaver() },
        }),
      ),
    ).toEqual({ statusCode: 404, key: "errors.agentNotFound" });
    // The control, over the SAME blown ceiling: an agent that DOES exist is refused, so the 404
    // above measures the target and not a gate that stopped running.
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

  // Vision asks BEFORE IT SPENDS, which is what this proves: the provider seam throws, so an
  // extraction that got as far as the billed call fails the test.
  test("vision over the ceiling never calls the provider", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1000 });
    await spend("inbox", 1200);
    const s = visionStub();
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
      deps: s.deps,
    });
    expect(result).toBeNull();
    expect(s.providerCalls).toEqual([]);
  });

  // AND THE FILE THAT WAS NEVER GOING TO BE READ IS NOT REFUSED. `application/zip` resolves to no
  // vision kind, so the same attachment in a month with budget to spare is skipped as an unsupported
  // type — answering `spend_ceiling` in a spent one names a cause that was not operative, and sends
  // the operator to look at their budget over a file that was never readable.
  test("an unsupported attachment over the ceiling is skipped as unsupported, not as spend", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1000 });
    await spend("inbox", 1200);
    const turnId = `vision-unsupported-${process.pid}`;
    const s = visionStub("application/zip");
    const result = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 77,
      messageId: 78,
      attachmentId: 79,
      dataUrl: "https://203.0.113.31:9/a.zip",
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
      deps: s.deps,
    });
    expect(result).toBeNull();
    expect(s.providerCalls).toEqual([]);
    await settleFlowEvents();
    const rows = await flowLogRows(suDb, {
      where: { turnId },
      select: { stage: true, detail: true },
    });
    expect(rows.map((r) => r.stage)).toEqual(["vision"]);
    expect((rows[0]?.detail as { reason?: string })?.reason).toBe(
      "unsupported_mime",
    );
    await clearFlowLog(suDb, { tenantId });
  });

  // A REFUSAL IS A STATEMENT THAT SPEND WAS WHAT STOOD IN THE WAY, and for a file this provider
  // cannot read there was never any spend to refuse: the same upload in a month with budget to spare
  // returns `unsupported` without touching the provider. Answering 429 sends the operator to look at
  // a budget over a file that would have been rejected either way, and hides the real reason behind
  // one that only appears at the end of the month. The support question is settled first, and only
  // then the money.
  test("an unsupported file over the ceiling is unsupported, not refused", async () => {
    await setCeiling({ enabled: true, monthlyPlaygroundTokens: 1000 });
    await spend("playground", 1200);
    const res = await extractPlaygroundFile({
      ctx,
      agentId,
      file: new ArrayBuffer(8),
      mimeType: "application/zip",
      base: appDb,
    });
    expect(res).toEqual({ kind: "unsupported", text: "" });
    // The positive control, over the SAME blown ceiling: a file this provider can read is refused,
    // so the answer above measures the file type and not a gate that stopped running.
    expect(
      await refusal(() =>
        extractPlaygroundFile({
          ctx,
          agentId,
          file: new ArrayBuffer(8),
          mimeType: "image/png",
          base: appDb,
          deps: {
            fetchImpl: (() => {
              throw new Error(
                "the provider must not be called over the ceiling",
              );
            }) as never,
          },
        }),
      ),
    ).toEqual({ statusCode: 429, key: "errors.spendCeilingReached" });
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
    const s = visionStub();
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
      deps: s.deps,
    });
    expect(result).toBeNull();
    expect(s.providerCalls).toEqual([]);
    // NOTE: the assertion is that a line EXISTS and another does NOT, so the settle is required
    // rather than a poll: polling for the absence would only spend the timeout before answering.
    await settleFlowEvents();
    const rows = await flowLogRows(suDb, {
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

  // THE OTHER HALF OF THAT ASYMMETRY. Silence is right for the refusal, because the `vision` line
  // above already carries it; it is wrong for the WARNING, which leaves no trace anywhere else — the
  // call proceeds, the attachment is read, and nothing says the month crossed its fraction. And the
  // gate that would have said it may never run: vision is upstream of all of them, so a human-owned
  // conversation or an hour outside the schedule consumes the delivery and this billed call is the
  // only thing that happened.
  test("vision past the warning fraction writes the warn line the gate never gets to", async () => {
    await setCeiling({
      enabled: true,
      monthlyInboxTokens: 1000,
      warnAtPercent: 80,
    });
    await spend("inbox", 900);
    const turnId = `vision-warn-${process.pid}`;
    const s = visionStub();
    // Under the ceiling, so the attachment IS read: the warning refuses nothing. The provider seam
    // then fails, which the extraction absorbs (a provider error must not strand the delivery), so
    // the answer is null and the CALL having been attempted is the proof it was let through.
    expect(
      await extractInboundFile({
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
        deps: s.deps,
      }),
    ).toBeNull();
    expect(s.providerCalls.length).toBe(1);
    await settleFlowEvents();
    const rows = await flowLogRows(suDb, {
      where: { turnId, stage: "spend_ceiling" },
      select: { level: true, status: true, detail: true },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.level).toBe("warn");
    expect(rows[0]?.status).toBe("ok");
    expect((rows[0]?.detail as { state?: string })?.state).toBe("warning");
    await clearFlowLog(suDb, { tenantId });
  });

  // THE CONTROL, and what it has to reach moved with the gate. Reaching the DOWNLOAD proves nothing
  // now: the download runs above the ceiling either way, so a test that stopped there would be
  // green with the gate refusing everything. The billed call is the thing the ceiling stands in
  // front of, so that is what a tenant under its ceiling has to get to.
  test("vision under the ceiling is not stopped by the gate", async () => {
    await setCeiling({ enabled: true, monthlyInboxTokens: 1_000_000 });
    await spend("inbox", 10);
    const s = visionStub();
    expect(
      await extractInboundFile({
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
        deps: s.deps,
      }),
    ).toBeNull();
    expect(s.providerCalls.length).toBe(1);
  });
});
