// Headless validation of MCP tools/list by role — builds the per-request server for a read-only,
// a write, and an admin principal over an in-memory transport and asserts scope-gating + the
// secret-by-reference rule of docs/mcp.md on every argument. Listing tools never invokes a handler,
// so this needs no DB/network. Run: bun scripts/mcp-tools-check.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { buildMcpServer } from "@/modules/mcp/server";

type ListedTool = { name: string; inputSchema: unknown };
type Listing = Record<"readOnly" | "write" | "admin", ListedTool[]>;

/** The tools docs/mcp.md allows to take a raw secret, and the argument that carries it. */
export const RAW_SECRET_INPUTS: Record<string, readonly string[]> = {
  deployment_connect: ["admin_token"],
  deployment_rotate_token: ["admin_token"],
  instance_list_accounts: ["admin_token"],
  langfuse_connect: ["secret_key"],
};

/**
 * A field named like a secret carries one, unless the name says it is a vault reference or an id.
 * `token` followed by `s` is a count or a design-token map (`maxHistoryTokens`, `tokens_light`).
 */
const SECRET_FIELD = /secret|token(?!s)|password|passwd|api_?key|private_?key/i;
const NOT_A_SECRET = /(_ref|Ref|_id|Id)$/;

/** A tool name that reads as handing out a secret; `api_key_*` manages keys by id and is not one. */
const SECRET_NAME = /secret|token|password|apikey/i;

/** Every argument path of a tool whose name reads as a raw secret. */
export function secretInputs(tool: ListedTool): string[] {
  const found: string[] = [];
  const walk = (schema: unknown, path: string) => {
    if (!schema || typeof schema !== "object") return;
    const node = schema as Record<string, unknown>;
    const properties = (node.properties ?? {}) as Record<string, unknown>;
    for (const [key, child] of Object.entries(properties)) {
      if (SECRET_FIELD.test(key) && !NOT_A_SECRET.test(key))
        found.push(path + key);
      walk(child, `${path + key}.`);
    }
    walk(node.items, path ? `${path.slice(0, -1)}[].` : "[].");
    for (const key of ["anyOf", "oneOf", "allOf"])
      for (const branch of (node[key] as unknown[] | undefined) ?? [])
        walk(branch, path);
    walk(node.additionalProperties, `${path}*.`);
  };
  walk(tool.inputSchema, "");
  return found;
}

export function auditTools({ readOnly, write, admin }: Listing): string[] {
  const fail: string[] = [];
  const has = (set: ListedTool[], name: string) =>
    set.some((t) => t.name === name);

  if (!has(readOnly, "whoami")) fail.push("read-only missing whoami");
  if (!has(readOnly, "agent_get")) fail.push("read-only missing agent_get");
  if (
    readOnly.some(
      (t) => t.name.endsWith("_create") || t.name.endsWith("_update"),
    )
  )
    fail.push("read-only token exposes a write tool");
  if (!has(write, "agent_create")) fail.push("write missing agent_create");
  if (has(write, "tenant_create"))
    fail.push("write token exposes tenant_create");
  if (!has(admin, "tenant_create")) fail.push("admin missing tenant_create");
  if (!has(admin, "branding_set")) fail.push("admin missing branding_set");

  const rawSecrets = admin.flatMap((t) =>
    secretInputs(t)
      .filter((path) => !RAW_SECRET_INPUTS[t.name]?.includes(path))
      .map((path) => `${t.name}.${path}`),
  );
  if (rawSecrets.length)
    fail.push(
      `raw secret arguments outside docs/mcp.md's exceptions: ${rawSecrets.join(", ")}`,
    );

  // A documented exception takes the secret and never returns it, so its name is already reviewed.
  const readsAsSecret = admin
    .map((t) => t.name)
    .filter((n) => !(n in RAW_SECRET_INPUTS) && SECRET_NAME.test(n));
  if (readsAsSecret.length)
    fail.push(
      `tool names that read as returning a secret: ${readsAsSecret.join(", ")}`,
    );
  return fail;
}

async function toolsFor(principal: VerifiedToken): Promise<ListedTool[]> {
  const server = buildMcpServer(principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "check", version: "0" });
  await client.connect(clientT);
  const { tools } = await client.listTools();
  await client.close();
  return tools.sort((a, b) => a.name.localeCompare(b.name));
}

const base: VerifiedToken = {
  userId: 1n,
  tenantId: 1n,
  role: "TENANT_ADMIN",
  scopes: [],
  clientId: "c",
  jti: "j",
};

async function main() {
  const readOnly = await toolsFor({
    ...base,
    role: "AGENT",
    scopes: ["mcp:read"],
  });
  const write = await toolsFor({ ...base, scopes: ["mcp:read", "mcp:write"] });
  const admin = await toolsFor({
    ...base,
    tenantId: null,
    role: "SUPER_ADMIN",
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
  });
  const fail = auditTools({ readOnly, write, admin });
  const names = (set: ListedTool[]) => set.map((t) => t.name);

  console.log(
    JSON.stringify(
      {
        counts: {
          readOnly: readOnly.length,
          write: write.length,
          admin: admin.length,
        },
        readOnly: names(readOnly),
        writeOnlyAdds: names(write).filter((n) => !names(readOnly).includes(n)),
        adminOnlyAdds: names(admin).filter((n) => !names(write).includes(n)),
        ok: fail.length === 0,
        failures: fail,
      },
      null,
      2,
    ),
  );
  if (fail.length) process.exit(1);
}

if (import.meta.main) await main();
