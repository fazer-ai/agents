import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  drainInFlight,
  inFlightWork,
  resetShutdownForTest,
} from "@/lib/shutdown";
import type { CallRecord } from "@/modules/voice-call/bridge";
import * as service from "@/modules/voice-call/service";
import * as setup from "@/modules/voice-call/setup";
import * as tools from "@/modules/voice-call/tools";
import { stubExports } from "@/tests/utils/module-stub";
import { until } from "@/tests/utils/poll";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The call stream route reads the conversation the query names only after it is fenced to the
// token's inbox: the history and the tools of a conversation in another inbox never reach the call,
// and a call that ends before the fence answers reports to no conversation. A token that resolves to
// no inbox closes the stream before any frame.

setupPrismaMock();

const { voiceController, callSummary } = await import(
  "@/api/v1/voice.controller"
);

const nativeGlobals = globalThis as unknown as {
  BunWebSocket: typeof WebSocket;
  BunResponse: typeof Response;
};
const happyResponse = globalThis.Response;

const route: service.VoiceRoute = {
  tenantId: 1n,
  instanceId: 2n,
  inboxId: 501,
  agentId: 3n,
  agentName: "Voz",
  systemPrompt: "",
};
// conversation id -> the Chatwoot inbox it is in
const conversations: Record<number, number> = { 10: 501, 11: 502 };
const read: {
  history: (number | null)[];
  tools: (number | null)[];
  reported: (number | null)[];
  directions: string[];
} = { history: [], tools: [], reported: [], directions: [] };
// Set by the test whose report fails.
let failReport = false;
// A report still writing to Chatwoot, released by the test.
let reportHeld: (() => void) | null = null;
let holdReport = false;
// How often the "unbound" token was resolved.
let unboundReads = 0;
let reboundReads = 0;
// A fence still waiting on Chatwoot, released by the test.
let fenceHeld: (() => void) | null = null;

stubExports(service, {
  resolveVoiceRoute: async (token: string) => {
    if (token === "tok") return route;
    // A route that answered when the stream opened, and is gone by the time the call is configured.
    if (token === "unbound") return unboundReads++ === 0 ? route : null;
    // And one whose inbox was bound to another voice agent meanwhile.
    if (token === "rebound")
      return reboundReads++ === 0 ? route : { ...route, agentId: 4n };
    return null;
  },
  fenceConversation: async (_r: service.VoiceRoute, id: number | null) => {
    if (id === 12) await new Promise<void>((go) => (fenceHeld = go));
    return id !== null && conversations[id] === route.inboxId ? id : null;
  },
  conversationHistory: async (_r: service.VoiceRoute, id: number | null) => {
    read.history.push(id);
    return "";
  },
  reportCall: async (_r: service.VoiceRoute, c: service.CallContext) => {
    read.reported.push(c.conversationId);
    read.directions.push(c.direction);
    if (c.conversationId === 10 && failReport) throw new Error("Chatwoot down");
    if (holdReport) await new Promise<void>((go) => (reportHeld = go));
    return null;
  },
});
stubExports(tools, {
  loadVoiceAgent: async (_r: service.VoiceRoute, id: number | null) => {
    read.tools.push(id);
    return { systemPrompt: "", tools: [] };
  },
});
// The call stops here, before any engine: what this file asserts is read while configuring.
stubExports(setup, {
  setUpAgentCalls: async () => ({ ok: false, problem: "no_credential" }),
});

interface ListeningApp {
  server: { port: number; stop(force: boolean): void };
}
let server: ListeningApp["server"] | null = null;

beforeAll(() => {
  (globalThis as { Response: typeof Response }).Response =
    nativeGlobals.BunResponse;
  const app = new Elysia().group("/api", (a) => a.use(voiceController));
  server = (
    app.listen({ port: 0, hostname: "127.0.0.1" }) as unknown as ListeningApp
  ).server;
});

afterAll(() => {
  server?.stop(true);
  (globalThis as { Response: typeof Response }).Response = happyResponse;
});

async function open(token: string, conversationId: number, query = "") {
  const ws = new nativeGlobals.BunWebSocket(
    `ws://127.0.0.1:${server?.port}/api/v1/voice/stream/${token}?conversation_id=${conversationId}${query}`,
  );
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the stream did not open"));
  });
  return ws;
}

async function call(conversationId: number): Promise<void> {
  const before = read.history.length;
  const ws = await open("tok", conversationId);
  ws.send(JSON.stringify({ event: "start", direction: "inbound" }));
  await until("the call to be configured", () => read.history.length > before);
  ws.close();
}

describe("the call stream route", () => {
  for (const [token, change, reads] of [
    ["unbound", "unbound", () => unboundReads],
    ["rebound", "replaced by another", () => reboundReads],
  ] as const) {
    test(`a call whose agent was ${change} while it rang is not started`, async () => {
      const before = { history: read.history.length, tools: read.tools.length };
      const ws = await open(token, 10);
      const closed = new Promise<void>((done) => {
        ws.onclose = () => done();
      });
      ws.send(JSON.stringify({ event: "start", direction: "outbound" }));
      ws.send(JSON.stringify({ event: "answered" }));
      await closed;
      expect(reads()).toBe(2);
      expect(read.history.length).toBe(before.history);
      expect(read.tools.length).toBe(before.tools);
    });
  }

  test("reads a conversation of the token's inbox, and none of another inbox", async () => {
    await call(10);
    await call(11);
    expect(read.history).toEqual([10, null]);
    expect(read.tools).toEqual([10, null]);
  });

  test("a call that ends before the fence answers reports to no conversation", async () => {
    const before = read.reported.length;
    const ws = await open("tok", 12);
    ws.send(JSON.stringify({ event: "start", direction: "inbound" }));
    ws.send(JSON.stringify({ event: "answered" }));
    await until("the fence to be asked", () => fenceHeld);
    ws.close();
    await until("the call to be reported", () => read.reported.length > before);
    fenceHeld?.();
    expect(read.reported.slice(before)).toEqual([null]);
  });

  test("a token of no inbox closes the stream", async () => {
    const ws = await open("bad", 10);
    await new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    expect(ws.readyState).toBe(ws.CLOSED);
  });

  test("a call the start frame names as placed is reported as placed", async () => {
    const before = read.directions.length;
    const configured = read.tools.length;
    const ws = await open("tok", 10);
    ws.send(JSON.stringify({ event: "start", direction: "outbound" }));
    ws.send(JSON.stringify({ event: "answered" }));
    await until(
      "the call to be configured",
      () => read.tools.length > configured,
    );
    ws.close();
    await until(
      "the call to be reported",
      () => read.directions.length > before,
    );
    expect(read.directions.slice(before)).toEqual(["outbound"]);
  });

  test("a report still being written holds a shutdown until it is done", async () => {
    holdReport = true;
    try {
      await call(10);
      await until("the report to start", () => reportHeld);
      expect(inFlightWork().byKind["voice-call-report"]).toBe(1);
      reportHeld?.();
      await until(
        "the report to finish",
        () => !inFlightWork().byKind["voice-call-report"],
      );
    } finally {
      holdReport = false;
      reportHeld = null;
    }
  });

  test("a live call holds a shutdown, and one still live at the bound is hung up and reported", async () => {
    const before = read.reported.length;
    const ws = await open("tok", 12);
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    ws.send(JSON.stringify({ event: "start", direction: "inbound" }));
    ws.send(JSON.stringify({ event: "answered" }));
    await until("the fence to be asked", () => fenceHeld);
    expect(inFlightWork().byKind["voice-call"]).toBe(1);
    try {
      const drained = await drainInFlight({ boundMs: 10, settleMs: 1_000 });
      expect(drained.stillRunning.byKind["voice-call"]).toBe(1);
      await closed;
      await until(
        "the call to be reported",
        () => read.reported.length > before,
      );
      expect(inFlightWork().byKind["voice-call"]).toBeUndefined();
    } finally {
      fenceHeld?.();
      fenceHeld = null;
      resetShutdownForTest();
    }
  });

  test("a call the URL names as placed is configured only once answered", async () => {
    const before = read.history.length;
    const ws = await open("tok", 10, "&direction=outbound");
    ws.send(JSON.stringify({ event: "start", call_id: "c" }));
    // A call to the inbox is configured from its start frame within milliseconds (the stubs answer at
    // once); this one has to still be waiting for the answer well past that.
    const past = Date.now() + 200;
    await until("the start frame's moment to pass", () => Date.now() > past);
    const configuredEarly = read.history.length > before;
    ws.send(JSON.stringify({ event: "answered" }));
    await until(
      "the call to be configured",
      () => read.history.length > before,
    );
    ws.close();
    expect(configuredEarly).toBe(false);
  });

  test("a report that fails is logged, and the server keeps taking calls", async () => {
    failReport = true;
    try {
      const before = read.reported.length;
      await call(10);
      await until("the failed report", () => read.reported.length > before);
    } finally {
      failReport = false;
    }
    const after = read.history.length;
    await call(10);
    expect(read.history.length).toBe(after + 1);
  });
});

describe("the summary of a call that ended", () => {
  const setup = { apiKey: "k" } as unknown as setup.CallsSetup;
  const done = { engineConversationId: "conv-1" } as CallRecord;

  test("is asked of the engine, except once a shutdown cut the report", async () => {
    const asked: string[] = [];
    const fetchSummary = async (_key: string, id: string) => {
      asked.push(id);
      return "resumo";
    };
    const live = new AbortController();
    expect(await callSummary(setup, done, live.signal, fetchSummary)).toBe(
      "resumo",
    );
    expect(
      await callSummary(setup, done, AbortSignal.abort(), fetchSummary),
    ).toBeNull();
    expect(asked).toEqual(["conv-1"]);
  });

  test("still being waited for, is given up when the shutdown cuts the report", async () => {
    const cut = new AbortController();
    const summary = callSummary(
      setup,
      done,
      cut.signal,
      () => new Promise<string>(() => {}),
    );
    cut.abort();
    expect(await summary).toBeNull();
  });
});
