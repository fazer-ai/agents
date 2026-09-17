// Verificador #658 — UM processo, UM turno. Cada replica dos cenarios e uma execucao deste arquivo.
// Tudo que o cenario precisa medir sai no JSON da ultima linha do stdout.
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PrismaPg } from "@prisma/adapter-pg";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runAgentTurn } from "@/graph/runtime";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";

const LABEL = process.env.V_LABEL ?? "?";
const tenantId = BigInt(process.env.V_TENANT as string);
const instanceId = BigInt(process.env.V_INSTANCE as string);
const conversationId = Number(process.env.V_CONV);
const contactInboxRaw = process.env.V_CONTACT_INBOX ?? "";
const contactInboxId = contactInboxRaw === "" ? null : Number(contactInboxRaw);
const msg = process.env.V_MSG as string;
const resp = process.env.V_RESP as string;
const messageId = Number(process.env.V_MSG_ID);
const modelDelayMs = Number(process.env.V_MODEL_DELAY_MS ?? "1500");
const startAt = Number(process.env.V_START_AT ?? "0");

const appDb = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env.TEST_APP_DATABASE_URL as string,
  }),
});

const pool = new Pool({
  connectionString: process.env.LANGGRAPH_DATABASE_URL as string,
  max: 10,
});
const saver = new PostgresSaver(pool, undefined, { schema: "langgraph" });
await saver.setup();

interface ModelCall {
  startedAt: number;
  endedAt: number;
  history: Array<[string, string]>;
}
const modelCalls: ModelCall[] = [];

// Modelo fake deterministico: registra inicio, fim e o historico que recebeu, dorme o tempo pedido e
// responde a string do cenario. Precisa de `bindTools` porque o runtime sempre liga as ferramentas.
class SlowRecordingModel {
  async invoke(messages: unknown[]) {
    const startedAt = Date.now();
    const history = (messages as BaseMessage[]).map((m) => {
      const type = typeof m?.getType === "function" ? m.getType() : "raw";
      const content =
        typeof m?.content === "string" ? m.content : JSON.stringify(m?.content);
      return [type, content] as [string, string];
    });
    await Bun.sleep(modelDelayMs);
    modelCalls.push({ startedAt, endedAt: Date.now(), history });
    return new AIMessage(resp);
  }
  bindTools(_tools: unknown) {
    return { invoke: (messages: unknown[]) => this.invoke(messages) };
  }
}

const clientCalls: Array<[string, number, string]> = [];
const stubClient = {
  sendMessage: async (convId: number, content: string) => {
    clientCalls.push(["sendMessage", convId, content]);
    return {};
  },
  toggleStatus: async (convId: number, status: string) => {
    clientCalls.push(["toggleStatus", convId, status]);
    return {};
  },
  getMessages: async () => [],
} as unknown as ChatwootClient;

const event: NormalizedChatwootEvent = {
  event: "message_created",
  conversationId,
  inboxId: 7,
  status: "pending",
  assigneeType: null,
  assigneeId: null,
  assigneeName: null,
  contactInboxId,
  message: {
    id: messageId,
    content: msg,
    messageType: "incoming",
    private: false,
  },
};

if (startAt > 0) {
  const delta = startAt - Date.now();
  if (delta > 0) await Bun.sleep(delta);
}

const startedAt = Date.now();
let outcome: string | null = null;
let error: string | null = null;
try {
  outcome = await runAgentTurn({
    tenantId,
    instanceId,
    agentBotId: 9,
    event,
    base: appDb,
    deps: {
      makeModel: () => new SlowRecordingModel() as never,
      makeClient: async () => stubClient,
      checkpointer: saver,
      sleep: async () => {},
    },
  });
} catch (e) {
  error = e instanceof Error ? e.message : String(e);
}
const finishedAt = Date.now();

console.log(
  `__V658__${JSON.stringify({
    label: LABEL,
    outcome,
    error,
    startedAt,
    finishedAt,
    elapsedMs: finishedAt - startedAt,
    modelCalls,
    clientCalls,
  })}`,
);
await appDb.$disconnect();
await pool.end();
process.exit(0);
