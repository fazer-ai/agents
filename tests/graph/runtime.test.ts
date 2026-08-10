import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { setPublisher, TOPICS } from "@/api/features/realtime/realtime.service";
import { encryptJson } from "@/api/lib/crypto";
import { contactInboxThreadId } from "@/graph/checkpointer";
import type { ResolvedModelConfig } from "@/graph/models";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import { seedChatwootInstance } from "../utils/chatwoot";
import { ResolveThenReplyModel } from "../utils/scripted-models";

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

const REPLY = "Olá! Como posso ajudar?";

// JSON-safe value type for seeding the agent's `settings` (a Prisma Json column).
type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

function fakeModel() {
  return new FakeListChatModel({ responses: [REPLY] });
}

// NOTE: Captures every message list the model is invoked with, so a test can assert what the model
// actually SAW (issue #45: the rendered location marker).
class CaptureReplyModel {
  seen: unknown[][] = [];
  constructor(private reply: string) {}
  async invoke(messages: unknown[]) {
    this.seen.push(messages);
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    return { invoke: (messages: unknown[]) => this.invoke(messages) };
  }
}

function makeStubClient(sent: Array<[number, string]>) {
  const client = {
    sendMessage: async (conversationId: number, content: string) => {
      sent.push([conversationId, content]);
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

// Ordered recorder for sendMessage/toggleStatus. `mirrorOnToggle` simulates the Chatwoot webhook
// mirroring the status change into our Conversation row BEFORE the turn ends (worst case, zero
// lag) — the production race behind the lost-final-reply bug.
function makeResolveClient(
  calls: Array<[string, number, string]>,
  opts: { mirrorOnToggle?: number } = {},
) {
  const client = {
    sendMessage: async (conversationId: number, content: string) => {
      calls.push(["sendMessage", conversationId, content]);
      return {};
    },
    toggleStatus: async (conversationId: number, status: string) => {
      calls.push(["toggleStatus", conversationId, status]);
      if (opts.mirrorOnToggle) {
        await suDb.conversation.updateMany({
          where: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: opts.mirrorOnToggle,
          },
          data: { status },
        });
      }
      return {};
    },
  } as unknown as ChatwootClient;
  return async () => client;
}

const incoming = (
  over: Partial<NormalizedChatwootEvent> = {},
): NormalizedChatwootEvent => ({
  event: "message_created",
  conversationId: 900,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId: null,
  message: { id: 1, content: "oi", messageType: "incoming", private: false },
  ...over,
});

async function seedConversation(convId: number, assigneeType: string | null) {
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
    },
  });
}

describe.skipIf(!dbUp)("runAgentTurn", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "RT", slug: `rt-${process.pid}` },
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
      data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente",
        systemPrompt: "Você é uma secretária prestativa.",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: `vault:${llmKey.id}`,
        },
        // Pin split off so these turn tests assert the plain single-send reply
        // path (split is on by default now and has its own test).
        settings: { split: { enabled: false } },
      },
    });
    await suDb.chatwootAgentBot.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: agent.id,
        chatwootAgentBotId: 9,
        accessToken: encryptJson("BOT"),
        webhookSecret: encryptJson("S"),
        webhookRouteTokenHash: `rt-route-${process.pid}`,
        name: "Atendente",
      },
    });
    await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootInboxId: 7,
        name: "Suporte",
        agentId: agent.id,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "execution_logs",
        "llm_usage",
        "agent_threads",
        "conversations",
        "contacts",
        "inboxes",
        "agents",
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

  test("incoming message → agent replies via the bot token", async () => {
    await seedConversation(900, null);
    const sent: Array<[number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({ conversationId: 900 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStubClient(sent),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("posted");
    expect(sent).toEqual([[900, REPLY]]);
  });

  // NOTE: Issue #45 end-to-end (direct path): a WhatsApp location pin must reach the model as the
  // rendered <localização> marker — before the fix it arrived as an unusable "unsupported file".
  test("a location pin reaches the model as a <localização> marker", async () => {
    await seedConversation(960, null);
    const model = new CaptureReplyModel(REPLY);
    const sent: Array<[number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({
        conversationId: 960,
        message: {
          id: 2,
          content: "",
          messageType: "incoming",
          private: false,
          attachments: [
            {
              id: 5,
              fileType: "location",
              dataUrl: "https://maps.google.com/maps?q=-23.5505,-46.6333",
              latitude: -23.5505,
              longitude: -46.6333,
              fallbackTitle: "Padaria do Zé",
            },
          ],
        },
      }),
      base: appDb,
      deps: {
        makeModel: () => model as never,
        makeClient: makeStubClient(sent),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("posted");
    const first = model.seen[0] ?? [];
    const human = [...first]
      .reverse()
      .find((m) => (m as { getType(): string }).getType() === "human") as
      | { content: unknown }
      | undefined;
    expect(String(human?.content ?? "")).toContain(
      '<localização latitude="-23.5505" longitude="-46.6333" titulo="Padaria do Zé">',
    );
  });

  test("memory is per-contact-inbox: a new conversation reuses the thread with a divider", async () => {
    const contact = await suDb.contact.create({
      data: { tenantId, chatwootContactId: 555, name: "Cliente Fiel" },
      select: { id: true },
    });
    // Both conversations share ONE contact-inbox (same contact, same channel) → one memory thread.
    const contactInboxId = 7001;
    for (const convId of [920, 921]) {
      await suDb.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
          contactInboxId,
          status: "pending",
          contactId: contact.id,
          threadId: `${tenantId}:${instanceId}:${convId}`,
          lastEventAt: new Date(),
        },
      });
    }
    // ONE shared checkpointer across both turns so we can assert the thread is reused per-contact-inbox.
    const saver = new MemorySaver();
    const sent: Array<[number, string]> = [];
    const turn = (conversationId: number) =>
      runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming({ conversationId }),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStubClient(sent),
          checkpointer: saver,
        },
      });
    await turn(920); // first conversation on this contact-inbox → no divider
    await turn(921); // a NEW conversation, same contact-inbox → divider injected

    // The per-THREAD marker (AgentThread, keyed by contact-inbox) advanced to the latest conversation.
    const after = await suDb.agentThread.findUniqueOrThrow({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { lastConversationId: true },
    });
    expect(after.lastConversationId).toBe(921);

    // Both turns share ONE per-contact-inbox thread (continuity); only conv 921's human turn carries
    // the divider so the model treats it as a fresh attendance.
    const cp = await saver.get({
      configurable: {
        thread_id: contactInboxThreadId(tenantId, instanceId, contactInboxId),
      },
    });
    const messages = ((
      cp?.channel_values as { messages?: Array<{ content: unknown }> }
    )?.messages ?? []) as Array<{ content: unknown }>;
    expect(messages.length).toBe(4); // HumanA, AIReplyA, HumanB(+divider), AIReplyB
    expect(String(messages[0]?.content)).not.toContain("nova conversa");
    expect(String(messages[2]?.content)).toContain("nova conversa");
  });

  test("inbox without an Agent → no-agent (silent)", async () => {
    const sent: Array<[number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({ conversationId: 905, inboxId: 8 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStubClient(sent),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("no-agent");
    expect(sent).toEqual([]);
  });

  test("human took over during the LLM call → does not post", async () => {
    await seedConversation(901, "User");
    const sent: Array<[number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({ conversationId: 901 }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStubClient(sent),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("taken-over");
    expect(sent).toEqual([]);
  });

  test("resolve tool defers the status toggle until after the reply is delivered", async () => {
    await seedConversation(910, null);
    const FINAL = "Fechado! Obrigado pelo contato.";
    const calls: Array<[string, number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({ conversationId: 910 }),
      base: appDb,
      deps: {
        makeModel: () =>
          new ResolveThenReplyModel(FINAL) as unknown as BaseChatModel,
        makeClient: makeResolveClient(calls, { mirrorOnToggle: 910 }),
        checkpointer: new MemorySaver(),
      },
    });
    // The final reply must survive the agent's own resolve: post first, resolve after.
    expect(outcome).toBe("posted");
    expect(calls).toEqual([
      ["sendMessage", 910, FINAL],
      ["toggleStatus", 910, "resolved"],
    ]);

    // The deferred resolve is observable in the flow log (handoff stage, outcome "resolved").
    // emitFlowEvent is fire-and-forget, so poll briefly.
    let resolvedLogged = false;
    for (let i = 0; i < 30 && !resolvedLogged; i++) {
      const rows = await suDb.executionLog.findMany({
        where: { tenantId, stage: "handoff" },
        select: { detail: true },
      });
      resolvedLogged = rows.some(
        (r) =>
          (r.detail as Record<string, unknown> | null)?.outcome === "resolved",
      );
      if (!resolvedLogged) await new Promise((r) => setTimeout(r, 100));
    }
    expect(resolvedLogged).toBe(true);
  });

  test("taken over mid-turn discards the resolve intent", async () => {
    await seedConversation(911, "User");
    const calls: Array<[string, number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({ conversationId: 911 }),
      base: appDb,
      deps: {
        makeModel: () =>
          new ResolveThenReplyModel("Resolvido!") as unknown as BaseChatModel,
        makeClient: makeResolveClient(calls),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("taken-over");
    // A human owns the conversation: no reply AND no resolve may reach Chatwoot.
    expect(calls).toEqual([]);
  });

  test("resolve with an empty final reply still resolves after the turn", async () => {
    await seedConversation(912, null);
    const calls: Array<[string, number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({ conversationId: 912 }),
      base: appDb,
      deps: {
        makeModel: () =>
          new ResolveThenReplyModel("") as unknown as BaseChatModel,
        makeClient: makeResolveClient(calls),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("empty");
    expect(calls).toEqual([["toggleStatus", 912, "resolved"]]);
  });

  // The audio-delivery apply point: TTS on (mirror) + the customer sent audio. The stub carries a
  // pre-transcribed voice note so no STT call happens; ttsFetch stubs the synthesis provider.
  const audioIncoming = (convId: number) =>
    incoming({
      conversationId: convId,
      message: {
        id: 1,
        content: "",
        messageType: "incoming",
        private: false,
        attachments: [
          {
            id: 5,
            fileType: "audio",
            dataUrl: "https://chat.example.com/voice.ogg",
            transcribedText: "pode encerrar, obrigado",
          },
        ],
      },
    });

  async function withTtsMirror(fn: () => Promise<void>) {
    const agent = await suDb.agent.findFirstOrThrow({
      where: { tenantId },
      select: { id: true },
    });
    const key = await suDb.vaultEntry.findFirstOrThrow({
      where: { tenantId, name: "llm-key" },
      select: { id: true },
    });
    await suDb.agent.update({
      where: { id: agent.id },
      data: {
        settings: {
          split: { enabled: false },
          tts: {
            mode: "mirror",
            provider: "openai",
            credentialRef: `vault:${key.id}`,
          },
        },
      },
    });
    try {
      await fn();
    } finally {
      await suDb.agent.update({
        where: { id: agent.id },
        data: { settings: { split: { enabled: false } } },
      });
    }
  }

  function audioClient(calls: Array<[string, number]>) {
    return async () =>
      ({
        sendMessage: async (c: number) => {
          calls.push(["sendMessage", c]);
          return {};
        },
        sendAudioMessage: async (c: number) => {
          calls.push(["sendAudioMessage", c]);
          return {};
        },
        toggleStatus: async (c: number) => {
          calls.push(["toggleStatus", c]);
          return {};
        },
      }) as unknown as ChatwootClient;
  }

  test("deferred resolve applies after the audio reply is delivered", async () => {
    await withTtsMirror(async () => {
      await seedConversation(913, null);
      const calls: Array<[string, number]> = [];
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: audioIncoming(913),
        base: appDb,
        deps: {
          makeModel: () =>
            new ResolveThenReplyModel("Fechado!") as unknown as BaseChatModel,
          makeClient: audioClient(calls),
          checkpointer: new MemorySaver(),
          ttsFetch: (async () =>
            new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "Content-Type": "audio/mpeg" },
            })) as unknown as typeof fetch,
        },
      });
      expect(outcome).toBe("posted");
      expect(calls).toEqual([
        ["sendAudioMessage", 913],
        ["toggleStatus", 913],
      ]);
    });
  });

  test("TTS failure falls back to text and still applies the deferred resolve", async () => {
    await withTtsMirror(async () => {
      await seedConversation(914, null);
      const calls: Array<[string, number]> = [];
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: audioIncoming(914),
        base: appDb,
        deps: {
          makeModel: () =>
            new ResolveThenReplyModel("Fechado!") as unknown as BaseChatModel,
          makeClient: audioClient(calls),
          checkpointer: new MemorySaver(),
          ttsFetch: (async () =>
            new Response("boom", { status: 500 })) as unknown as typeof fetch,
        },
      });
      // Audio is best-effort: synthesis failure downgrades to text, never drops the reply — and
      // the deferred resolve still lands after the delivered (text) reply.
      expect(outcome).toBe("posted");
      expect(calls).toEqual([
        ["sendMessage", 914],
        ["toggleStatus", 914],
      ]);
    });
  });

  test("emits agent-activity (started + finished) on the tenant topic during a turn", async () => {
    await seedConversation(906, null);
    const published: Array<{ topic: string; data: string }> = [];
    setPublisher((topic, data) => {
      published.push({ topic, data });
    });
    try {
      const sent: Array<[number, string]> = [];
      const outcome = await runAgentTurn({
        tenantId,
        instanceId,
        agentBotId: 9,
        event: incoming({ conversationId: 906 }),
        base: appDb,
        deps: {
          makeModel: fakeModel,
          makeClient: makeStubClient(sent),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");

      const activity = published
        .map((p) => ({
          topic: p.topic,
          event: JSON.parse(p.data) as { type: string; phase: string },
        }))
        .filter((p) => p.event.type === "agent-activity");
      const phases = activity.map((p) => p.event.phase);
      expect(phases).toContain("started");
      expect(phases).toContain("finished");
      for (const a of activity) {
        expect(a.topic).toBe(TOPICS.tenant(tenantId));
      }
    } finally {
      // Reset so this publisher cannot leak into other suites in the process.
      setPublisher(() => undefined);
    }
  });

  test("non-incoming (outgoing) message is skipped before any LLM call", async () => {
    const sent: Array<[number, string]> = [];
    const outcome = await runAgentTurn({
      tenantId,
      instanceId,
      agentBotId: 9,
      event: incoming({
        conversationId: 902,
        message: {
          id: 2,
          content: "x",
          messageType: "outgoing",
          private: false,
        },
      }),
      base: appDb,
      deps: {
        makeModel: fakeModel,
        makeClient: makeStubClient(sent),
        checkpointer: new MemorySaver(),
      },
    });
    expect(outcome).toBe("skipped");
    expect(sent).toEqual([]);
  });

  // The "generated" guardrail action: instead of a fixed template, the guardrails agent proposes a
  // safe replacement reply (`suggestedReply`). These tests deterministically exercise the runtime
  // WIRING of that action with a fake guardrails model — input delivers the suggestion and skips the
  // agent graph, output substitutes the reply, and a null suggestion falls back to the template. The
  // real-model steering of `generationPrompt` is a separate live check.
  describe("guardrails 'generated' action", () => {
    const GUARD_MODEL = "guard-sentinel";
    const G_BOT = 91;
    const G_INBOX = 71;
    let gTenantId = 0n;
    let gInstanceId = 0n;
    let gAgentId = 0n;
    let gVaultRef = "";

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "GRT", slug: `grt-${process.pid}` },
      });
      gTenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId: gTenantId,
        accountId: 91,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      gInstanceId = inst.id;
      const key = await suDb.vaultEntry.create({
        data: {
          tenantId: gTenantId,
          name: "guard-key",
          secret: encryptJson("sk-guard"),
        },
        select: { id: true },
      });
      gVaultRef = `vault:${key.id}`;
      const agent = await suDb.agent.create({
        data: {
          tenantId: gTenantId,
          name: "Guardada",
          systemPrompt: "Você é uma secretária prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: gVaultRef,
          },
          settings: { split: { enabled: false } },
        },
        select: { id: true },
      });
      gAgentId = agent.id;
      await suDb.chatwootAgentBot.create({
        data: {
          tenantId: gTenantId,
          chatwootInstanceId: gInstanceId,
          agentId: agent.id,
          chatwootAgentBotId: G_BOT,
          accessToken: encryptJson("BOT"),
          webhookSecret: encryptJson("S"),
          webhookRouteTokenHash: `rt-guard-${process.pid}`,
          name: "Guardada",
        },
      });
      await suDb.inbox.create({
        data: {
          tenantId: gTenantId,
          chatwootInstanceId: gInstanceId,
          chatwootInboxId: G_INBOX,
          name: "Guarda",
          agentId: agent.id,
        },
      });
    });

    afterAll(async () => {
      if (!gTenantId) return;
      for (const table of [
        "execution_logs",
        "llm_usage",
        "agent_threads",
        "conversations",
        "contacts",
        "inboxes",
        "chatwoot_agent_bots",
        "agents",
        "vault_entries",
        "chatwoot_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${gTenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${gTenantId}`,
      );
    });

    // A makeModel that returns the guardrails verdict for the guardrails model (matched by its
    // sentinel model name) and the normal agent reply for the main model.
    const branchingModel =
      (verdictJson: string) =>
      (cfg: ResolvedModelConfig): BaseChatModel =>
        cfg.model === GUARD_MODEL
          ? ({
              invoke: async () => ({ content: verdictJson }),
            } as unknown as BaseChatModel)
          : new FakeListChatModel({ responses: [REPLY] });

    const guardStub =
      (
        sent: Array<[number, string]>,
        notes: Array<[number, string]>,
        toggles: Array<[number, string]> = [],
      ) =>
      async () =>
        ({
          sendMessage: async (c: number, content: string) => {
            sent.push([c, content]);
            return {};
          },
          sendPrivateNote: async (c: number, content: string) => {
            notes.push([c, content]);
            return {};
          },
          toggleStatus: async (c: number, status: string) => {
            toggles.push([c, status]);
            return {};
          },
          toggleTyping: async () => ({}),
        }) as unknown as ChatwootClient;

    const setGuardrails = (g: { [k: string]: JsonValue }) =>
      suDb.agent.update({
        where: { id: gAgentId },
        data: { settings: { split: { enabled: false }, guardrails: g } },
      });

    const seedConv = (convId: number) =>
      suDb.conversation.create({
        data: {
          tenantId: gTenantId,
          chatwootInstanceId: gInstanceId,
          chatwootConversationId: convId,
          status: "pending",
          assigneeType: null,
          threadId: `${gTenantId}:${gInstanceId}:${convId}`,
          lastEventAt: new Date(),
        },
      });

    test("input 'generated' → delivers the suggestedReply and skips the agent graph", async () => {
      await setGuardrails({
        enabled: true,
        provider: "openai",
        model: GUARD_MODEL,
        credentialRef: gVaultRef,
        input: {
          enabled: true,
          action: "generated",
          checks: {
            toxicity: true,
            unsafeContent: false,
            competitorMentions: false,
            promptAdherence: false,
          },
          templateMessage: "TEMPLATE-IN",
        },
        output: { enabled: false },
      });
      await seedConv(940);
      const sent: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const verdict = JSON.stringify({
        violated: true,
        categories: ["toxicity"],
        rationale: "abuse",
        suggestedReply: "GEN-IN-REPLY",
      });
      const outcome = await runAgentTurn({
        tenantId: gTenantId,
        instanceId: gInstanceId,
        agentBotId: G_BOT,
        event: incoming({ conversationId: 940, inboxId: G_INBOX }),
        base: appDb,
        deps: {
          makeModel: branchingModel(verdict),
          makeClient: guardStub(sent, notes),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");
      // The generated suggestedReply is delivered — NOT the template, NOT the agent's own REPLY.
      expect(sent).toEqual([[940, "GEN-IN-REPLY"]]);
      // The operator is notified via a private note so a replaced reply is never invisible.
      expect(notes.length).toBe(1);
    });

    test("output 'generated' → replaces the agent reply with the suggestedReply", async () => {
      await setGuardrails({
        enabled: true,
        provider: "openai",
        model: GUARD_MODEL,
        credentialRef: gVaultRef,
        input: { enabled: false },
        output: {
          enabled: true,
          action: "generated",
          checks: {
            toxicity: false,
            unsafeContent: false,
            competitorMentions: false,
            promptAdherence: true,
          },
          templateMessage: "TEMPLATE-OUT",
        },
      });
      await seedConv(941);
      const sent: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const verdict = JSON.stringify({
        violated: true,
        categories: ["prompt_adherence"],
        rationale: "off-scope",
        suggestedReply: "GEN-OUT-REPLY",
      });
      const outcome = await runAgentTurn({
        tenantId: gTenantId,
        instanceId: gInstanceId,
        agentBotId: G_BOT,
        event: incoming({ conversationId: 941, inboxId: G_INBOX }),
        base: appDb,
        deps: {
          makeModel: branchingModel(verdict),
          makeClient: guardStub(sent, notes),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");
      // The agent produced REPLY; the output guardrail replaced it with the generated safe reply.
      expect(sent).toEqual([[941, "GEN-OUT-REPLY"]]);
      expect(notes.length).toBe(1);
    });

    test("output 'generated' with no suggestedReply → falls back to the template", async () => {
      await setGuardrails({
        enabled: true,
        provider: "openai",
        model: GUARD_MODEL,
        credentialRef: gVaultRef,
        input: { enabled: false },
        output: {
          enabled: true,
          action: "generated",
          checks: {
            toxicity: false,
            unsafeContent: false,
            competitorMentions: false,
            promptAdherence: true,
          },
          templateMessage: "TEMPLATE-OUT",
        },
      });
      await seedConv(942);
      const sent: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const verdict = JSON.stringify({
        violated: true,
        categories: ["prompt_adherence"],
        rationale: "off-scope",
        suggestedReply: null,
      });
      const outcome = await runAgentTurn({
        tenantId: gTenantId,
        instanceId: gInstanceId,
        agentBotId: G_BOT,
        event: incoming({ conversationId: 942, inboxId: G_INBOX }),
        base: appDb,
        deps: {
          makeModel: branchingModel(verdict),
          makeClient: guardStub(sent, notes),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("posted");
      // suggestedReply was null → the runtime falls back to the configured templateMessage.
      expect(sent).toEqual([[942, "TEMPLATE-OUT"]]);
      expect(notes.length).toBe(1);
    });

    test("output 'silent' discards the resolve intent (no toggle, no reply)", async () => {
      await setGuardrails({
        enabled: true,
        provider: "openai",
        model: GUARD_MODEL,
        credentialRef: gVaultRef,
        input: { enabled: false },
        output: {
          enabled: true,
          action: "silent",
          checks: {
            toxicity: false,
            unsafeContent: false,
            competitorMentions: false,
            promptAdherence: true,
          },
        },
      });
      await seedConv(943);
      const sent: Array<[number, string]> = [];
      const notes: Array<[number, string]> = [];
      const toggles: Array<[number, string]> = [];
      const verdict = JSON.stringify({
        violated: true,
        categories: ["prompt_adherence"],
        rationale: "off-scope",
        suggestedReply: null,
      });
      // Agent branch resolves + replies; the output guardrail suppresses the reply. Resolving a
      // conversation whose goodbye was suppressed would strand the customer, so the intent is
      // discarded along with the reply.
      const branchingResolveModel = (
        cfg: ResolvedModelConfig,
      ): BaseChatModel =>
        cfg.model === GUARD_MODEL
          ? ({
              invoke: async () => ({ content: verdict }),
            } as unknown as BaseChatModel)
          : (new ResolveThenReplyModel(
              "Fechado, obrigado!",
            ) as unknown as BaseChatModel);
      const outcome = await runAgentTurn({
        tenantId: gTenantId,
        instanceId: gInstanceId,
        agentBotId: G_BOT,
        event: incoming({ conversationId: 943, inboxId: G_INBOX }),
        base: appDb,
        deps: {
          makeModel: branchingResolveModel,
          makeClient: guardStub(sent, notes, toggles),
          checkpointer: new MemorySaver(),
        },
      });
      expect(outcome).toBe("blocked");
      expect(sent).toEqual([]);
      expect(toggles).toEqual([]);
    });
  });
});
