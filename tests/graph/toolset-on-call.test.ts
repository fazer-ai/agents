import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { type AgentConfig, buildToolset } from "@/graph/prepare";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { CONTACT_AUTH_DEFAULTS } from "@/modules/contact-auth/settings";
import { CROSS_INBOX_CASE_DEFAULTS } from "@/modules/cross-inbox-case/settings";
import { HANDOFF_DEFAULTS } from "@/modules/handoff/settings";
import { SEND_IMAGE_DEFAULTS } from "@/modules/images/settings";
import { KANBAN_DEFAULTS } from "@/modules/kanban/settings";
import { toVoiceTools } from "@/modules/voice-call/tools";
import { until } from "@/tests/utils/poll";

// A call's turn answers by voice: a slow tool's holding message is not posted to the chat, and the
// tool still runs, on the deadline the call gives it.

const PUBLIC = "8.8.8.8";

const realFetch = globalThis.fetch;
let requests = 0;

beforeEach(() => {
  requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function config(): AgentConfig {
  return {
    agentId: 1n,
    contactDbId: null,
    conversationDbId: null,
    contactVoiceReply: null,
    handoffConfig: HANDOFF_DEFAULTS,
    kanbanConfig: KANBAN_DEFAULTS,
    contactAuth: CONTACT_AUTH_DEFAULTS,
    sendImageConfig: SEND_IMAGE_DEFAULTS,
    crossInboxCaseConfig: CROSS_INBOX_CASE_DEFAULTS,
    chatwootContactId: null,
    ragConfig: undefined,
    timezone: "America/Sao_Paulo",
    transferWithSummary: true,
    protectedLabels: [],
    allowedLabels: [],
    outsideAllowedLabels: "accept",
    httpToolContext: {},
    codeToolDefs: [],
    integrationSelections: [],
    mcpSelections: [],
    documentSelections: [],
    nativeToolsAllow: [],
    toolGuidance: {},
    toolPreconditions: {},
    httpToolDefs: [
      {
        name: "consulta",
        description: null,
        method: "GET",
        urlTemplate: `https://${PUBLIC}/consulta`,
        allowedHosts: [PUBLIC],
        headers: {},
        inputSchema: {},
        expectedStatuses: [],
        maxResponseChars: null,
        silenceTruncationAlert: false,
        appointment: null,
        conversationRefIntegrationId: null,
        outputSchema: {},
        credentialRef: null,
        credentialKind: null,
        credentialParamName: null,
        credentialBaseUrl: null,
        ackEnabled: true,
        ackMessage: "Um instante.",
        query: {},
        body: {},
      },
    ],
  } as unknown as AgentConfig;
}

async function runSlowTool(
  onCall: boolean,
  httpToolTimeoutMs?: number,
): Promise<string[]> {
  const sent: string[] = [];
  const client = {
    muted: false,
    sendMessage: async (_id: number, text: string) => {
      sent.push(text);
      return {};
    },
    toggleTyping: async () => {},
  } as unknown as ChatwootClient;
  const tools = await buildToolset(
    config(),
    {
      tenantId: 1n,
      instanceId: 1n,
      base: {} as unknown as PrismaClient,
      client,
      conversationId: 7,
      threadId: "t-on-call",
      onCall,
      httpToolTimeoutMs,
    },
    { buildNativeTools: () => [] },
  );
  await tools
    .find((t) => t.name === "consulta")
    ?.invoke({ __wait_message: "Só um instante." });
  return sent;
}

describe("a slow tool on a call's turn", () => {
  test("posts no holding message to the chat, and still runs", async () => {
    expect(await runSlowTool(true)).toEqual([]);
    expect(requests).toBe(1);
    expect(await runSlowTool(false)).toEqual(["Só um instante."]);
    expect(requests).toBe(2);
  });
});

describe("an HTTP tool on a call's turn", () => {
  test("is cut at the deadline the call gives it, not the instance's", async () => {
    let aborted = false;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      })) as unknown as typeof fetch;
    await expect(runSlowTool(true, 5)).rejects.toThrow("within 0.005s");
    expect(aborted).toBe(true);
  });
});

describe("an HTTP tool run under a call's deadline", () => {
  test("has its request cancelled when that deadline passes, not at its own timeout", async () => {
    let sent = false;
    let aborted = false;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>(() => {
        sent = true;
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
        });
      })) as unknown as typeof fetch;
    const client = {
      muted: false,
      sendMessage: async () => ({}),
      toggleTyping: async () => {},
    } as unknown as ChatwootClient;
    const tools = await buildToolset(
      config(),
      {
        tenantId: 1n,
        instanceId: 1n,
        base: {} as unknown as PrismaClient,
        client,
        conversationId: 7,
        threadId: "t-on-call-deadline",
        onCall: true,
        httpToolTimeoutMs: 60_000,
      },
      { buildNativeTools: () => [] },
    );
    const consulta = toVoiceTools(tools).find((t) => t.name === "consulta");
    const deadline = new AbortController();
    const run = consulta
      ?.invoke({ __wait_message: "Só um instante." }, "c1", deadline.signal)
      .catch((err: Error) => err.message);
    await until("the request to be sent", () => sent);
    deadline.abort(new Error("the call's deadline"));
    await until("the request to be cancelled", () => aborted);
    await run;
  });
});
