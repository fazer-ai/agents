import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runAgentTurn } from "@/graph/runtime";
import { NON_AGENT_TURN_NODES, USAGE_NODE_IS_AGENT_TURN } from "@/graph/usage";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { getVisionProvider } from "@/modules/vision/providers";
import { extractInboundFile } from "@/modules/vision/service";
import { readVisionConfig } from "@/modules/vision/settings";
import { seedChatwootInstance } from "../utils/chatwoot";
import { UsageReportingModel } from "../utils/scripted-models";

// `LlmUsage` is the only ledger of what an install spends on models, and a call reaches it only by
// carrying the turn's usage callback. Two billed calls never did (issue #316): the guardrail
// analysis, which invokes without callbacks, and vision, whose provider contract returned a bare
// string and so could not carry the token counts the provider had already sent back.
//
// Every test here reads the row an operator would read, through the real call path. What is being
// proved is not that a function returns a number: it is that the money spent leaves a trace.

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
let instanceId = 0n;
let contactId = 0n;
let agentId = 0n;
let inboxDbId = 0n;

// The guardrail runs on a model of its OWN, named differently from the agent's on purpose: the row
// it writes has to be attributed to the model that was actually billed, and a shared name would let
// a wrong attribution pass.
const AGENT_MODEL = "gpt-4o-mini";
const GUARDRAIL_MODEL = "guard-mini";
const VISION_MODEL = "vision-mini";
const CLEAN_VERDICT = JSON.stringify({
  violated: false,
  categories: [],
  rationale: "",
  suggestedReply: null,
});

function makeStub(rec: { text: string[] }) {
  const client = {
    sendMessage: async (_c: number, content: string) => {
      rec.text.push(content);
      return {};
    },
    downloadAttachment: async () => ({
      bytes: new ArrayBuffer(8),
      contentType: "image/png",
    }),
    updateAttachmentMeta: async () => ({}),
  } as unknown as ChatwootClient;
  return async () => client;
}

const textEvent = (convId: number): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: convId,
  contactInboxId: null,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  message: {
    id: 1,
    content: "quero agendar",
    messageType: "incoming",
    private: false,
    attachments: [],
  },
});

async function seedConversation(convId: number) {
  const c = await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      contactId,
      // `loadAgentConfig` reads inboxDbId off the CONVERSATION's relation, not off the event, so a
      // conversation seeded without it produces null-inbox rows for every node and would let a
      // wrong attribution pass unnoticed.
      inboxId: inboxDbId,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
    select: { id: true },
  });
  return c.id;
}

function usageRows(threadId: string) {
  return suDb.llmUsage.findMany({
    where: { tenantId, threadId },
    select: {
      node: true,
      model: true,
      promptTokens: true,
      completionTokens: true,
      source: true,
      cachedReadTokens: true,
      conversationId: true,
      agentId: true,
      inboxId: true,
    },
    orderBy: { id: "asc" },
  });
}

describe.skipIf(!dbUp)("billed model calls reach the usage ledger", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "USAGECOV", slug: `usagecov-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId,
      accountId: 9,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("ADMIN"),
    });
    instanceId = inst.id;
    const llmKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-llm") },
      select: { id: true },
    });
    const guardKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "guard-key", secret: encryptJson("sk-guard") },
      select: { id: true },
    });
    const visionKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "vision-key", secret: encryptJson("sk-vision") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é prestativa.",
        modelConfig: {
          provider: "openai",
          model: AGENT_MODEL,
          credentialRef: `vault:${llmKey.id}`,
        },
        settings: {
          split: { enabled: false },
          // openai-compatible asks for the verdict in prose (verdictAskMode), which is the plain
          // `model.invoke` path — the one that was missing its callbacks.
          guardrails: {
            enabled: true,
            provider: "openai-compatible",
            model: GUARDRAIL_MODEL,
            credentialRef: `vault:${guardKey.id}`,
            input: { enabled: true, action: "block" },
            output: { enabled: false },
          },
          vision: {
            enabled: true,
            provider: "openai",
            model: VISION_MODEL,
            credentialRef: `vault:${visionKey.id}`,
          },
        },
      },
      select: { id: true },
    });
    agentId = agent.id;
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `usagecov-route-${process.pid}`,
        name: "Atendente",
      },
    });
    const inbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
      select: { id: true },
    });
    inboxDbId = inbox.id;
    const contact = await suDb.contact.create({
      data: {
        chatwootInstanceId: instanceId,
        tenantId,
        name: "Cliente",
        chatwootContactId: 1,
      },
    });
    contactId = contact.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "conversations",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "contacts",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("a screened turn bills the guardrail as its own row, on its own model", async () => {
    await seedConversation(9301);
    const rec = { text: [] as string[] };
    // One factory, two models, told apart by the name the caller asked for — the same way the
    // runtime tells them apart, and the only way a wrong attribution would be visible here.
    const agentModel = new UsageReportingModel(["Claro, posso agendar."]);
    const guardModel = new UsageReportingModel([CLEAN_VERDICT], {
      input: 31,
      output: 5,
    });
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: textEvent(9301),
      base: appDb,
      deps: {
        makeModel: ((args: { model: string }) =>
          args.model === GUARDRAIL_MODEL
            ? guardModel
            : agentModel) as unknown as never,
        makeClient: makeStub(rec),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("posted");
    // The guardrail ran: without this the row's absence would prove nothing.
    expect(guardModel.calls.length).toBeGreaterThan(0);

    const usage = await usageRows(`${tenantId}:${instanceId}:9301`);
    expect(usage.map((u) => u.node).sort()).toEqual(["agent", "guardrail"]);
    const guard = usage.find((u) => u.node === "guardrail");
    expect(guard?.model).toBe(GUARDRAIL_MODEL);
    expect(guard?.promptTokens).toBe(31);
    expect(guard?.completionTokens).toBe(5);
    expect(guard?.source).toBe("inbox");
    // Attribution, not just presence: a row nobody can trace to a conversation is a row the
    // dashboard and any ceiling can only sum blindly.
    expect(guard?.agentId).toBe(agentId);
    expect(guard?.inboxId).toBe(inboxDbId);
  });

  test("an injected sink receives the guardrail row too, and the database receives neither", async () => {
    await seedConversation(9303);
    const threadId = `${tenantId}:${instanceId}:9303`;
    // The seam exists so a test can capture rows without a database. It only tells the truth if it
    // covers every billed call in the turn: a sink that catches the agent's row and lets the
    // guardrail's fall through to the real table is worse than no sink, because the capture looks
    // complete.
    const captured: { node: string | null; model: string }[] = [];
    const agentModel = new UsageReportingModel(["Claro, posso agendar."]);
    const guardModel = new UsageReportingModel([CLEAN_VERDICT]);
    await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: { ...textEvent(9303), conversationId: 9303 },
      base: appDb,
      deps: {
        makeModel: ((args: { model: string }) =>
          args.model === GUARDRAIL_MODEL
            ? guardModel
            : agentModel) as unknown as never,
        makeClient: makeStub({ text: [] }),
        checkpointer: new MemorySaver(),
        persistUsage: async (row) => {
          captured.push({ node: row.node, model: row.model });
        },
      },
    });
    expect(captured.map((r) => r.node).sort()).toEqual(["agent", "guardrail"]);
    expect(captured.find((r) => r.node === "guardrail")?.model).toBe(
      GUARDRAIL_MODEL,
    );
    // Nothing leaked past the sink.
    expect(await usageRows(threadId)).toEqual([]);
  });

  test("an extracted image bills vision with the counts the provider returned", async () => {
    const convDbId = await seedConversation(9302);
    const threadId = `${tenantId}:${instanceId}:9302`;
    // The provider answers the real shape: text AND the usage block every one of the three vision
    // branches receives today and discards.
    const visionFetch = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "uma nota fiscal" } }],
          usage: {
            prompt_tokens: 813,
            completion_tokens: 24,
            prompt_tokens_details: { cached_tokens: 512 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;

    const agentRow = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { settings: true },
    });
    const cfg = readVisionConfig(agentRow.settings);
    const out = await extractInboundFile({
      tenantId,
      instanceId,
      conversationId: 9302,
      messageId: 1,
      attachmentId: 5,
      dataUrl: "https://x/nota.png",
      cfg: cfg as NonNullable<typeof cfg>,
      base: appDb,
      deps: { makeClient: makeStub({ text: [] }), fetchImpl: visionFetch },
      flow: {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: convDbId,
        agentId,
        inboxId: inboxDbId,
        threadId,
        base: appDb,
      },
    });
    expect(out?.text).toBe("uma nota fiscal");

    const usage = await usageRows(threadId);
    expect(usage.map((u) => u.node)).toEqual(["vision"]);
    expect(usage[0]?.model).toBe(VISION_MODEL);
    // The provider's own numbers, not an estimate: the whole point is that they were on the wire
    // already.
    expect(usage[0]?.promptTokens).toBe(813);
    expect(usage[0]?.completionTokens).toBe(24);
    // The discounted subset reaches the row too. The type could not catch this one: the cache
    // counters are optional on `recordDirectUsage`, so a call site that forwarded only the pair
    // still compiled.
    expect(usage[0]?.cachedReadTokens).toBe(512);
    expect(usage[0]?.conversationId).toBe(convDbId);
    expect(usage[0]?.agentId).toBe(agentId);
  });
});

// The fence. Fixing the two offenders above closes today's hole; this is what stops the next call
// site from being born with it, and it is why this issue was one issue rather than two reports.
//
// The predicate is the offender's GRAMMAR, not its intention: an option bag handed to a model
// invocation that names `signal` and not `callbacks`. Both guardrail sites read exactly that way,
// and both sites that had already been fixed by hand (`tts/normalize.ts`, `memory/summarize.ts`)
// carry `callbacks` right beside `signal`.
//
// Measured against the tree with the guardrail fix reverted, the sweep reports both sites; against
// the tree as it stands, none.
const INVOKE_OPTIONS = /\.invoke\([\s\S]{0,400}?\{([^{}]*signal:[^{}]*)\}/g;

function sinkless(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(INVOKE_OPTIONS)) {
    if (!m[1]?.includes("callbacks")) out.push(m[1] ?? "");
  }
  return out;
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const glob = new Bun.Glob("**/*.ts");
  const out: string[] = [];
  for await (const f of glob.scan({ cwd: dir, absolute: true })) out.push(f);
  return out;
}

describe("every model invocation carries a usage sink", () => {
  // A sweep that finds nothing passes whether the rule holds or the predicate is broken. This is
  // what tells the two apart, and it is the shape the real offender had.
  test("the predicate recognises an invocation with no sink", () => {
    const offender = `
      const res = await model.invoke(messages, {
        signal: AbortSignal.timeout(15_000),
      });`;
    const fixed = `
      const res = await model.invoke(messages, {
        signal: AbortSignal.timeout(15_000),
        callbacks,
      });`;
    expect(sinkless(offender).length).toBe(1);
    expect(sinkless(fixed).length).toBe(0);
  });

  test("no billed call in src/ invokes a model without one", async () => {
    const offenders: string[] = [];
    for (const file of await tsFilesUnder(
      new URL("../../src", import.meta.url).pathname,
    )) {
      const found = sinkless(await Bun.file(file).text());
      for (const f of found) {
        offenders.push(`${file.split("/src/")[1]}: ${f.trim().slice(0, 60)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// A second sweep, over the other half of the same defect. Completing the ledger did not only add
// rows: it added a KIND of row, and `getKpis` was reading "this conversation has a billed call" as
// "the agent took this conversation". That held only while the calls the agent did not make had no
// row. Vision is the first node that bills before the bot-ownership gate, and it will not be the
// last, so the classification is total and this is what keeps it total.
//
// The predicate is the writer's grammar: a `node:` key resolving to a string literal, inside a file
// that builds a ledger sink. Scoping it to sink files is what keeps unrelated `node:` keys (an n8n
// workflow graph names its steps that way) out of the vocabulary.
const SINK_FILE = /new UsageCapture\(|recordDirectUsage\(|buildCallbacks\(/;
const NODE_LITERAL = /\bnode:\s*[^,\n}]*?"([a-z_]+)"/g;

function nodesWritten(source: string): string[] {
  if (!SINK_FILE.test(source)) return [];
  return [...source.matchAll(NODE_LITERAL)].map((m) => m[1] as string);
}

describe("every node the ledger writes is classified for the involvement KPI", () => {
  // Without this, a sweep that classifies nothing passes exactly like one that classifies
  // everything. The fixture is the shape the next offender has: a new billed call, a new label.
  test("the predicate finds a node a sink file writes, and ignores one it does not", () => {
    const sink = `
      await recordDirectUsage(params.flow, {
        model: cfg.model,
        node: "brand_new_node",
      });`;
    const notASink = `
      const wf = { main: [[{ node: "HTTP Request", type: "main", index: 0 }]] };`;
    expect(nodesWritten(sink)).toEqual(["brand_new_node"]);
    expect(nodesWritten(notASink)).toEqual([]);
    expect(USAGE_NODE_IS_AGENT_TURN.brand_new_node).toBeUndefined();
  });

  test("no node reaches a row without an answer to 'did the agent run'", async () => {
    const found = new Set<string>();
    for (const file of await tsFilesUnder(
      new URL("../../src", import.meta.url).pathname,
    )) {
      for (const node of nodesWritten(await Bun.file(file).text())) {
        found.add(node);
      }
    }
    // Both directions. A node written but unclassified is the hole vision just opened; a node
    // classified but no longer written is a rule about code that is gone, and the map is what a
    // reader trusts to be the whole vocabulary.
    expect([...found].sort()).toEqual(
      Object.keys(USAGE_NODE_IS_AGENT_TURN).sort(),
    );
    // The claim the KPI actually rests on, spelled out where it can go red.
    expect([...NON_AGENT_TURN_NODES].sort()).toEqual(["vision"]);
  });
});

// The three vision branches parse three different usage shapes, and "carried the pair" is not the
// same as "carried what was billed". Two of the counters are the ones a first pass drops: a cached
// prompt is charged at a discount, and Gemini bills thinking as output that its candidates count
// does NOT include (the API reference defines totalTokenCount as prompt + thoughts + candidates).
//
// A table rather than three tests: what is being pinned is one rule read three ways, and the shape
// that hides a mistake is one provider quietly disagreeing with the others.
const fetchReturning = (body: unknown) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

const USAGE_SHAPES = [
  {
    name: "openai-compatible: cached prompt is a discounted subset",
    provider: "openai",
    body: {
      choices: [{ message: { content: "ok" } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 40 },
        // Reasoning is counted INSIDE completion_tokens by OpenAI, so reading it would bill the
        // same tokens twice. The expectation below is what pins that it is left alone.
        completion_tokens_details: { reasoning_tokens: 6 },
      },
    },
    want: {
      promptTokens: 100,
      completionTokens: 10,
      cachedReadTokens: 40,
      cacheCreationTokens: 0,
    },
  },
  {
    name: "gemini: thinking tokens are billed output on top of candidates",
    provider: "gemini",
    body: {
      candidates: [{ content: { parts: [{ text: "ok" }] } }],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 10,
        thoughtsTokenCount: 55,
        cachedContentTokenCount: 40,
      },
    },
    want: {
      promptTokens: 100,
      completionTokens: 65,
      cachedReadTokens: 40,
      cacheCreationTokens: 0,
    },
  },
  {
    // Anthropic is the ODD ONE, and reading it like the other two undercounts every cached call:
    // `input_tokens` is "the number of input tokens which were not read from or used to create a
    // cache", so the doc's own formula is
    // total_input = cache_read + cache_creation + input_tokens. On OpenAI and Gemini the cached
    // count is a subset of a prompt total that already contains it.
    name: "anthropic: the cache counters are ADDITIVE to input_tokens, not a subset",
    provider: "anthropic",
    body: {
      content: [{ type: "text", text: "ok" }],
      usage: {
        input_tokens: 100,
        output_tokens: 10,
        cache_read_input_tokens: 40,
        cache_creation_input_tokens: 7,
      },
    },
    want: {
      // 100 uncached + 40 read from cache + 7 written to cache.
      promptTokens: 147,
      completionTokens: 10,
      cachedReadTokens: 40,
      cacheCreationTokens: 7,
    },
  },
] as const;

describe("a vision provider carries every count it was billed for", () => {
  for (const c of USAGE_SHAPES) {
    test(c.name, async () => {
      const out = await getVisionProvider(c.provider)?.extract({
        bytes: new ArrayBuffer(4),
        mimeType: "image/png",
        kind: "image",
        prompt: "Descreva.",
        model: "m",
        apiKey: "k",
        baseURL: null,
        fetchImpl: fetchReturning(c.body),
        timeoutMs: 5_000,
      });
      expect(out?.text).toBe("ok");
      expect(out?.usage).toEqual(c.want);
    });
  }

  // An endpoint that sent no counts must not be recorded as a free call: null is what keeps
  // `recordDirectUsage` from writing a row that says this one cost nothing.
  test("a response with no usage block reports null, never zeros", async () => {
    const out = await getVisionProvider("openai")?.extract({
      bytes: new ArrayBuffer(4),
      mimeType: "image/png",
      kind: "image",
      prompt: "Descreva.",
      model: "m",
      apiKey: "k",
      baseURL: null,
      fetchImpl: fetchReturning({ choices: [{ message: { content: "ok" } }] }),
      timeoutMs: 5_000,
    });
    expect(out?.usage).toBeNull();
  });
});
