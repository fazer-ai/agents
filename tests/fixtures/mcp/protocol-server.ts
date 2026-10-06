import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// A legacy-protocol MCP server (SDK v1) on an ephemeral port, in its own process. `/mcp` speaks
// streamable HTTP, or answers 400 to every request when started with `MCP_HTTP_REFUSES=1`; `/sse`
// plus `/messages` speak the SSE transport. Its tools are declared with raw JSON Schema, so a
// schema reaches the client exactly as written here. It prints one JSON line per HTTP request.

const PRICE_SCHEMA = {
  type: "object",
  properties: {
    item: { $ref: "#/$defs/item" },
    extra: { anyOf: [{ type: "string" }, { type: "number" }] },
  },
  required: ["item"],
  $defs: {
    item: {
      type: "object",
      properties: { sku: { type: "string" }, qty: { type: "integer" } },
      required: ["sku"],
    },
  },
};

function server() {
  const s = new Server(
    { name: "protocol-fixture", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions: "Fixture instructions." },
  );
  s.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the arguments",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
      {
        name: "refuse",
        description: "Always reports a failure",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "pair",
        description: "Takes a draft-07 tuple",
        inputSchema: {
          type: "object",
          properties: {
            pair: {
              type: "array",
              items: [{ type: "string" }, { type: "number" }],
            },
          },
        },
      },
      {
        name: "pair07",
        description: "Takes a tuple under a declared draft-07",
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          type: "object",
          properties: {
            pair: {
              type: "array",
              items: [{ type: "string" }, { type: "number" }],
              additionalItems: false,
            },
          },
        },
      },
      {
        name: "point",
        description: "Answers a tuple as structured output",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            at: {
              type: "array",
              items: [{ type: "number" }, { type: "number" }],
            },
          },
        },
      },
      {
        name: "price",
        description: "Price an item",
        inputSchema: PRICE_SCHEMA,
      },
    ],
  }));
  s.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "point") {
      return {
        content: [{ type: "text", text: '{"at":[1,2]}' }],
        structuredContent: { at: [1, 2] },
      };
    }
    if (req.params.name === "refuse") {
      return {
        isError: true,
        content: [{ type: "text", text: "upstream refused: quota exceeded" }],
      };
    }
    return {
      content: [
        { type: "text", text: JSON.stringify(req.params.arguments ?? {}) },
      ],
    };
  });
  return s;
}

const refuses = process.env.MCP_HTTP_REFUSES === "1";
const sessions = new Map<string, StreamableHTTPServerTransport>();
const sse = new Map<string, SSEServerTransport>();

function log(line: Record<string, unknown>) {
  console.log(JSON.stringify(line));
}

const http = createServer((req, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    log({ path: url.pathname, request: req.method, method: body?.method });
    if (url.pathname === "/sse" && req.method === "GET") {
      const t = new SSEServerTransport("/messages", res);
      sse.set(t.sessionId, t);
      await server().connect(t);
      return;
    }
    if (url.pathname === "/messages" && req.method === "POST") {
      const t = sse.get(url.searchParams.get("sessionId") ?? "");
      if (!t) {
        res.writeHead(404).end();
        return;
      }
      await t.handlePostMessage(req, res, body);
      return;
    }
    if (url.pathname === "/mcp") {
      if (refuses) {
        res.writeHead(400, { "content-type": "text/plain" }).end("no");
        return;
      }
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let transport = sid ? sessions.get(sid) : undefined;
      if (!transport) {
        const created = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, created);
          },
        });
        transport = created;
        await server().connect(transport);
      }
      await transport.handleRequest(req, res, body);
      return;
    }
    res.writeHead(404).end();
  });
});
http.listen(0, "127.0.0.1", () => {
  const addr = http.address();
  log({ port: typeof addr === "object" && addr ? addr.port : null });
});
