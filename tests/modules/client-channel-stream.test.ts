import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import Elysia from "elysia";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import {
  type ClientTurnEvent,
  ClientTurnProgress,
} from "@/modules/client-channel/progress";
import {
  type ClientTurnResult,
  runClientTurn,
} from "@/modules/client-channel/service";
import { streamClientTurn } from "@/modules/client-channel/stream";
import { dbProbeFailed } from "@/tests/db-gate";
import { clearFlowLog } from "../utils/flowlog";

// A client turn streamed as Server-Sent Events: the server-side tools as they start and end, then
// the same answer the JSON route gives. A refusal before the first event keeps its HTTP status.

const DONE: ClientTurnResult = { threadId: "t1", status: "done", reply: "oi" };

// The route's own wiring, without the auth in front of it: what reaches the browser.
function appFor(
  run: (onEvent: (event: ClientTurnEvent) => void) => Promise<ClientTurnResult>,
  heartbeatMs?: number,
) {
  return new Elysia()
    .onError(({ error, set }) => {
      if (!(error instanceof AppError)) return;
      set.status = error.statusCode;
      return Response.json(
        { error: error.message },
        { status: error.statusCode },
      );
    })
    .post("/turn", async () =>
      streamClientTurn(run, { acceptLanguage: null, heartbeatMs }),
    );
}

async function post(app: { handle: (req: Request) => Promise<Response> }) {
  const res = await app.handle(
    new Request("http://localhost/turn", {
      method: "POST",
      headers: { accept: "text/event-stream" },
    }),
  );
  return {
    status: res.status,
    type: res.headers.get("content-type"),
    text: await res.text(),
  };
}

function events(text: string) {
  return text
    .trim()
    .split("\n\n")
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1];
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "";
      return { event, data: data ? JSON.parse(data) : data };
    });
}

describe("client channel: the turn as a stream", () => {
  test("each tool as it starts and ends, then the answer in the JSON shape", async () => {
    const res = await post(
      appFor(async (emit) => {
        emit({ type: "tool", phase: "start", name: "buscar" });
        await Bun.sleep(5);
        emit({ type: "tool", phase: "end", name: "buscar", ok: true });
        return DONE;
      }),
    );
    expect(res.status).toBe(200);
    expect(res.type).toStartWith("text/event-stream");
    expect(events(res.text)).toEqual([
      { event: "tool", data: { type: "tool", phase: "start", name: "buscar" } },
      {
        event: "tool",
        data: { type: "tool", phase: "end", name: "buscar", ok: true },
      },
      { event: "done", data: DONE },
    ]);
  });

  test("a pending turn ends on a pending event with the calls to run", async () => {
    const pending: ClientTurnResult = {
      threadId: "t1",
      status: "pending",
      calls: [{ toolCallId: "c1", name: "ler_tela", args: {} }],
    };
    const res = await post(appFor(async () => pending));
    expect(events(res.text)).toEqual([{ event: "pending", data: pending }]);
  });

  test("a refusal before any event keeps its HTTP status", async () => {
    const res = await post(
      appFor(async () => {
        throw new AppError("thread not found", 404);
      }),
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.text)).toEqual({ error: "thread not found" });
  });

  test("a refusal after the first event arrives as an error event", async () => {
    const res = await post(
      appFor(async (emit) => {
        emit({ type: "tool", phase: "start", name: "buscar" });
        await Bun.sleep(5);
        throw new AppError("spend ceiling reached", 429);
      }),
    );
    expect(res.status).toBe(200);
    expect(events(res.text).at(-1)).toEqual({
      event: "error",
      data: { status: 429, error: "spend ceiling reached" },
    });
  });

  test("an unexpected failure mid-stream names no internals", async () => {
    const res = await post(
      appFor(async (emit) => {
        emit({ type: "tool", phase: "start", name: "buscar" });
        await Bun.sleep(5);
        throw new Error("connection string postgres://segredo");
      }),
    );
    expect(events(res.text).at(-1)).toEqual({
      event: "error",
      data: { status: 500, error: "Internal Server Error" },
    });
  });

  test("a silent turn sends a ping, so a proxy does not close it", async () => {
    // The turn stays silent until the client has read a ping off the stream, so the test
    // waits on the ping itself rather than on a guess of how long one takes to come.
    let pinged = () => {};
    const heard = new Promise<void>((r) => {
      pinged = r;
    });
    const res = await appFor(async () => {
      await heard;
      return DONE;
    }, 5).handle(
      new Request("http://localhost/turn", {
        method: "POST",
        headers: { accept: "text/event-stream" },
      }),
    );
    const reader = (
      res.body as ReadableStream<Uint8Array | string>
    ).getReader();
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text +=
        typeof value === "string"
          ? value
          : decoder.decode(value, { stream: true });
      if (text.includes("event: ping")) pinged();
    }
    const all = events(text);
    expect(all.filter((e) => e.event === "ping").length).toBeGreaterThan(0);
    expect(all.at(-1)).toEqual({ event: "done", data: DONE });
  });
});

describe("client channel: progress events", () => {
  test("a caller that throws does not fail the turn", () => {
    const progress = new ClientTurnProgress(() => {
      throw new Error("gone");
    }, new Set());
    expect(() =>
      progress.handleToolStart(
        {} as never,
        "",
        "r1",
        undefined,
        undefined,
        undefined,
        "buscar",
      ),
    ).not.toThrow();
  });

  test("a tool that failed ends with ok false, returned or thrown", () => {
    const seen: ClientTurnEvent[] = [];
    const progress = new ClientTurnProgress((e) => seen.push(e), new Set());
    progress.handleToolStart(
      {} as never,
      "",
      "r1",
      undefined,
      undefined,
      undefined,
      "a",
    );
    progress.handleToolEnd({ status: "error", content: "HTTP 500" }, "r1");
    progress.handleToolStart(
      {} as never,
      "",
      "r2",
      undefined,
      undefined,
      undefined,
      "b",
    );
    progress.handleToolError(new Error("x"), "r2");
    expect(seen.filter((e) => e.phase === "end")).toEqual([
      { type: "tool", phase: "end", name: "a", ok: false },
      { type: "tool", phase: "end", name: "b", ok: false },
    ]);
  });

  test("the host's own tools and the silence marker are not reported", () => {
    const seen: ClientTurnEvent[] = [];
    const progress = new ClientTurnProgress(
      (e) => seen.push(e),
      new Set(["ler_tela"]),
    );
    progress.handleToolStart(
      {} as never,
      "",
      "r1",
      undefined,
      undefined,
      undefined,
      "ler_tela",
    );
    progress.handleToolStart(
      {} as never,
      "",
      "r2",
      undefined,
      undefined,
      undefined,
      "skip_reply",
    );
    progress.handleToolEnd({}, "r1");
    progress.handleToolEnd({}, "r2");
    expect(seen).toEqual([]);
  });
});

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

// After the human message it calls `tool`; after the tool's result it answers.
function callsThenAnswers(tool: string) {
  return {
    async invoke() {
      return new AIMessage("");
    },
    bindTools() {
      return {
        async invoke(messages: BaseMessage[]) {
          if (messages.at(-1)?.getType() === "human")
            return new AIMessage({
              content: "",
              tool_calls: [
                { id: "c1", name: tool, args: { expression: "1+1" } },
              ],
            });
          return new AIMessage("deu 2");
        },
      };
    },
  };
}

const SPECS = [
  {
    name: "ler_tela",
    description: "lê a tela",
    parameters: { type: "object", properties: {} },
  },
];

describe.skipIf(!dbUp)("client channel: a real turn's progress", () => {
  let tenantId = 0n;
  let agentId = 0n;
  let ctx: TenantContext;

  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CCST", slug: `ccst-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "copiloto",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-6-luna",
            credentialRef: `vault:${key.id}`,
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      await clearFlowLog(suDb, { tenantId });
      await suDb.tenant.deleteMany({ where: { id: tenantId } });
    }
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  function turn(tool: string, onEvent: (e: ClientTurnEvent) => void) {
    return runClientTurn({
      ctx,
      agentId,
      user: { id: "ana" },
      clientTools: SPECS,
      base: appDb,
      message: "quanto é 1+1?",
      onEvent,
      deps: {
        makeModel: () => callsThenAnswers(tool) as unknown as BaseChatModel,
        checkpointer: new MemorySaver(),
      },
    });
  }

  test("a server tool is reported as it starts and ends, before the answer", async () => {
    const seen: ClientTurnEvent[] = [];
    const result = await turn("calculator", (e) => seen.push(e));
    expect(result).toMatchObject({ status: "done", reply: "deu 2" });
    expect(seen).toEqual([
      { type: "tool", phase: "start", name: "calculator" },
      { type: "tool", phase: "end", name: "calculator", ok: true },
    ]);
  });

  test("a call to the host's own tool is not reported: it comes back as pending", async () => {
    const seen: ClientTurnEvent[] = [];
    const result = await turn("ler_tela", (e) => seen.push(e));
    expect(result.status).toBe("pending");
    expect(seen).toEqual([]);
  });
});
