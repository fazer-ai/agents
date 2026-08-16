// Smoke test for the stdio MCP launchers shipped in the runtime image (Dockerfile): spawn a simple
// MCP server via each launcher, complete the MCP handshake (initialize + tools/list), and report.
// Run INSIDE the image, e.g.:  docker run --rm <image> bun scripts/mcp-stdio-smoke.ts
// Exits non-zero if any launcher fails. Needs network (bunx/uvx download the server on first run).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface Probe {
  launcher: string;
  command: string;
  args: string[];
}

const PROBES: Probe[] = [
  // bunx → npm-published reference server (many tools).
  {
    launcher: "bunx",
    command: "bunx",
    args: ["@modelcontextprotocol/server-everything"],
  },
  // uvx → Python reference server (get_current_time / convert_time).
  { launcher: "uvx", command: "uvx", args: ["mcp-server-time"] },
];

const TIMEOUT_MS = 180_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`${label}: timed out after ${ms}ms`)),
        ms,
      ),
    ),
  ]);
}

async function probe({ launcher, command, args }: Probe): Promise<boolean> {
  const transport = new StdioClientTransport({
    command,
    args,
    stderr: "inherit",
  });
  const client = new Client(
    { name: "fazerai-smoke", version: "0.0.0" },
    { capabilities: {} },
  );
  try {
    await withTimeout(
      client.connect(transport),
      TIMEOUT_MS,
      `${launcher} connect`,
    );
    const { tools } = await withTimeout(
      client.listTools(),
      TIMEOUT_MS,
      `${launcher} listTools`,
    );
    const names = tools.map((t) => t.name);
    console.log(
      `[OK] ${launcher}: ${names.length} tools — ${names.slice(0, 4).join(", ")}${names.length > 4 ? ", …" : ""}`,
    );
    return true;
  } catch (err) {
    console.error(`[FAIL] ${launcher}: ${(err as Error).message}`);
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

const only = process.argv[2];
const selected = only ? PROBES.filter((p) => p.launcher === only) : PROBES;
if (selected.length === 0) {
  console.error(
    `No probe matches "${only}". Known: ${PROBES.map((p) => p.launcher).join(", ")}`,
  );
  process.exit(2);
}

let ok = true;
for (const p of selected) {
  const passed = await probe(p);
  ok = ok && passed;
}
process.exit(ok ? 0 : 1);
