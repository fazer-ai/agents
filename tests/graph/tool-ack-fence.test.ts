import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  type AgentConfig,
  buildToolset,
  type ToolsetCtx,
} from "@/graph/prepare";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";

// The slow-tool ack is the one customer-facing write a tool makes on its own, and its send is a wait
// after the graph's ask at the tool boundary. A run called off inside it — the operator's flip to
// monitoring (issue #209 review, round 10) — shows no typing indicator after the ack and makes no
// request. Asked of the toolset the runtime builds, with the fence it hands in.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let app: PrismaClient | undefined;
if (appUrl) {
  try {
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

function config(): AgentConfig {
  return {
    agentId: 1n,
    contactDbId: null,
    conversationDbId: null,
    contactVoiceReply: null,
    documentSelections: [],
    handoffConfig: HANDOFF_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    contactAuth: CONTACT_AUTH_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    httpToolContext: {},
    codeToolDefs: [],
    httpToolDefs: [
      {
        name: "consulta_lenta",
        description: "a slow lookup that acknowledges first",
        method: "GET",
        urlTemplate: "https://8.8.8.8/v1/slow",
        allowedHosts: ["8.8.8.8"],
        headers: {},
        inputSchema: {},
        ackEnabled: true,
        ackMessage: "Já verifico pra você…",
      },
    ],
    integrationSelections: [],
    mcpSelections: [],
    nativeToolsAllow: undefined,
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    toolGuidance: {},
    toolPreconditions: {},
    transferWithSummary: true,
  } as unknown as AgentConfig;
}

const realFetch = globalThis.fetch;

describe.skipIf(!dbUp)(
  "the slow-tool ack asks the send fence after its own send",
  () => {
    const requests: string[] = [];
    beforeAll(() => {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requests.push(typeof input === "string" ? input : input.toString());
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof globalThis.fetch;
    });
    afterAll(async () => {
      globalThis.fetch = realFetch;
      await app?.$disconnect();
    });

    async function run(fenceAnswers: boolean) {
      const calls: string[] = [];
      const client = {
        sendMessage: async (_id: number, text: string) => {
          calls.push(`send:${text}`);
          return {};
        },
        toggleTyping: async (_id: number, on: boolean) => {
          calls.push(`typing:${on}`);
          return {};
        },
      } as unknown as ChatwootClient;
      const ctx: ToolsetCtx = {
        tenantId: 1n,
        instanceId: 1n,
        base: appDb,
        client,
        conversationId: 77,
        threadId: `t-${process.pid}`,
        // Answered AFTER the ack's send: what the fence reads changed inside it.
        stillWanted: async () => fenceAnswers,
      };
      const tools = await buildToolset(config(), ctx, {
        buildNativeTools: () => [],
      });
      const tool = tools.find((t) => t.name === "consulta_lenta");
      if (!tool) throw new Error("the HTTP tool was not built");
      requests.length = 0;
      const out = await tool.invoke({ __wait_message: "Só um momento!" });
      return { calls, out: String(out), requests: [...requests] };
    }

    test("a run called off inside the ack's send shows no typing and makes no request", async () => {
      const r = await run(false);
      expect(r.calls).toEqual(["send:Só um momento!"]);
      expect(r.requests).toEqual([]);
      expect(r.out).toContain("called off");
    });

    test("control: a run still wanted types after the ack and makes the request", async () => {
      const r = await run(true);
      expect(r.calls).toEqual(["send:Só um momento!", "typing:true"]);
      expect(r.requests.length).toBe(1);
    });
  },
);
