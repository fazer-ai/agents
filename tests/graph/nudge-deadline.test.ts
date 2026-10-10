import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import * as graphModule from "@/graph/graph";
import { type NudgePostActions, runAgentNudge } from "@/graph/nudge";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { seedChatwootInstance } from "../utils/chatwoot";
import { HandoffThenReplyModel } from "../utils/scripted-models";

// The nudge's half of a job's deadline: the FOLLOWUP handler hands its job's signal to
// the nudge, the invoke is aborted by it, and every write after it is refused through `stillWanted`,
// so a follow-up whose run was already failed at its deadline never sends the step its retry owns.

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
let agentId = 0n;

// A model that answers after `delayMs`, honoring the signal it is handed; `saw` records the abort,
// and `answered` flips when it returns. `onCall` runs once the call is listening for the abort.
function slowModel(
  delayMs: number,
  saw: { abort: boolean; answered: boolean },
  onCall: () => void = () => {},
) {
  const model = {
    bindTools() {
      return model;
    },
    async invoke(_messages: BaseMessage[], opts?: { signal?: AbortSignal }) {
      const signal = opts?.signal;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delayMs);
        signal?.addEventListener("abort", () => {
          saw.abort = true;
          clearTimeout(timer);
          reject(signal.reason);
        });
        onCall();
      });
      saw.answered = true;
      return new AIMessage("Oi! Ainda posso ajudar com alguma coisa?");
    },
  };
  return model as unknown as BaseChatModel;
}

// `onSend` runs inside every send (message, note or template), `onLabels` inside the labels read, `onSetLabels` inside their write.
// A model that answers with nothing: the nudge stays silent.
function silentModel() {
  const model = {
    bindTools() {
      return model;
    },
    async invoke() {
      return new AIMessage("");
    },
  };
  return model as unknown as BaseChatModel;
}

function stub(
  onSend: () => void = () => {},
  onLabels: () => void = () => {},
  onSetLabels: () => void = () => {},
  onToggle: (status: string) => void = () => {},
) {
  const messages: Array<[number, string]> = [];
  const notes: Array<[number, string]> = [];
  const statuses: string[] = [];
  const labels: string[][] = [];
  const templates: Array<[number, string]> = [];
  const client = {
    sendMessage: async (c: number, t: string) => {
      messages.push([c, t]);
      onSend();
      return {};
    },
    sendPrivateNote: async (c: number, t: string) => {
      notes.push([c, t]);
      onSend();
      return {};
    },
    getConversationLabels: async () => {
      onLabels();
      return [];
    },
    setConversationLabels: async (_c: number, l: string[]) => {
      labels.push(l);
      onSetLabels();
      return {};
    },
    toggleStatus: async (_c: number, status: string) => {
      statuses.push(status);
      onToggle(status);
      return {};
    },
    toggleTyping: async () => ({}),
    getMessages: async () => ({ payload: [] }),
    sendTemplate: async (c: number, payload: { name: string }) => {
      templates.push([c, payload.name]);
      onSend();
      return {};
    },
  } as unknown as ChatwootClient;
  return {
    messages,
    notes,
    templates,
    statuses,
    labels,
    makeClient: async () => client,
  };
}

async function seedConversation(
  convId: number,
  chatwootInboxId: number,
  { lastInboundAt = new Date() } = {},
) {
  const inbox = await suDb.inbox.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      chatwootInboxId,
      name: `Inbox ${chatwootInboxId}`,
      agentId,
      channelType: "Channel::Whatsapp",
      provider: "whatsapp_cloud",
    },
  });
  await suDb.conversation.create({
    data: {
      tenantId,
      chatwootInstanceId: instanceId,
      inboxId: inbox.id,
      chatwootConversationId: convId,
      status: "pending",
      assigneeType: null,
      threadId: `${tenantId}:${instanceId}:${convId}`,
      lastEventAt: new Date(),
      lastInboundAt,
    },
  });
}

describe.skipIf(!dbUp)(
  "a follow-up nudge stops when its job's deadline fires (issue #811)",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "NDL", slug: `ndl-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await seedChatwootInstance(suDb, {
        tenantId,
        accountId: 12,
        baseUrl: "https://chat.example.com",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const vault = await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      });
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente",
          systemPrompt: "Você é prestativa.",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: `vault:${vault.id}`,
          },
        },
      });
      agentId = agent.id;
      await seedConversation(950, 81);
      await seedConversation(951, 82);
      await seedConversation(952, 83);
      await seedConversation(953, 84);
      await seedConversation(954, 85);
      await seedConversation(955, 86);
      await seedConversation(956, 87);
      await seedConversation(957, 88);
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "llm_usage",
          "execution_logs",
          "scheduler_jobs",
          "agent_threads",
          "conversations",
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

    const nudge = (
      convId: number,
      model: BaseChatModel,
      signal: AbortSignal,
      stillWanted?: () => Promise<boolean>,
      extra: {
        postActions?: NudgePostActions;
        onSend?: () => void;
        onLabels?: () => void;
        onSetLabels?: () => void;
        onToggle?: (status: string) => void;
      } = {},
    ) => {
      const s = stub(
        extra.onSend,
        extra.onLabels,
        extra.onSetLabels,
        extra.onToggle,
      );
      return {
        s,
        run: () =>
          runAgentNudge({
            signal,
            tenantId,
            threadId: `${tenantId}:${instanceId}:${convId}`,
            nudge: { source: "followup", kind: "inactivity", step: 1 },
            base: appDb,
            ...(stillWanted ? { stillWanted } : {}),
            ...(extra.postActions ? { postActions: extra.postActions } : {}),
            deps: {
              makeModel: () => model,
              makeClient: s.makeClient,
              checkpointer: new MemorySaver(),
              persistUsage: async () => {},
            },
          }).catch(() => "threw"),
      };
    };

    test("the deadline reaches the nudge's model call, and nothing is sent", async () => {
      const saw = { abort: false, answered: false };
      const controller = new AbortController();
      // The deadline fires while the model call is in flight, whatever the setup before it cost.
      const { s, run } = nudge(
        950,
        slowModel(5_000, saw, () =>
          controller.abort(new Error("deadline exceeded")),
        ),
        controller.signal,
      );
      const t = performance.now();
      await run();
      expect(saw.abort).toBe(true);
      expect(performance.now() - t).toBeLessThan(4_000);
      expect(s.messages).toEqual([]);
      expect(s.notes).toEqual([]);
    });

    test("a deadline that fires after the model answered, before the send, sends nothing", async () => {
      const saw = { abort: false, answered: false };
      const controller = new AbortController();
      const { s, run } = nudge(
        951,
        slowModel(20, saw),
        controller.signal,
        async () => {
          if (saw.answered) controller.abort(new Error("deadline exceeded"));
          return true;
        },
      );
      await run();
      expect(saw.answered).toBe(true);
      expect(s.messages).toEqual([]);
    });

    // The message is with the customer once the send has left, and the labels and the resolve that
    // follow it are the step's: the step commits, so no retry would perform them. A deadline that
    // fires during the send does not take them away.
    test("a deadline that fires during the send still applies the step's post-actions", async () => {
      const saw = { abort: false, answered: false };
      const controller = new AbortController();
      const { s, run } = nudge(
        953,
        slowModel(20, saw),
        controller.signal,
        undefined,
        {
          postActions: { assignLabels: ["sem-resposta"], resolve: true },
          onSend: () => controller.abort(new Error("deadline exceeded")),
        },
      );
      const outcome = await run();
      expect(outcome).toBe("messaged");
      expect(s.messages.map(([c]) => c)).toEqual([953]);
      expect(s.labels).toEqual([["sem-resposta"]]);
      expect(s.statuses).toEqual(["resolved"]);
    });

    // The same holds on the other ways a step reaches the customer's side outside the window: an
    // approved template, and the explained note when there is none.
    const OUTSIDE_WINDOW = new Date(Date.now() - 30 * 3_600_000);
    test("a deadline that fires during the template send still applies the step's labels", async () => {
      await seedConversation(958, 89, { lastInboundAt: OUTSIDE_WINDOW });
      await suDb.agent.update({
        where: { id: agentId },
        data: { settings: { serviceWindow: { templateName: "reengage" } } },
      });
      const controller = new AbortController();
      try {
        const { s, run } = nudge(
          958,
          slowModel(20, { abort: false, answered: false }),
          controller.signal,
          undefined,
          {
            postActions: { assignLabels: ["sem-resposta"], resolve: true },
            onSend: () => controller.abort(new Error("deadline exceeded")),
          },
        );
        expect(await run()).toBe("templated");
        expect(s.templates).toEqual([[958, "reengage"]]);
        expect(s.labels).toEqual([["sem-resposta"]]);
        expect(s.statuses).toEqual(["resolved"]);
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { settings: {} },
        });
      }
    });

    test("a deadline that fires during the outside-window note still applies the step's labels", async () => {
      await seedConversation(959, 90, { lastInboundAt: OUTSIDE_WINDOW });
      const controller = new AbortController();
      const { s, run } = nudge(
        959,
        slowModel(20, { abort: false, answered: false }),
        controller.signal,
        undefined,
        {
          postActions: { assignLabels: ["sem-resposta"], resolve: true },
          onSend: () => controller.abort(new Error("deadline exceeded")),
        },
      );
      expect(await run()).toBe("noted-window");
      expect(s.notes.map(([c]) => c)).toEqual([959]);
      expect(s.labels).toEqual([["sem-resposta"]]);
    });

    // A silent end sent nothing, so a deadline that cuts its post-actions short is a withdrawal: the
    // handler must not stamp the step and commit it, or the labels and the resolve it owed are never
    // performed. Answered "stale", which leaves the step to the retry.
    test("a silent nudge whose post-actions the deadline cuts short stands down", async () => {
      const controller = new AbortController();
      const { s, run } = nudge(
        954,
        silentModel(),
        controller.signal,
        undefined,
        {
          postActions: { assignLabels: ["sem-resposta"], resolve: true },
          onLabels: () => controller.abort(new Error("deadline exceeded")),
        },
      );
      expect(await run()).toBe("stale");
      expect(s.labels).toEqual([]);
      expect(s.statuses).toEqual([]);
    });

    test("a silent nudge whose resolve the deadline refuses stands down", async () => {
      const controller = new AbortController();
      const { s, run } = nudge(
        955,
        silentModel(),
        controller.signal,
        undefined,
        {
          postActions: { assignLabels: ["sem-resposta"], resolve: true },
          onSetLabels: () => controller.abort(new Error("deadline exceeded")),
        },
      );
      expect(await run()).toBe("stale");
      expect(s.labels).toEqual([["sem-resposta"]]);
      expect(s.statuses).toEqual([]);
    });

    // The control both need: the same silent end inside its deadline applies everything and reports
    // a silence.
    test("a silent nudge inside its deadline applies its post-actions", async () => {
      const { s, run } = nudge(
        956,
        silentModel(),
        new AbortController().signal,
        undefined,
        { postActions: { assignLabels: ["sem-resposta"], resolve: true } },
      );
      expect(await run()).toBe("silent");
      expect(s.labels).toEqual([["sem-resposta"]]);
      expect(s.statuses).toEqual(["resolved"]);
    });

    // A transfer that completed is as spent as a send: the conversation is a person's, so the retry
    // stands down on its ownership gate and the closing line the transfer promised would be lost.
    test("a nudge's handoff the deadline reaches at the transfer still delivers its closing line", async () => {
      const CLOSING = "Já chamo uma pessoa do time.";
      const controller = new AbortController();
      const { s, run } = nudge(
        957,
        new HandoffThenReplyModel("", CLOSING) as unknown as BaseChatModel,
        controller.signal,
        undefined,
        {
          onToggle: (status) => {
            if (status === "open")
              controller.abort(new Error("deadline exceeded"));
          },
        },
      );
      await run();
      expect(s.statuses).toContain("open");
      expect(s.messages.map(([, t]) => t)).toEqual([CLOSING]);
    });

    // The signal reaches the model call and the tool boundary through the graph's construction, and
    // never the invoke: an invoke aborted between a checkpointed tool call and its result leaves the
    // thread with a call nothing answers, and it rejects while the tool is still running.
    test("the job's signal is handed to the graph, never to its invoke", async () => {
      await seedConversation(961, 92);
      const real = graphModule.buildAgentGraph;
      const built: Array<AbortSignal | undefined> = [];
      const invoked: Array<Record<string, unknown> | undefined> = [];
      const spy = spyOn(graphModule, "buildAgentGraph").mockImplementation(
        (p) => {
          built.push(p.signal);
          const graph = real(p);
          const invoke = graph.invoke.bind(graph);
          graph.invoke = ((input: never, options?: Record<string, unknown>) => {
            invoked.push(options);
            return invoke(input, options as never);
          }) as typeof graph.invoke;
          return graph;
        },
      );
      const controller = new AbortController();
      try {
        const { run } = nudge(
          961,
          slowModel(1, { abort: false, answered: false }),
          controller.signal,
        );
        await run();
      } finally {
        spy.mockRestore();
      }
      expect(built).toHaveLength(1);
      expect(built[0]).toBe(controller.signal);
      expect(invoked.length).toBeGreaterThan(0);
      expect(invoked.filter((o) => o && "signal" in o)).toEqual([]);
    });

    test("a nudge whose deadline never fires still sends", async () => {
      const saw = { abort: false, answered: false };
      const { s, run } = nudge(
        952,
        slowModel(20, saw),
        new AbortController().signal,
      );
      await run();
      expect(s.messages.map(([c]) => c)).toEqual([952]);
    });
  },
);
