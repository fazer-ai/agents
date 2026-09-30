import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import config from "@/config";
import {
  __callHeadersForTest,
  loadMcpToolsForAgent,
  type McpSelection,
} from "@/graph/tools/mcp";

// A connection's declared headers against a real MCP server in its own process: the value of each
// call comes from that call's conversation, on one shared session, and discovery carries none.

interface Seen {
  request?: string;
  method?: string | null;
  session?: string | null;
  contact?: string | null;
  inbox?: string | null;
  auth?: string | null;
  port?: number;
}

const FIXTURE = new URL(
  "../fixtures/mcp/header-echo-server.ts",
  import.meta.url,
).pathname;
let proc: ReturnType<typeof Bun.spawn> | null = null;
const seen: Seen[] = [];
let port = 0;
const privateBefore = config.ssrf.allowPrivateTargets;
// The DOM preload replaces fetch, Headers and the abort pair; the MCP transport has to reach a real
// socket, so the suite runs on the natives tests/dom-setup.ts kept.
const NATIVE = ["fetch", "Headers", "AbortController", "AbortSignal"] as const;
const g = globalThis as unknown as Record<string, unknown>;
const domGlobals = Object.fromEntries(NATIVE.map((k) => [k, g[k]]));

async function readLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("{")) seen.push(JSON.parse(line) as Seen);
      nl = buf.indexOf("\n");
    }
  }
}

function sel(connId: bigint, over: Partial<McpSelection> = {}): McpSelection {
  return {
    connId,
    name: `echo-${connId}`,
    transport: "streamableHttp",
    url: `http://127.0.0.1:${port}/mcp`,
    command: null,
    secret: "tok-123",
    credentialBaseUrl: null,
    credentialKind: null,
    credentialParamName: null,
    enabledTools: ["whoami"],
    headers: {
      "X-Contact": "{{contact_phone}}",
      "X-Inbox": "inbox-{{inbox_id}}",
    },
    ...over,
  };
}

async function toolFor(
  s: McpSelection,
  context: Record<string, string>,
): Promise<StructuredToolInterface> {
  const tools = await loadMcpToolsForAgent(1n, [s], {
    allowHttp: true,
    context,
  });
  if (tools.length !== 1)
    throw new Error(`expected 1 tool, got ${tools.length}`);
  return tools[0] as StructuredToolInterface;
}

async function whoami(tool: StructuredToolInterface) {
  const out = (await tool.invoke({})) as unknown;
  const text =
    typeof out === "string"
      ? out
      : String((out as { content?: unknown }).content ?? out);
  return JSON.parse(text) as {
    contact: string | null;
    inbox: string | null;
    auth: string | null;
  };
}

describe("an MCP connection's declared headers", () => {
  beforeAll(async () => {
    config.ssrf.allowPrivateTargets = true;
    for (const k of NATIVE) g[k] = g[`Bun${k[0]?.toUpperCase()}${k.slice(1)}`];
    proc = Bun.spawn(["bun", FIXTURE], { stdout: "pipe", stderr: "inherit" });
    void readLines(proc.stdout as ReadableStream<Uint8Array>);
    const deadline = Date.now() + 10_000;
    while (!port && Date.now() < deadline) {
      port = seen.find((l) => l.port)?.port ?? 0;
      await Bun.sleep(20);
    }
    if (!port) throw new Error("the MCP fixture did not start");
  });

  afterAll(() => {
    config.ssrf.allowPrivateTargets = privateBefore;
    for (const k of NATIVE) g[k] = domGlobals[k];
    proc?.kill();
  });

  test("each call carries its own conversation's values, on one session, and discovery none", async () => {
    const from = seen.length;
    const a = await toolFor(sel(501n), {
      contact_phone: "+5511999990001",
      inbox_id: "7",
    });
    const b = await toolFor(sel(501n), {
      contact_phone: "+5511999990002",
      inbox_id: "8",
    });
    expect(await whoami(a)).toMatchObject({
      contact: "+5511999990001",
      inbox: "inbox-7",
    });
    const [ra, rb] = await Promise.all([whoami(a), whoami(b)]);
    expect(ra).toMatchObject({ contact: "+5511999990001", inbox: "inbox-7" });
    expect(rb).toMatchObject({ contact: "+5511999990002", inbox: "inbox-8" });

    const lines = seen.slice(from).filter((l) => l.request);
    expect(lines.filter((l) => l.method === "initialize")).toHaveLength(1);
    expect(new Set(lines.map((l) => l.session).filter(Boolean)).size).toBe(1);
    for (const l of lines.filter((l) => l.method !== "tools/call")) {
      expect([l.method, l.contact, l.inbox]).toEqual([
        l.method ?? null,
        null,
        null,
      ]);
    }
    expect(
      lines.filter((l) => l.method === "tools/call").map((l) => l.contact),
    ).toEqual(["+5511999990001", expect.any(String), expect.any(String)]);
  });

  test("a variable the conversation lacks goes out empty, never as the literal placeholder", async () => {
    const out = await whoami(await toolFor(sel(502n), {}));
    expect(out).toMatchObject({ contact: "", inbox: "inbox-" });
  });

  test("the credential's header is never replaced by a declared one", async () => {
    const out = await whoami(
      await toolFor(
        sel(503n, { headers: { Authorization: "{{contact_id}}" } }),
        { contact_id: "42" },
      ),
    );
    expect(out.auth).toBe("Bearer tok-123");
  });

  test("a connection without headers sends none", async () => {
    const out = await whoami(
      await toolFor(sel(504n, { headers: {} }), { contact_phone: "+55119" }),
    );
    expect(out).toMatchObject({
      contact: null,
      inbox: null,
      auth: "Bearer tok-123",
    });
  });

  test("editing a header template opens a new session; a new conversation does not", async () => {
    const from = seen.length;
    await whoami(await toolFor(sel(505n), { contact_phone: "1" }));
    await whoami(await toolFor(sel(505n), { contact_phone: "2" }));
    await whoami(
      await toolFor(
        sel(505n, { headers: { "X-Contact": "p-{{contact_phone}}" } }),
        {
          contact_phone: "3",
        },
      ),
    );
    const inits = seen.slice(from).filter((l) => l.method === "initialize");
    expect(inits).toHaveLength(2);
  });
  test("a dropped session is not reused: the next turn opens a new one", async () => {
    const t1 = await toolFor(sel(506n), { contact_phone: "1" });
    await whoami(t1);
    const cache = (
      globalThis as unknown as Record<
        symbol,
        Map<string, { close: () => Promise<void> }>
      >
    )[Symbol.for("fazerai.mcp.clients")];
    await cache?.get("1:506")?.close();
    const from = seen.length;
    const t2 = await toolFor(sel(506n), { contact_phone: "2" });
    expect(await whoami(t2)).toMatchObject({ contact: "2" });
    expect(
      seen.slice(from).filter((l) => l.method === "initialize"),
    ).toHaveLength(1);
  });

  test("a request from another connection's transport does not take this call's headers", async () => {
    const { callHeaders, fetchWithCallHeaders } = __callHeadersForTest;
    const sent: Headers[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return new Response("{}");
    }) as unknown as typeof fetch;
    try {
      await callHeaders.run(
        { key: "1:1", headers: { "X-Contact": "a" } },
        async () => {
          await fetchWithCallHeaders("1:1")("http://x/", {});
          await fetchWithCallHeaders("1:2")("http://x/", {});
        },
      );
    } finally {
      globalThis.fetch = real;
    }
    expect(sent.map((h) => h.get("x-contact"))).toEqual(["a", null]);
  });
  test("a contact name no header can carry as-is still reaches the server, encoded", async () => {
    const out = await whoami(
      await toolFor(
        sel(507n, { headers: { "X-Contact": "{{contact_name}}" } }),
        {
          contact_name: "李明",
        },
      ),
    );
    expect(out.contact).toBe("%E6%9D%8E%E6%98%8E");
  });
});
