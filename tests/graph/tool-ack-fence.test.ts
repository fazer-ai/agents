import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tool } from "@langchain/core/tools";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
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
import { registerToolpack } from "@/modules/integrations/toolpacks";
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

    async function run(fenceAnswers: boolean, muted = false) {
      const calls: string[] = [];
      const client = {
        muted,
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

    test("the fence reaches the HTTP tool itself, not only the ack", async () => {
      // The wiring, which a unit test of `buildHttpTool` cannot see: `buildToolset` has to hand the
      // fence down. Without an ack there is nothing else that could stop the request, so a call
      // that sends anyway is the toolset not forwarding it (review round 28).
      const cfg = config() as unknown as Record<string, unknown>;
      cfg.httpToolDefs = [
        {
          name: "consulta_direta",
          description: "a lookup with no ack",
          method: "POST",
          urlTemplate: "https://8.8.8.8/v1/direct",
          allowedHosts: ["8.8.8.8"],
          headers: {},
          inputSchema: {},
          ackEnabled: false,
          ackMessage: null,
        },
      ];
      const tools = await buildToolset(
        cfg as unknown as AgentConfig,
        {
          tenantId: 1n,
          instanceId: 1n,
          base: appDb,
          client: {} as unknown as ChatwootClient,
          conversationId: 77,
          threadId: `t-http-${process.pid}`,
          stillWanted: async () => false,
        },
        { buildNativeTools: () => [] },
      );
      const tool = tools.find((t) => t.name === "consulta_direta");
      if (!tool) throw new Error("the HTTP tool was not built");
      requests.length = 0;
      const out = String(await tool.invoke({}));
      expect(requests).toEqual([]);
      expect(out).toContain("called off");
    });

    test("the fence reaches a toolpack's request, not only the native tools", async () => {
      // The other half of the same wiring: `buildToolpackTools` wraps the fence onto the pack's
      // fetch at the build seam, so what a unit test cannot see is whether `buildToolset` hands it
      // over at all. A hermetic pack registered here asks exactly that (review round 28).
      registerToolpack({
        catalogType: "TEST_FENCE_PACK",
        toolSpecs: [{ name: "pack_probe", schema: z.object({}) }],
        build: (_sel, packCtx) => [
          tool(
            async () => {
              await (packCtx.fetchImpl ?? fetch)("https://8.8.8.8/v1/pack");
              return "sent";
            },
            {
              name: "pack_probe",
              description: "sends one request",
              schema: z.object({}),
            },
          ),
        ],
      });
      const cfg = config() as unknown as Record<string, unknown>;
      cfg.httpToolDefs = [];
      cfg.integrationSelections = [
        {
          instanceId: 1n,
          catalogType: "TEST_FENCE_PACK",
          config: {},
          credentialRef: null,
          enabledTools: ["pack_probe"],
        },
      ];
      const tools = await buildToolset(
        cfg as unknown as AgentConfig,
        {
          tenantId: 1n,
          instanceId: 1n,
          base: appDb,
          client: {} as unknown as ChatwootClient,
          conversationId: 78,
          threadId: `t-pack-${process.pid}`,
          stillWanted: async () => false,
        },
        { buildNativeTools: () => [] },
      );
      const probe = tools.find((t) => t.name === "pack_probe");
      if (!probe) throw new Error("the toolpack tool was not built");
      requests.length = 0;
      let out = "";
      try {
        out = String(await probe.invoke({}));
      } catch (err) {
        out = `threw:${(err as Error).name}`;
      }
      expect(requests).toEqual([]);
      expect(out).toBe("threw:ToolpackCalledOffError");
    });

    test("a MUTED turn is not offered a document tool either", async () => {
      // A document is an attachment to the customer: without a turnState to queue into it refuses
      // every call, and with one it would deliver through the very send the muted client exists to
      // refuse. Same reading the native toolset and the toolpacks make (issue #568, round 23).
      const cfg = config() as unknown as Record<string, unknown>;
      cfg.documentSelections = [
        {
          templateId: 1n,
          name: "Recibo",
          slug: "recibo",
          description: null,
          fields: [],
        },
      ];
      const named = async (muted: boolean) => {
        const client = { muted } as unknown as ChatwootClient;
        const tools = await buildToolset(
          cfg as unknown as AgentConfig,
          {
            tenantId: 1n,
            instanceId: 1n,
            base: appDb,
            client,
            conversationId: 77,
            threadId: `t-doc-${process.pid}`,
          },
          { buildNativeTools: () => [] },
        );
        return tools.map((t) => t.name);
      };
      expect(await named(false)).toContain("send_recibo");
      expect(await named(true)).not.toContain("send_recibo");
    });

    test("a MUTED turn has no ack at all, and the tool runs", async () => {
      // The ack is a message in front of the customer, and the muted transport refuses one by
      // design — reaching that refusal is a defect, so an observation must not arm an ack it
      // cannot deliver. Wiring it anyway logged a failed send before every slow tool and told the
      // operator an integration was broken (issue #568, review round 22).
      const r = await run(true, true);
      expect(r.calls).toEqual([]);
      expect(r.requests.length).toBe(1);
    });
  },
);
