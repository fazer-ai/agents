import { MultiServerMCPClient } from "@langchain/mcp-adapters";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { buildConnConfig } from "@/graph/tools/mcp";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import {
  hasSafeStdioCommandChars,
  isMcpStdioLauncher,
  MCP_STDIO_LAUNCHERS,
  stdioCommandLauncher,
} from "@/lib/mcp-launchers";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { ensureFreshGoogleAccessToken } from "@/modules/vault/google-oauth";
import { ensureFreshMcpAccessToken } from "@/modules/vault/mcp-oauth";
import { isManagedOAuthKind } from "@/modules/vault/secret-types";
import { requireVaultRef, tryResolveVaultEntry } from "@/modules/vault/service";

// MCP server connections (per-tenant). The connection is the transport + endpoint + a vault
// credential reference; the per-agent allowlist of discovered tools lives in AgentToolSelection
// (source=MCP). `discover` connects to the server (network, OUTSIDE any tx) to list the tool names
// the UI offers for the allowlist. stdio is RCE on the host and gated by config.mcpStdioEnabled.

const TRANSPORTS = ["streamableHttp", "sse", "stdio"] as const;

export interface McpConnectionDto {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  credentialRef: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  transport: true,
  url: true,
  command: true,
  credentialRef: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDto(r: {
  id: bigint;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  credentialRef: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): McpConnectionDto {
  return { ...r, id: String(r.id) };
}

export const mcpConnectionCreateSchema = z
  .object({
    name: z.string().min(1).max(128),
    transport: z.enum(TRANSPORTS),
    url: z.string().url().max(2000).nullish(),
    command: z.string().min(1).max(2000).nullish(),
    credentialRef: z.string().min(1).max(128).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict();
export type McpConnectionCreate = z.infer<typeof mcpConnectionCreateSchema>;

export const mcpConnectionUpdateSchema = mcpConnectionCreateSchema
  .partial()
  .strict();
export type McpConnectionUpdate = z.infer<typeof mcpConnectionUpdateSchema>;

// Validates transport/url/command coherence + (for network transports) SSRF. Network (DNS) lookup
// happens here, BEFORE the tx. `effective` carries the merged post-update values for re-validation.
async function assertTransportValid(effective: {
  transport: string;
  url?: string | null;
  command?: string | null;
}): Promise<void> {
  if (effective.transport === "stdio") {
    if (!config.mcpStdioEnabled) {
      throw new AppError(
        "stdio transport is disabled on this server",
        400,
        "errors.mcpStdioDisabled",
      );
    }
    if (!effective.command) {
      throw new AppError(
        "stdio transport requires a command",
        400,
        "errors.mcpCommandRequired",
      );
    }
    // The command must launch via a runtime we ship in the image (bunx | uvx). Free-form executables
    // are rejected (the env has no Node/npx/python; an arbitrary path is a footgun + drifts from the
    // image contract). The launcher is the first token; the rest is its args.
    if (!isMcpStdioLauncher(stdioCommandLauncher(effective.command))) {
      throw new AppError(
        `stdio command must start with a supported launcher (${MCP_STDIO_LAUNCHERS.join(", ")})`,
        400,
        "errors.mcpLauncherInvalid",
        { launchers: MCP_STDIO_LAUNCHERS.join(", ") },
      );
    }
    // Defense in depth: reject shell metacharacters / control chars / over-long input. The spawn is
    // shell-free (cross-spawn, shell:false), so `; shutdown now` is already inert — but we refuse it
    // outright rather than rely on that one property staying true.
    if (!hasSafeStdioCommandChars(effective.command)) {
      throw new AppError(
        "stdio command contains unsupported characters",
        400,
        "errors.mcpCommandInvalid",
      );
    }
    return;
  }
  if (!effective.url) {
    throw new AppError(
      "http/sse transport requires a url",
      400,
      "errors.mcpUrlRequired",
    );
  }
  await assertSafeOutboundUrl(effective.url);
}

export async function listMcpConnections(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<McpConnectionDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.mcpServerConnection.findMany({
      select: SELECT,
      orderBy: { name: "asc" },
    }),
  );
  return rows.map(toDto);
}

export async function getMcpConnection(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<McpConnectionDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.mcpServerConnection.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "mcp connection not found",
      "errors.mcpConnectionNotFound",
    );
  }
  return toDto(row);
}

async function assertNameFree(
  db: ScopedDb,
  name: string,
  exceptId?: bigint,
): Promise<void> {
  const existing = await db.mcpServerConnection.findFirst({
    where: { name },
    select: { id: true },
  });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError(
      "mcp connection name already in use",
      "errors.mcpNameTaken",
    );
  }
}

export async function createMcpConnection(
  ctx: TenantContext,
  input: McpConnectionCreate,
  base: PrismaClient = basePrisma,
): Promise<McpConnectionDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const data = parseInput(mcpConnectionCreateSchema, input);
  await assertTransportValid(data);
  return runScopedOn(base, ctx, async (db) => {
    await assertNameFree(db, data.name);
    const credentialRef = data.credentialRef
      ? await requireVaultRef(db, data.credentialRef)
      : null;
    const row = await db.mcpServerConnection.create({
      data: {
        tenantId,
        name: data.name,
        transport: data.transport,
        url: data.url ?? null,
        command: data.command ?? null,
        credentialRef,
        enabled: data.enabled ?? true,
      },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function updateMcpConnection(
  ctx: TenantContext,
  id: bigint,
  patch: McpConnectionUpdate,
  base: PrismaClient = basePrisma,
): Promise<McpConnectionDto> {
  const data = parseInput(mcpConnectionUpdateSchema, patch);
  const current = await runScopedOn(base, ctx, (db) =>
    db.mcpServerConnection.findUnique({
      where: { id },
      select: { transport: true, url: true, command: true },
    }),
  );
  if (!current) {
    throw new NotFoundError(
      "mcp connection not found",
      "errors.mcpConnectionNotFound",
    );
  }
  // Re-validate the merged result (SSRF/DNS outside the tx).
  await assertTransportValid({
    transport: data.transport ?? current.transport,
    url: data.url !== undefined ? data.url : current.url,
    command: data.command !== undefined ? data.command : current.command,
  });
  return runScopedOn(base, ctx, async (db) => {
    if (data.name) await assertNameFree(db, data.name, id);
    const credentialRef = data.credentialRef
      ? await requireVaultRef(db, data.credentialRef)
      : null;
    await db.mcpServerConnection.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.transport !== undefined ? { transport: data.transport } : {}),
        ...(data.url !== undefined ? { url: data.url ?? null } : {}),
        ...(data.command !== undefined
          ? { command: data.command ?? null }
          : {}),
        ...(data.credentialRef !== undefined ? { credentialRef } : {}),
        ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      },
    });
    const row = await db.mcpServerConnection.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function deleteMcpConnection(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const res = await db.mcpServerConnection.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "mcp connection not found",
        "errors.mcpConnectionNotFound",
      );
    }
  });
}

export interface McpReferences {
  // Agents that have granted this MCP connection (id for deep-linking to /agents/:id). Deduped.
  agents: { id: string; name: string }[];
}

// Reverse index: which agents granted this MCP connection (AgentToolSelection.mcpServerConnectionId),
// so the UI can list usage and warn before deletion. Deduped by agent. Empty when the id isn't found
// in the tenant (RLS-scoped read).
export async function mcpReferences(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<McpReferences> {
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.agentToolSelection.findMany({
      where: { mcpServerConnectionId: id },
      select: { agent: { select: { id: true, name: true } } },
    });
    const seen = new Map<string, string>();
    for (const r of rows) {
      if (r.agent) seen.set(String(r.agent.id), r.agent.name);
    }
    return {
      agents: [...seen].map(([agentId, name]) => ({ id: agentId, name })),
    };
  });
}

// One discovered tool's parameter, summarized from its JSON Schema property for display in the
// allowlist UI (name + a readable type label + description + whether it is required).
export interface DiscoveredMcpToolArg {
  name: string;
  type: string | null;
  description: string | null;
  required: boolean;
}

// A tool advertised by a remote MCP server: its bare name (exactly how the model sees it — we set
// prefixToolNameWithServerName:false), the model-facing description, and its argument summary.
export interface DiscoveredMcpTool {
  name: string;
  description: string | null;
  args: DiscoveredMcpToolArg[];
}

// Readable type label for one JSON Schema property (enum → "enum", array → "item[]", union → "a | b").
function jsonSchemaTypeLabel(p: {
  type?: unknown;
  enum?: unknown;
  items?: unknown;
}): string | null {
  if (Array.isArray(p.enum) && p.enum.length > 0) return "enum";
  const ty = p.type;
  if (typeof ty === "string") {
    if (ty === "array") {
      const items = p.items as { type?: unknown } | undefined;
      return typeof items?.type === "string" ? `${items.type}[]` : "array";
    }
    return ty;
  }
  if (Array.isArray(ty)) {
    const parts = ty.filter((x): x is string => typeof x === "string");
    return parts.length > 0 ? parts.join(" | ") : null;
  }
  return null;
}

// Summarizes an MCP tool's JSON Schema (DynamicStructuredTool.schema is the raw JSON Schema here,
// not Zod) into a flat arg list for the UI. Non-object / property-less schemas yield no args.
export function summarizeToolArgs(schema: unknown): DiscoveredMcpToolArg[] {
  if (!schema || typeof schema !== "object") return [];
  const s = schema as { properties?: unknown; required?: unknown };
  if (!s.properties || typeof s.properties !== "object") return [];
  const required = new Set(
    Array.isArray(s.required)
      ? s.required.filter((r): r is string => typeof r === "string")
      : [],
  );
  return Object.entries(s.properties as Record<string, unknown>).map(
    ([name, raw]) => {
      const p = (raw && typeof raw === "object" ? raw : {}) as {
        type?: unknown;
        description?: unknown;
        enum?: unknown;
        items?: unknown;
      };
      return {
        name,
        type: jsonSchemaTypeLabel(p),
        description: typeof p.description === "string" ? p.description : null,
        required: required.has(name),
      };
    },
  );
}

// Connects to the server and returns its tools — name, description and argument summary — for the
// per-agent allowlist UI. The scoped read (config + credential) is short; the connect/getTools
// network call happens OUTSIDE the tx.
// Discover result: the server's advertised tools plus its server-level `instructions` (MCP
// initialize result), surfaced so the operator sees the server's scope in the UI (and the agent
// runtime injects it into the prompt). instructions is null when the server advertises none.
export interface DiscoveredMcp {
  tools: DiscoveredMcpTool[];
  instructions: string | null;
}

export async function discoverMcpTools(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<DiscoveredMcp> {
  const sel = await runScopedOn(base, ctx, async (db) => {
    const conn = await db.mcpServerConnection.findUnique({
      where: { id },
      select: {
        name: true,
        transport: true,
        url: true,
        command: true,
        credentialRef: true,
      },
    });
    if (!conn) {
      throw new NotFoundError(
        "mcp connection not found",
        "errors.mcpConnectionNotFound",
      );
    }
    const entry = conn.credentialRef
      ? await tryResolveVaultEntry<unknown>(db, conn.credentialRef)
      : null;
    return {
      ...conn,
      kind: entry?.kind ?? null,
      paramName: entry?.paramName ?? null,
      credentialBaseUrl: entry?.baseUrl ?? null,
      // Managed-OAuth kinds (google_oauth/mcp_oauth) carry a JSON blob, not a string; their access
      // token is refreshed below (outside the tx). Other kinds carry a plain string secret.
      secret:
        !isManagedOAuthKind(entry?.kind) && typeof entry?.secret === "string"
          ? entry.secret
          : null,
    };
  });

  // Managed OAuth (google_oauth/mcp_oauth): refresh the access token outside the tx (network) before
  // connecting, so Discover authenticates the same way a live agent turn does.
  let secret = sel.secret;
  if (isManagedOAuthKind(sel.kind) && sel.credentialRef) {
    const id2 = sel.credentialRef.startsWith("vault:")
      ? BigInt(sel.credentialRef.slice("vault:".length))
      : null;
    if (id2 !== null) {
      secret =
        sel.kind === "mcp_oauth"
          ? await ensureFreshMcpAccessToken(ctx, id2, base)
          : await ensureFreshGoogleAccessToken(ctx, id2, base);
    }
  }

  const connConfig = await buildConnConfig(
    {
      connId: id,
      name: sel.name,
      transport: sel.transport,
      url: sel.url,
      command: sel.command,
      secret,
      credentialBaseUrl: sel.credentialBaseUrl,
      credentialKind: sel.kind,
      credentialParamName: sel.paramName,
      enabledTools: [],
    },
    { stdioEnabled: config.mcpStdioEnabled },
  );
  const client = new MultiServerMCPClient({
    throwOnLoadError: true,
    prefixToolNameWithServerName: false,
    additionalToolNamePrefix: "",
    useStandardContentBlocks: true,
    mcpServers: { [sel.name]: connConfig },
  });
  try {
    const tools = await client.getTools();
    // Best-effort: the server's native `instructions` (MCP initialize result) for the UI scope hint.
    let instructions: string | null = null;
    try {
      const raw = (await client.getClient(sel.name))?.getInstructions();
      instructions = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    } catch {
      instructions = null;
    }
    return {
      instructions,
      tools: tools.map((t) => ({
        name: t.name,
        description:
          typeof t.description === "string" && t.description.length > 0
            ? t.description
            : null,
        args: summarizeToolArgs((t as { schema?: unknown }).schema),
      })),
    };
  } finally {
    await client.close().catch(() => {});
  }
}
