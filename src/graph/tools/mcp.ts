import { createHash } from "node:crypto";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { type Connection, MultiServerMCPClient } from "@langchain/mcp-adapters";
import logger from "@/api/lib/logger";
import config from "@/config";
import {
  hasSafeStdioCommandChars,
  isMcpStdioLauncher,
  stdioCommandLauncher,
} from "@/lib/mcp-launchers";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import {
  isManagedOAuthKind,
  resolveSecretInjection,
} from "@/modules/vault/secret-types";

// MCP-consumed tools. A McpServerConnection's tools are discovered at connect time, then ONLY the
// per-agent allowlisted subset (AgentToolSelection.enabledTools) is exposed to the model
// (fail-closed: a new upstream tool is never auto-granted). Network transports (http/sse) pass
// the SSRF guard; stdio (local process = RCE) is gated by config.mcpStdioEnabled. The
// MultiServerMCPClient is cached per tenant+connection so we don't reconnect every turn; a config
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

// Builds the MultiServerMCPClient connection config for one selection. Throws (caller skips the
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
  // An uncatalogued kind (legacy string secret / generic) falls back to Bearer, preserving prior
  // behavior.
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
// rather than normalizeToolName, whose "tool" fallback would mask an empty slug.)
//
// A PURE FUNCTION OF THE NAME, and the row id is deliberately not a parameter (#412). The fallback
// used to be `mcp_<connId>`, for the names that yield no usable characters at all — emoji-only,
// CJK-only. `exportAgent` carries the connection by NAME and `importAgent` matches on it, so
// everything else about the exposed name is portable; the id was the one part the import reassigns,
// and the same connection came back on the other side under a different tool name. Hashing the name
// keeps the fallback readable-ish, keeps it unique for the same reason the name is unique
// (`@@unique([tenantId, name])`), and makes it the same on both sides of a transfer.
//
// The digest is of the RAW name, before sanitizing: two different emoji both sanitize to the empty
// string, and hashing the sanitized form would give them one slug and put them back in the collision
// this is meant to take them out of.
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
function exposeMcpTool(
  tool: StructuredToolInterface,
  newName: string,
  server: McpServerMeta,
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
  client: MultiServerMCPClient;
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

// Connects (or reuses a cached client) and returns ALL of the server's tools. The cache key is
// tenant+connection; the hash over the (secret-bearing) config invalidates on rotation.
async function defaultConnect(
  sel: McpSelection,
  opts: McpLoadOpts,
): Promise<StructuredToolInterface[]> {
  const connConfig = await buildConnConfig(sel, {
    stdioEnabled: opts.stdioEnabled ?? config.mcpStdioEnabled,
    allowHttp: opts.allowHttp,
  });
  const key = `${opts.tenantId}:${sel.connId}`;
  const hash = djb2(JSON.stringify(connConfig));
  const cache = clientCache();
  let entry = cache.get(key);
  if (!entry || entry.hash !== hash) {
    // Credential/config changed (or first use) → drop any stale client (closes its transport/process).
    if (entry) void entry.client.close().catch(() => {});
    const client = new MultiServerMCPClient({
      throwOnLoadError: true,
      prefixToolNameWithServerName: false,
      additionalToolNamePrefix: "",
      useStandardContentBlocks: true,
      mcpServers: { [sel.name]: connConfig },
    });
    // `connecting` is assigned on the very next line (synchronously, before any caller can read it).
    const created = { hash, client } as ClientEntry;
    created.connecting = (async () => {
      try {
        // First getTools() establishes the connection (spawns the stdio process / opens the HTTP
        // session) and loads the tool list. Run exactly once; concurrent callers await this promise.
        await client.getTools();
        // Best-effort: capture the server's native `instructions` (MCP initialize result) once, for
        // the prompt-context section. getClient returns the already-connected SDK client.
        try {
          const raw = (await client.getClient(sel.name))?.getInstructions();
          created.instructions =
            typeof raw === "string" && raw.trim() ? raw.trim() : null;
        } catch {
          created.instructions = null;
        }
      } catch (err) {
        // Evict so the next turn rebuilds (no dead client cached) and close the orphaned
        // transport/process. Guard the delete so a newer entry under this key is not clobbered.
        if (cache.get(key) === created) cache.delete(key);
        void client.close().catch(() => {});
        throw err;
      }
    })();
    entry = created;
    cache.set(key, entry);
  }
  // Single-flight the first connect (concurrent cold-start callers share it → one transport), then
  // return the warm tools. getTools() on an already-connected client returns its cached list (no new
  // spawn) and re-runs the connection check, so a reconnect recovers without a config change.
  await entry.connecting;
  return entry.client.getTools();
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
      // Expose each allowed tool under its namespaced name (collision-free across servers) carrying
      // the server context for the prompt section. The bare name was already used for the allowlist.
      for (const tl of allowed) {
        out.push(
          exposeMcpTool(
            tl,
            namespacedToolName(slug, tl.name, usedNames),
            server,
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
