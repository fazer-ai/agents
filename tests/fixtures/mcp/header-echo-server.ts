import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// A stateful MCP server on an ephemeral port, in its own process (a client and a server in one Bun
// process do not complete the handshake). It prints one JSON line per HTTP request it receives, and
// its `whoami` tool answers with the headers of the request that called it.

const sessions = new Map<string, StreamableHTTPServerTransport>();

function server() {
  const mcp = new McpServer({ name: "header-echo", version: "1.0.0" });
  mcp.registerTool(
    "whoami",
    {
      description: "Echo the request headers",
      inputSchema: { q: z.string().optional() },
    },
    async (_args, extra) => {
      const h = (extra.requestInfo?.headers ?? {}) as Record<string, string>;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              contact: h["x-contact"] ?? null,
              inbox: h["x-inbox"] ?? null,
              auth: h.authorization ?? null,
            }),
          },
        ],
      };
    },
  );
  return mcp;
}

const http = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(Buffer.from(c)));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : undefined;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    console.log(
      JSON.stringify({
        request: req.method,
        method: body?.method ?? null,
        session: sid ?? null,
        contact: req.headers["x-contact"] ?? null,
        inbox: req.headers["x-inbox"] ?? null,
        auth: req.headers.authorization ?? null,
      }),
    );
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
  });
});
http.listen(0, "127.0.0.1", () => {
  const addr = http.address();
  console.log(
    JSON.stringify({
      port: typeof addr === "object" && addr ? addr.port : null,
    }),
  );
});
