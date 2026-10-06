import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import config from "@/config";
import {
  buildConnConfig,
  discoverMcpServer,
  loadMcpToolsForAgent,
  type McpSelection,
} from "@/graph/tools/mcp";

// The MCP client against a legacy-protocol server (SDK v1) in its own process, with and without
// declared headers (which change the fetch each request goes through). One server answers streamable
// HTTP; the other answers it with 400, so a connection there only works by falling back to SSE.

const FIXTURE = new URL("../fixtures/mcp/protocol-server.ts", import.meta.url)
  .pathname;
const NATIVE = ["fetch", "Headers", "AbortController", "AbortSignal"] as const;
const g = globalThis as unknown as Record<string, unknown>;
const domGlobals = Object.fromEntries(NATIVE.map((k) => [k, g[k]]));
const privateBefore = config.ssrf.allowPrivateTargets;

interface Fixture {
  proc: ReturnType<typeof Bun.spawn>;
  port: number;
  lines: Array<Record<string, unknown>>;
}
const fixtures: Fixture[] = [];

async function start(env: Record<string, string> = {}): Promise<Fixture> {
  const proc = Bun.spawn(["bun", FIXTURE], {
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env, ...env },
  });
  const lines: Array<Record<string, unknown>> = [];
  void (async () => {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith("{")) lines.push(JSON.parse(line));
        nl = buf.indexOf("\n");
      }
    }
  })();
  const deadline = Date.now() + 10_000;
  let port = 0;
  while (!port && Date.now() < deadline) {
    port = Number(lines.find((l) => l.port)?.port ?? 0);
    await Bun.sleep(20);
  }
  if (!port) throw new Error("the MCP fixture did not start");
  const f = { proc, port, lines };
  fixtures.push(f);
  return f;
}

let open: Fixture;
let refusing: Fixture;
let nextId = 100n;

function sel(f: Fixture, over: Partial<McpSelection> = {}): McpSelection {
  nextId += 1n;
  return {
    connId: nextId,
    name: `proto-${nextId}`,
    transport: "streamableHttp",
    url: `http://127.0.0.1:${f.port}/mcp`,
    command: null,
    secret: null,
    credentialBaseUrl: null,
    credentialKind: null,
    credentialParamName: null,
    enabledTools: ["echo", "refuse", "price", "pair", "pair07", "point"],
    headers: {},
    ...over,
  };
}

async function tools(s: McpSelection) {
  const list = await loadMcpToolsForAgent(1n, [s], {
    allowHttp: true,
    context: { contact_phone: "+5511999990000" },
  });
  return Object.fromEntries(
    list.map((t) => [t.name.split("__").at(-1), t]),
  ) as Record<string, StructuredToolInterface>;
}

function textOf(out: unknown): string {
  if (typeof out === "string") return out;
  const content = (out as { content?: unknown }).content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

const DECLARED = { "X-Contact": "{{contact_phone}}" };

describe("MCP connections on @langchain/mcp-adapters 2", () => {
  beforeAll(async () => {
    config.ssrf.allowPrivateTargets = true;
    for (const k of NATIVE) g[k] = g[`Bun${k[0]?.toUpperCase()}${k.slice(1)}`];
    open = await start();
    refusing = await start({ MCP_HTTP_REFUSES: "1" });
  });

  afterAll(() => {
    config.ssrf.allowPrivateTargets = privateBefore;
    for (const k of NATIVE) g[k] = domGlobals[k];
    for (const f of fixtures) f.proc.kill();
  });

  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "a connection %s declared headers lists and calls over streamable HTTP",
    async (_label, headers) => {
      const t = await tools(sel(open, { headers }));
      expect(Object.keys(t).sort()).toEqual([
        "echo",
        "pair",
        "pair07",
        "point",
        "price",
        "refuse",
      ]);
      expect(textOf(await t.echo?.invoke({ q: "olá" }))).toBe('{"q":"olá"}');
    },
  );

  // A server that refuses streamable HTTP with a 4xx other than 404/405 is still reached over SSE,
  // at the same URL and at `/sse` in place of `/mcp`, on both connection paths.
  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "a connection %s declared headers falls back to SSE when HTTP answers 400",
    async (_label, headers) => {
      const t = await tools(sel(refusing, { headers }));
      expect(textOf(await t.echo?.invoke({ q: "sse" }))).toBe('{"q":"sse"}');
      expect(
        refusing.lines.some((l) => l.path === "/sse" && l.request === "GET"),
      ).toBe(true);
    },
  );

  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "an SSE connection %s declared headers lists and calls",
    async (_label, headers) => {
      const t = await tools(
        sel(open, {
          transport: "sse",
          url: `http://127.0.0.1:${open.port}/sse`,
          headers,
        }),
      );
      expect(textOf(await t.echo?.invoke({ q: "x" }))).toBe('{"q":"x"}');
    },
  );

  // A tool call the server reports as failed reaches the model as an error result carrying the
  // server's own words, the way the graph's tool node invokes it (with the call's id).
  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "a server-reported failure %s declared headers reaches the model as an error with its text",
    async (_label, headers) => {
      const t = await tools(sel(open, { headers }));
      const out = (await t.refuse?.invoke({
        name: "refuse",
        args: {},
        id: "call_1",
        type: "tool_call",
      })) as ToolMessage;
      expect(out.status).toBe("error");
      expect(textOf(out)).toContain("upstream refused: quota exceeded");
    },
  );

  // The adapter passes a server's schema through unchanged, `$ref` and `anyOf` included, and the
  // arguments a model fills against it reach the server as sent.
  test("a schema with $ref and anyOf reaches the model as declared and its arguments reach the server", async () => {
    const t = await tools(sel(open));
    const schema = t.price?.schema as Record<string, unknown>;
    expect(JSON.stringify(schema)).toContain('"$ref":"#/$defs/item"');
    const args = { item: { sku: "ÁÇ-1", qty: 2 }, extra: 3 };
    expect(JSON.parse(textOf(await t.price?.invoke(args)))).toEqual(args);
  });

  // A legacy server's draft-07 tuple (`items` as an array) is still callable: the SDK validates the
  // arguments with a 2020-12 validator, which refuses that form before the server is reached.
  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "a draft-07 tuple argument %s declared headers reaches the server",
    async (_label, headers) => {
      const t = await tools(sel(open, { headers }));
      expect(textOf(await t.pair?.invoke({ pair: ["a", 1] }))).toBe(
        '{"pair":["a",1]}',
      );
    },
  );

  // The console's discovery goes through the same client as a turn: a server it can list is one a
  // turn can call, the SSE fallback included.
  test("discovery lists a server that refuses streamable HTTP, with its instructions", async () => {
    const s = sel(refusing);
    const found = await discoverMcpServer(
      s,
      await buildConnConfig(s, { stdioEnabled: false, allowHttp: true }),
    );
    expect(found.tools.map((t) => t.name).sort()).toEqual([
      "echo",
      "pair",
      "pair07",
      "point",
      "price",
      "refuse",
    ]);
    expect(found.instructions).toBe("Fixture instructions.");
  });

  // When the SSE fallback fails too, the error still names the streamable HTTP attempt and its
  // status, so a wrong credential reads as an authentication failure and not as an SSE problem.
  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "a refused credential %s declared headers reports both attempts and the 401",
    async (_label, headers) => {
      const locked = await start({ MCP_REQUIRE_TOKEN: "certo" });
      const s = sel(locked, {
        headers: { ...headers, Authorization: "Bearer errado" },
      });
      const err = await discoverMcpServer(
        s,
        await buildConnConfig(s, { stdioEnabled: false, allowHttp: true }),
      ).then(
        () => null,
        (e: Error) => e,
      );
      expect(err?.message).toContain(
        "failed with HTTP 401 (authentication failed)",
      );
      expect(err?.message).toContain("The SSE fallback at");
      expect(err?.message).not.toContain("errado");
    },
  );

  // A schema that declares draft-07 is validated by the SDK's draft-07 engine, so its tuple stays as
  // written: rewritten to `prefixItems`, `additionalItems: false` would refuse every element.
  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "a tuple under a declared draft-07 %s declared headers reaches the server",
    async (_label, headers) => {
      const t = await tools(sel(open, { headers }));
      expect(textOf(await t.pair07?.invoke({ pair: ["a", 1] }))).toBe(
        '{"pair":["a",1]}',
      );
    },
  );

  // The SDK compiles a tool's output schema inside `callTool`, before the request is sent, so a
  // legacy tuple there would make the tool uncallable.
  test.each([
    ["without", {}],
    ["with", DECLARED],
  ])(
    "a tool whose output schema holds a draft-07 tuple %s declared headers is callable",
    async (_label, headers) => {
      const t = await tools(sel(open, { headers }));
      expect(textOf(await t.point?.invoke({}))).toBe('{"at":[1,2]}');
    },
  );
});
