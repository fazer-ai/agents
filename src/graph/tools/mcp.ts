import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { type Connection, loadMcpTools } from "@langchain/mcp-adapters";
import {
  Client,
  SSEClientTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import logger from "@/api/lib/logger";
import config from "@/config";
import { normalizeTupleItems } from "@/graph/gemini-tools";
import {
  hasSafeStdioCommandChars,
  isMcpStdioLauncher,
  stdioCommandLauncher,
} from "@/lib/mcp-launchers";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import {
  type McpHeaders,
  renderMcpHeaders,
} from "@/modules/mcp-connections/headers";
import {
  isManagedOAuthKind,
  resolveSecretInjection,
} from "@/modules/vault/secret-types";

// MCP-consumed tools. A McpServerConnection's tools are discovered at connect time, then ONLY the
// per-agent allowlisted subset (AgentToolSelection.enabledTools) is exposed to the model
// (fail-closed: a new upstream tool is never auto-granted). Network transports (http/sse) pass
// the SSRF guard; stdio (local process = RCE) is gated by config.mcpStdioEnabled. The SDK client
// is cached per tenant+connection so we don't reconnect every turn; a config
// or credential change yields a fresh client. A connection that fails to load is skipped (a down
// MCP server must never silence the bot), never thrown into the reply path.

export interface McpSelection {
  connId: bigint;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  secret: string | null;
  enabledTools: string[];
  // baseUrl from the vault entry referenced by the connection's credentialRef. Takes precedence
  // over sel.url when present, so a self-hosted credential can carry the server address.
  credentialBaseUrl: string | null;
  // The credential's vault kind + ref. For `google_oauth` the stored `secret` is a JSON object, so
  // `secret` is left null at load time and a fresh access token is resolved here (outside the tx)
  // before connecting. null/absent ⇒ `secret` is used as-is (the legacy string-secret path).
  credentialKind?: string | null;
  // Header/query param name for `header`/`query` credential kinds (from VaultEntry.paramName). Used
  // by resolveSecretInjection to name a custom-header / query credential.
  credentialParamName?: string | null;
  credentialRef?: string | null;
  // The connection's declared headers, as templates (modules/mcp-connections/headers.ts). Absent or
  // empty ⇒ no header is added to the call.
  headers?: McpHeaders;
}

export interface McpLoadOpts {
  tenantId: bigint;
  stdioEnabled?: boolean;
  allowHttp?: boolean;
}

function normalizeTransport(t: string): "http" | "sse" | "stdio" {
  const s = t.toLowerCase();
  if (s === "sse") return "sse";
  if (s === "stdio") return "stdio";
  return "http"; // streamablehttp | http | anything else
}

// Builds the adapter connection config for one selection. Throws (caller skips the
// connection) on a disabled stdio transport, a missing url/command, or an SSRF-blocked url.
export async function buildConnConfig(
  sel: McpSelection,
  opts: { stdioEnabled: boolean; allowHttp?: boolean },
): Promise<Connection> {
  const transport = normalizeTransport(sel.transport);
  if (transport === "stdio") {
    if (!opts.stdioEnabled) {
      throw new Error(
        `mcp ${sel.name}: stdio transport disabled (set MCP_STDIO_ENABLED only on a host you control)`,
      );
    }
    if (!sel.command)
      throw new Error(`mcp ${sel.name}: stdio requires a command`);
    // Defense in depth at the EXEC point: re-enforce the launcher allowlist + safe charset here (not
    // only at write time), so a command that reached the DB via a path that skipped validation (e.g.
    // agent import in transfer.ts) is never spawned. The connection is skipped (caller catches) rather
    // than exec'ing an arbitrary binary — the spawn is shell-free, but `rm`/`curl`/… are real binaries.
    if (
      !isMcpStdioLauncher(stdioCommandLauncher(sel.command)) ||
      !hasSafeStdioCommandChars(sel.command)
    ) {
      throw new Error(
        `mcp ${sel.name}: command is not an allowed launcher invocation`,
      );
    }
    const [command, ...args] = sel.command.trim().split(/\s+/);
    // stdio credential = environment variable: the `mcp_env` kind carries the secret (token) + the
    // env var name (paramName). Spawn the process with that single var injected; the adapter merges it
    // over the default-safe env (PATH/HOME/...) so `npx` still resolves. Other kinds (or no credential)
    // spawn with no extra env. Process-level secrets never appear in the `command` string.
    const env =
      sel.credentialKind === "mcp_env" && sel.secret && sel.credentialParamName
        ? { [sel.credentialParamName]: sel.secret }
        : undefined;
    return {
      transport: "stdio",
      command: command as string,
      args,
      env,
    } as Connection;
  }
  const effectiveUrl = sel.credentialBaseUrl ?? sel.url;
  if (!effectiveUrl)
    throw new Error(`mcp ${sel.name}: ${transport} requires a url`);
  await assertSafeOutboundUrl(effectiveUrl, { allowHttp: opts.allowHttp });
  // Apply the credential per its catalogued injection (Bearer / Basic / custom header / query),
  // reusing the shared resolver so MCP authenticates the same way HTTP tools and secret-test do.
  // For managed OAuth (mcp_oauth/google_oauth) sel.secret is the resolved access token → Bearer.
  // An uncatalogued kind (legacy string secret / generic) falls back to Bearer.
  let url = effectiveUrl;
  let headers: Record<string, string> | undefined;
  if (sel.secret) {
    const inj = resolveSecretInjection(
      sel.credentialKind,
      sel.secret,
      sel.credentialParamName,
    );
    if (inj?.target === "header") {
      headers = { [inj.name]: inj.value };
    } else if (inj?.target === "query") {
      const u = new URL(effectiveUrl);
      u.searchParams.set(inj.name, inj.value);
      url = u.toString();
    } else {
      headers = { Authorization: `Bearer ${sel.secret}` };
    }
  }
  return { url, transport, headers } as Connection;
}

export function filterAllowed(
  tools: StructuredToolInterface[],
  allow: string[],
): StructuredToolInterface[] {
  if (allow.length === 0) return [];
  const set = new Set(allow);
  return tools.filter((t) => set.has(t.name));
}

// --- Namespacing + server context -------------------------------------------------------------

// Tool names exposed to the model are namespaced `mcp__<server>__<tool>` so (a) tools from different
// MCP servers never collide and (b) the model can tell an external MCP tool from a native/HTTP one.
// The rename is presentation-only: discovery + the per-agent allowlist still use the bare server-side
// name (filterAllowed runs first), and the tool's func still calls the original tool on its server.
// Names are sanitized + capped at the 64-char tool-name limit shared by the providers we support.
const MCP_NS = "mcp";
const MAX_TOOL_NAME = 64;

// ASCII-safe server segment, derived from the connection's (unique) display name. (Own normalization
// rather than normalizeToolName, whose "tool" fallback would mask an empty slug.) A pure function of
// the NAME, never the row id: export/import match connections by name and reassign ids, so an
// id-based fallback would rename the tool across a transfer. A name with no usable characters falls
// back to a digest of the RAW name, since two emoji-only names sanitize to the same empty string.
export function mcpServerSlug(name: string): string {
  const slug = name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 28);
  return (
    slug || `mcp_${createHash("sha256").update(name).digest("hex").slice(0, 8)}`
  );
}

// `mcp__<slug>__<tool>`, sanitized, unique within `used`, ≤64 chars. To stay under the limit the slug
// is trimmed first (the bare tool name is the informative part); a numeric suffix breaks any residual
// collision (deterministic given selection order).
export function namespacedToolName(
  slug: string,
  toolName: string,
  used: Set<string>,
): string {
  const sep = "__";
  let name = `${MCP_NS}${sep}${slug}${sep}${toolName}`;
  if (name.length > MAX_TOOL_NAME) {
    const room =
      MAX_TOOL_NAME - (MCP_NS.length + sep.length * 2 + toolName.length);
    const trimmed = room > 0 ? slug.slice(0, room) : "";
    name = `${MCP_NS}${sep}${trimmed}${sep}${toolName}`.slice(0, MAX_TOOL_NAME);
  }
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const cand = name.slice(0, MAX_TOOL_NAME - suffix.length) + suffix;
    if (!used.has(cand)) {
      used.add(cand);
      return cand;
    }
  }
}

// Per-tool metadata stamped on every exposed MCP tool, so the prompt builder can group the tools back
// by server and surface its context (label + native `instructions`) — see buildMcpContextSection.
interface McpServerMeta {
  label: string;
  instructions: string | null;
}

// Re-exposes a server tool under its namespaced name WITHOUT mutating the cached original (the client
// cache reuses tool instances across turns). A shallow clone keeps the prototype (so .invoke/.call
// work) and the bound func (which still targets the ORIGINAL tool name on the original server).
// With `call`, the call runs inside `callHeaders`, which is how the connection's shared transport
// learns the headers of THIS conversation (see fetchWithCallHeaders).
function exposeMcpTool(
  tool: StructuredToolInterface,
  newName: string,
  server: McpServerMeta,
  call?: CallHeaders,
): StructuredToolInterface {
  const clone = Object.create(Object.getPrototypeOf(tool)) as Record<
    string,
    unknown
  >;
  Object.assign(clone, tool);
  clone.name = newName;
  clone.metadata = {
    ...((tool as { metadata?: Record<string, unknown> }).metadata ?? {}),
    mcpServer: server,
  };
  const func = (tool as unknown as { func?: (...a: unknown[]) => unknown })
    .func;
  if (call && typeof func === "function") {
    clone.func = (...args: unknown[]) =>
      callHeaders.run(call, () => func.apply(tool, args));
  }
  return clone as unknown as StructuredToolInterface;
}

// Builds the system-prompt block that gives the agent each MCP server's scope. Scans the assembled
// toolset for the mcpServer metadata, groups by server, and emits the server's native `instructions`
// (MCP initialize result) when present plus the list of its exposed tool names. Returns null when no
// MCP tool is present. Injected at graph-build time so turn / nudge / playground all get it.
export function buildMcpContextSection(
  tools: StructuredToolInterface[],
): string | null {
  const byServer = new Map<
    string,
    { instructions: string | null; tools: string[] }
  >();
  for (const t of tools) {
    const meta = (t as { metadata?: { mcpServer?: McpServerMeta } }).metadata
      ?.mcpServer;
    if (!meta) continue;
    const entry = byServer.get(meta.label) ?? {
      instructions: meta.instructions,
      tools: [],
    };
    entry.tools.push(t.name);
    byServer.set(meta.label, entry);
  }
  if (byServer.size === 0) return null;
  const lines = [
    "## Ferramentas externas (MCP)",
    "Você tem acesso a ferramentas de servidores MCP externos. O nome de cada uma segue o padrão `mcp__<servidor>__<ferramenta>`.",
  ];
  for (const [label, entry] of byServer) {
    lines.push("", `### ${label}`);
    if (entry.instructions) lines.push(entry.instructions);
    lines.push(`Ferramentas: ${entry.tools.join(", ")}`);
  }
  return lines.join("\n");
}

interface ClientEntry {
  hash: string;
  // The server's tools (a warm client answers from its cached list), and the teardown.
  tools: () => Promise<StructuredToolInterface[]>;
  close: () => Promise<void>;
  // Coalesced FIRST connect: every concurrent caller awaits this single promise, so a cold-start
  // burst establishes EXACTLY ONE transport (no double-spawn / orphaned stdio process). It resolves
  // void once connected; callers then call getTools() (cheap + warm, re-probing liveness). On
  // rejection the entry evicts itself (see defaultConnect) so the next turn recreates instead of
  // caching a dead client. The cache check-and-set that creates this is synchronous (single-threaded),
  // so only the first concurrent caller builds it; the rest reuse this promise.
  connecting: Promise<void>;
  // The server's MCP `instructions` (initialize result), captured once per client lifetime for the
  // prompt-context section. undefined = not fetched yet; null = fetched, server advertised none.
  instructions?: string | null;
}

// Reads the cached server `instructions` for a connection (populated by defaultConnect). Returns null
// when the connection used an injected connect (tests) or the server advertised none.
function cachedInstructions(tenantId: bigint, connId: bigint): string | null {
  return clientCache().get(`${tenantId}:${connId}`)?.instructions ?? null;
}

const CACHE_KEY = Symbol.for("fazerai.mcp.clients");

function clientCache(): Map<string, ClientEntry> {
  const g = globalThis as unknown as Record<symbol, Map<string, ClientEntry>>;
  g[CACHE_KEY] ??= new Map();
  return g[CACHE_KEY];
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}

// The headers of the tool call in flight, for the connection `key` names. Set around a tool's func
// by exposeMcpTool and read by the connection's own fetch, so one shared client and MCP session
// serves every conversation and each request still carries its own conversation's values. Nothing
// sets it during connect or tools/list, which therefore go out without them.
interface CallHeaders {
  key: string;
  headers: McpHeaders;
}
const CALL_HEADERS_KEY = Symbol.for("fazerai.mcp.callHeaders");

// Lives on globalThis beside the client cache: a cached transport keeps the storage it was built
// with, so under `bun --hot` a module-local instance would leave it reading one nobody sets.
const callHeaders: AsyncLocalStorage<CallHeaders> = (() => {
  const g = globalThis as unknown as Record<
    symbol,
    AsyncLocalStorage<CallHeaders>
  >;
  g[CALL_HEADERS_KEY] ??= new AsyncLocalStorage<CallHeaders>();
  return g[CALL_HEADERS_KEY];
})();

// A header the transport already set (the credential, the session id, the content type) is kept:
// a declared header never replaces it.
function fetchWithCallHeaders(key: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const call = callHeaders.getStore();
    if (!call || call.key !== key) return fetch(input, init);
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(call.headers)) {
      if (!headers.has(name)) headers.set(name, value);
    }
    return fetch(input, { ...init, headers });
  }) as typeof fetch;
}

export const __callHeadersForTest = { callHeaders, fetchWithCallHeaders };

// The SDK's HTTP error carries the status in `data.status` (its `code` is a string category), and
// older errors carry it as a numeric `code` or in the message.
function httpErrorCode(err: unknown): number | null {
  const e = err as {
    code?: unknown;
    message?: unknown;
    data?: { status?: unknown };
  };
  if (typeof e?.data?.status === "number") return e.data.status;
  if (typeof e?.code === "number") return e.code;
  const m = String(e?.message ?? "").match(/\(HTTP (\d\d\d)\)/);
  return m ? Number(m[1]) : null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The adapter's fallback for a server that answers streamable HTTP with a 4xx: SSE at the same URL,
// then at `/sse` in place of a trailing `/mcp`. Kept so a connection behaves the same with or
// without declared headers.
function sseFallbackUrls(url: string): string[] {
  const u = new URL(url);
  const parts = u.pathname.split("/");
  if (parts.at(-1) !== "mcp") return [url];
  parts[parts.length - 1] = "sse";
  u.pathname = parts.join("/");
  return [url, u.toString()];
}

// A schema in the dialect the SDK validates it with. One that declares `$schema` is compiled by that
// dialect's engine and kept as is. One that declares none is compiled as 2020-12, which refuses a
// draft-07 tuple (`items` as an array), so those are rewritten to `prefixItems`.
function forSdkValidator<T>(schema: T): T {
  if (!schema || typeof schema !== "object" || "$schema" in schema)
    return schema;
  return normalizeTupleItems(schema) as T;
}

// The server's tool list with each input and output schema in that dialect: the adapter validates a
// call's arguments against the input schema, and the SDK compiles the output schema inside
// `callTool`, both before the server is reached.
function withDraft2020Tuples(client: Client): void {
  const listTools = client.listTools.bind(client);
  client.listTools = (async (...args: Parameters<Client["listTools"]>) => {
    const listed = await listTools(...args);
    return {
      ...listed,
      tools: listed.tools.map((t) => ({
        ...t,
        inputSchema: forSdkValidator(t.inputSchema),
        ...(t.outputSchema
          ? { outputSchema: forSdkValidator(t.outputSchema) }
          : {}),
      })),
    };
  }) as Client["listTools"];
}

// One connection on its own SDK client, for every transport. An SDK 2 `Client` negotiates the legacy
// protocol by default, so no elicitation request can turn into an interrupt no turn resumes. Its HTTP
// transports get a `fetch` that adds the declared headers of the tool call in flight.
async function connectClient(
  sel: McpSelection,
  connConfig: Connection,
  key: string,
): Promise<{ client: Client; tools: StructuredToolInterface[] }> {
  const open = async (
    transport:
      | StreamableHTTPClientTransport
      | SSEClientTransport
      | StdioClientTransport,
  ) => {
    const client = new Client({ name: "fazer-ai-agents", version: "1" });
    withDraft2020Tuples(client);
    try {
      await client.connect(transport);
      const tools = await loadMcpTools(sel.name, client, {
        throwOnLoadError: true,
        prefixToolNameWithServerName: false,
        additionalToolNamePrefix: "",
      });
      return { client, tools };
    } catch (err) {
      void client.close().catch(() => {});
      throw err;
    }
  };
  if (connConfig.transport === "stdio") {
    const { command, args, env } = connConfig as {
      command: string;
      args: string[];
      env?: Record<string, string>;
    };
    return open(new StdioClientTransport({ command, args, env }));
  }
  const { url, headers } = connConfig as {
    url: string;
    headers?: Record<string, string>;
  };
  const opts = {
    ...(headers ? { requestInit: { headers } } : {}),
    fetch: fetchWithCallHeaders(key),
  };
  if (normalizeTransport(sel.transport) === "sse") {
    return open(new SSEClientTransport(new URL(url), opts));
  }
  try {
    return await open(new StreamableHTTPClientTransport(new URL(url), opts));
  } catch (err) {
    const code = httpErrorCode(err);
    if (code === null || code < 400 || code >= 500) throw err;
    let last: unknown = err;
    for (const sseUrl of sseFallbackUrls(url)) {
      try {
        return await open(new SSEClientTransport(new URL(sseUrl), opts));
      } catch (e) {
        last = e;
      }
    }
    // NOTE: no URL in the message: a query-injected credential lives there, and this error reaches
    // the logs and the alert channels.
    throw new Error(
      `streamable HTTP failed with HTTP ${code}${code === 401 ? " (authentication failed)" : ""}: ${errorText(err)}. The SSE fallback failed too: ${errorText(last)}`,
      { cause: last },
    );
  }
}

// A one-off connection for the console's discovery: the same client a turn uses, closed after
// listing, so a server the console can list is one a turn can call.
export async function discoverMcpServer(
  sel: McpSelection,
  connConfig: Connection,
): Promise<{ tools: StructuredToolInterface[]; instructions: string | null }> {
  const { client, tools } = await connectClient(
    sel,
    connConfig,
    `discover:${sel.connId}`,
  );
  try {
    const raw = client.getInstructions();
    return {
      tools,
      instructions: typeof raw === "string" && raw.trim() ? raw.trim() : null,
    };
  } finally {
    await client.close().catch(() => {});
  }
}

// Connects (or reuses a cached client) and returns ALL of the server's tools. The cache key is
// tenant+connection; the hash over the (secret-bearing) config and the header TEMPLATES invalidates
// on rotation or edit. The resolved header values never enter it: they differ per conversation and
// ride on each call instead.
async function defaultConnect(
  sel: McpSelection,
  opts: McpLoadOpts,
): Promise<StructuredToolInterface[]> {
  const connConfig = await buildConnConfig(sel, {
    stdioEnabled: opts.stdioEnabled ?? config.mcpStdioEnabled,
    allowHttp: opts.allowHttp,
  });
  const key = `${opts.tenantId}:${sel.connId}`;
  const declared =
    connConfig.transport !== "stdio" &&
    Object.keys(sel.headers ?? {}).length > 0;
  const hash = djb2(
    JSON.stringify({ connConfig, headers: declared ? sel.headers : null }),
  );
  const cache = clientCache();
  let entry = cache.get(key);
  if (!entry || entry.hash !== hash) {
    // Credential/config changed (or first use) → drop any stale client (closes its transport/process).
    if (entry) void entry.close().catch(() => {});
    // The fields are assigned below, synchronously, before any caller can read the entry.
    const created = { hash } as ClientEntry;
    const evict = () => {
      if (cache.get(key) === created) cache.delete(key);
    };
    let own: { client: Client; tools: StructuredToolInterface[] } | null = null;
    created.tools = async () => own?.tools ?? [];
    created.close = async () => {
      await own?.client.close();
    };
    // Run exactly once; concurrent cold-start callers await this promise and share one transport.
    created.connecting = (async () => {
      try {
        own = await connectClient(sel, connConfig, key);
        // NOTE: a dropped session or exited process is not reused: the next turn opens a new one.
        own.client.onclose = evict;
        const raw = own.client.getInstructions();
        created.instructions =
          typeof raw === "string" && raw.trim() ? raw.trim() : null;
      } catch (err) {
        evict();
        throw err;
      }
    })();
    entry = created;
    cache.set(key, entry);
  }
  await entry.connecting;
  return entry.tools();
}

export type McpConnect = (
  sel: McpSelection,
  opts: McpLoadOpts,
) => Promise<StructuredToolInterface[]>;

export interface McpLoadDeps {
  connect?: McpConnect;
  stdioEnabled?: boolean;
  allowHttp?: boolean;
  // Resolves a fresh bearer token for a credential ref (used for `google_oauth` selections, whose
  // token must be refreshed outside the tx before connecting). Injectable for tests. When absent,
  // a `google_oauth` selection connects without a credential (degrades, never throws into the reply).
  refreshCredential?: (tenantId: bigint, ref: string) => Promise<string | null>;
  // Resolves the server's `instructions` for the prompt-context section. Injectable for tests; when
  // absent the default reads what defaultConnect captured from the live server (null otherwise).
  instructionsFor?: (sel: McpSelection) => Promise<string | null>;
  // Invoked (best-effort) when a connection's discovery throws — after the warn log, before the skip.
  // Lets the caller surface the failure (flowlog warn + alert) without coupling this module to the
  // observability layer. Never throws into the turn; the reply still degrades gracefully.
  onDiscoverError?: (sel: McpSelection, err: unknown) => void;
  // The turn's conversation variables (the ones an HTTP tool's placeholders read), which a
  // connection's declared headers resolve against. Absent ⇒ every placeholder renders empty.
  context?: Record<string, string>;
}

// Loads the agent's MCP tools across its selections, filtered to each connection's allowlist.
// Resilient: a connection that errors (down server, SSRF block, disabled stdio) is logged and
// skipped — its absence degrades capability, never the reply.
export async function loadMcpToolsForAgent(
  tenantId: bigint,
  selections: McpSelection[],
  deps: McpLoadDeps = {},
): Promise<StructuredToolInterface[]> {
  if (selections.length === 0) return [];
  const connect = deps.connect ?? defaultConnect;
  const opts: McpLoadOpts = {
    tenantId,
    stdioEnabled: deps.stdioEnabled,
    allowHttp: deps.allowHttp,
  };
  const out: StructuredToolInterface[] = [];
  // Tracks every exposed name so the namespacing stays unique across all of the agent's MCP servers.
  const usedNames = new Set<string>();
  for (const sel of selections) {
    if (sel.enabledTools.length === 0) continue; // fail-closed
    try {
      // Managed-OAuth selections (google_oauth, mcp_oauth) carry no string secret at load time;
      // refresh the access token here (outside the tx) and inject it as the bearer secret.
      let effective = sel;
      if (isManagedOAuthKind(sel.credentialKind) && sel.credentialRef) {
        const token = deps.refreshCredential
          ? await deps.refreshCredential(tenantId, sel.credentialRef)
          : null;
        effective = { ...sel, secret: token };
      }
      const tools = await connect(effective, opts);
      const allowed = filterAllowed(tools, effective.enabledTools);
      const instructions = deps.instructionsFor
        ? await deps.instructionsFor(effective).catch(() => null)
        : cachedInstructions(tenantId, sel.connId);
      const slug = mcpServerSlug(sel.name);
      const server: McpServerMeta = {
        label: sel.name,
        instructions: instructions ?? null,
      };
      const call: CallHeaders | undefined =
        Object.keys(sel.headers ?? {}).length > 0
          ? {
              key: `${tenantId}:${sel.connId}`,
              headers: renderMcpHeaders(sel.headers ?? {}, deps.context ?? {}),
            }
          : undefined;
      // Expose each allowed tool under its namespaced name (collision-free across servers) carrying
      // the server context for the prompt section. The bare name was already used for the allowlist.
      for (const tl of allowed) {
        out.push(
          exposeMcpTool(
            tl,
            namespacedToolName(slug, tl.name, usedNames),
            server,
            call,
          ),
        );
      }
    } catch (err) {
      logger.warn({ err, mcp: sel.name }, "mcp tool load failed; skipping");
      deps.onDiscoverError?.(sel, err);
    }
  }
  return out;
}
