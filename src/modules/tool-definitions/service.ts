import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { requireVaultRef } from "@/modules/vault/service";
import { unsupportedBodyShape } from "./body-shape";
import { normalizeToolShapes } from "./normalize";

// Custom HTTP tool definitions (per-tenant). A definition is the LLM-facing parameter schema +
// the server-trusted wiring (urlTemplate, allowedHosts, headers, credentialRef). The credential is
// referenced by vault name, never inlined; the runtime resolves it and the SSRF guard + origin
// allowlist apply at invoke time. Granting a definition to an agent is a separate concern
// (AgentToolSelection, source=HTTP).

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export interface ToolDefinitionDto {
  id: string;
  name: string;
  label: string;
  description: string | null;
  method: string;
  urlTemplate: string;
  allowedHosts: string[];
  headers: Record<string, unknown>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  credentialRef: string | null;
  enabled: boolean;
  expectedStatuses: number[];
  ackEnabled: boolean;
  ackMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  label: true,
  description: true,
  method: true,
  urlTemplate: true,
  allowedHosts: true,
  headers: true,
  inputSchema: true,
  outputSchema: true,
  query: true,
  body: true,
  credentialRef: true,
  enabled: true,
  expectedStatuses: true,
  ackEnabled: true,
  ackMessage: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDto(r: {
  id: bigint;
  name: string;
  label: string;
  description: string | null;
  method: string;
  urlTemplate: string;
  allowedHosts: string[];
  headers: unknown;
  inputSchema: unknown;
  outputSchema: unknown;
  query: unknown;
  body: unknown;
  credentialRef: string | null;
  enabled: boolean;
  expectedStatuses: number[];
  ackEnabled: boolean;
  ackMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}): ToolDefinitionDto {
  return {
    id: String(r.id),
    name: r.name,
    label: r.label,
    description: r.description,
    method: r.method,
    urlTemplate: r.urlTemplate,
    allowedHosts: r.allowedHosts,
    headers: (r.headers ?? {}) as Record<string, unknown>,
    inputSchema: (r.inputSchema ?? {}) as Record<string, unknown>,
    outputSchema: (r.outputSchema ?? {}) as Record<string, unknown>,
    query: (r.query ?? {}) as Record<string, unknown>,
    body: (r.body ?? {}) as Record<string, unknown>,
    credentialRef: r.credentialRef,
    enabled: r.enabled,
    expectedStatuses: r.expectedStatuses,
    ackEnabled: r.ackEnabled,
    ackMessage: r.ackMessage,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const toolDefinitionCreateSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    label: z.string().min(1).max(200),
    description: z.string().max(2000).nullish(),
    method: z.enum(HTTP_METHODS).optional(),
    urlTemplate: z.string().min(1).max(2000),
    // NOTE: allowedHosts may be empty when urlTemplate is relative (starts with /), because the
    // host comes from the credential's baseUrl; for absolute templates at least one host is required.
    allowedHosts: z.array(z.string().min(1).max(255)).max(50),
    headers: z.record(z.string(), z.unknown()).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
    // Query-string params (Record<string,string> templates), applied for any method.
    query: z.record(z.string(), z.unknown()).optional(),
    // Body shape: { mode: "kv", rows } | { mode: "raw", raw } | legacy { mode: "fields" }, checked
    // by assertSupportedBody below rather than narrowed at runtime (issue #150). The check is not a
    // zod refinement because its whole job is to tell the author what to write instead, and only an
    // AppError reaches them as a message — a zod issue lands in the generic branch.
    body: z.record(z.string(), z.unknown()).optional(),
    credentialRef: z.string().min(1).max(128).nullish(),
    enabled: z.boolean().optional(),
    // Normalized (deduped/sorted, 2xx and out-of-range dropped) rather than rejected: see
    // graph/tools/http-status. Accepts numeric strings, which a JSON body from REST/MCP often carries.
    expectedStatuses: z.array(z.union([z.number(), z.string()])).optional(),
    // Optional "I'll look into that for you…" ack posted to the customer (with a typing indicator)
    // BEFORE this — typically slow — tool runs. Opt-in per tool.
    ackEnabled: z.boolean().optional(),
    ackMessage: z.string().max(2000).nullish(),
  })
  .strict();
export type ToolDefinitionCreate = z.infer<typeof toolDefinitionCreateSchema>;

export const toolDefinitionUpdateSchema = toolDefinitionCreateSchema
  .partial()
  .strict();
export type ToolDefinitionUpdate = z.infer<typeof toolDefinitionUpdateSchema>;

export async function listToolDefinitions(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<ToolDefinitionDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.toolDefinition.findMany({ select: SELECT, orderBy: { name: "asc" } }),
  );
  return rows.map(toDto);
}

export async function getToolDefinition(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ToolDefinitionDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.toolDefinition.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "tool definition not found",
      "errors.toolDefinitionNotFound",
    );
  }
  return toDto(row);
}

async function assertNameFree(
  db: ScopedDb,
  name: string,
  exceptId?: bigint,
): Promise<void> {
  const existing = await db.toolDefinition.findFirst({
    where: { name },
    select: { id: true },
  });
  if (existing && existing.id !== exceptId) {
    throw new ConflictError("tool name already in use", "errors.toolNameTaken");
  }
}

function assertSupportedBody(body: unknown): void {
  const reason = unsupportedBodyShape(body);
  if (reason) throw new AppError(reason, 400);
}

export async function createToolDefinition(
  ctx: TenantContext,
  input: ToolDefinitionCreate,
  base: PrismaClient = basePrisma,
): Promise<ToolDefinitionDto> {
  if (ctx.tenantId === null) {
    throw new AppError("tenant required", 400);
  }
  const tenantId = ctx.tenantId;
  const data = toolDefinitionCreateSchema.parse(input);
  assertSupportedBody(data.body);
  // NOTE: canonicalize programmatic authoring shapes (JSON-Schema inputSchema, single-brace
  // {var}) so storage always holds what the runtime executes.
  const { shapes } = normalizeToolShapes({
    urlTemplate: data.urlTemplate,
    query: data.query,
    headers: data.headers,
    body: data.body,
    inputSchema: data.inputSchema,
  });
  return runScopedOn(base, ctx, async (db) => {
    await assertNameFree(db, data.name);
    const credentialRef = data.credentialRef
      ? await requireVaultRef(db, data.credentialRef)
      : null;
    const row = await db.toolDefinition.create({
      data: {
        tenantId,
        name: data.name,
        label: data.label,
        description: data.description ?? null,
        method: data.method ?? "POST",
        urlTemplate: (shapes.urlTemplate ?? data.urlTemplate) as string,
        allowedHosts: data.allowedHosts,
        headers: (shapes.headers ?? {}) as Prisma.InputJsonValue,
        inputSchema: (shapes.inputSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: (data.outputSchema ?? {}) as Prisma.InputJsonValue,
        query: (shapes.query ?? {}) as Prisma.InputJsonValue,
        body: (shapes.body ?? {}) as Prisma.InputJsonValue,
        credentialRef,
        enabled: data.enabled ?? true,
        expectedStatuses: normalizeExpectedStatuses(data.expectedStatuses),
        ackEnabled: data.ackEnabled ?? false,
        ackMessage: data.ackMessage ?? null,
      },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function updateToolDefinition(
  ctx: TenantContext,
  id: bigint,
  patch: ToolDefinitionUpdate,
  base: PrismaClient = basePrisma,
): Promise<ToolDefinitionDto> {
  const data = toolDefinitionUpdateSchema.parse(patch);
  // NOTE: an absent body is not judged, so a row stored before this check stays editable — only a
  // write that sets the body is refused.
  assertSupportedBody(data.body);
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.toolDefinition.findUnique({
      where: { id },
      select: {
        id: true,
        urlTemplate: true,
        query: true,
        headers: true,
        body: true,
        inputSchema: true,
      },
    });
    if (!current) {
      throw new NotFoundError(
        "tool definition not found",
        "errors.toolDefinitionNotFound",
      );
    }
    if (data.name) await assertNameFree(db, data.name, id);
    // NOTE: canonicalize the patched shapes; the current row supplies the rest so the placeholder
    // allowlist sees the effective field set on partial updates.
    const { shapes } = normalizeToolShapes(
      {
        urlTemplate: data.urlTemplate,
        query: data.query,
        headers: data.headers,
        body: data.body,
        inputSchema: data.inputSchema,
      },
      {
        urlTemplate: current.urlTemplate,
        query: current.query,
        headers: current.headers,
        body: current.body,
        inputSchema: current.inputSchema,
      },
    );
    const patchData: Prisma.ToolDefinitionUpdateInput = {};
    if (data.name !== undefined) patchData.name = data.name;
    if (data.label !== undefined) patchData.label = data.label;
    if (data.description !== undefined)
      patchData.description = data.description ?? null;
    if (data.method !== undefined) patchData.method = data.method;
    if (data.urlTemplate !== undefined)
      patchData.urlTemplate = (shapes.urlTemplate ??
        data.urlTemplate) as string;
    if (data.allowedHosts !== undefined)
      patchData.allowedHosts = data.allowedHosts;
    if (data.headers !== undefined)
      patchData.headers = shapes.headers as Prisma.InputJsonValue;
    if (data.inputSchema !== undefined)
      patchData.inputSchema = shapes.inputSchema as Prisma.InputJsonValue;
    if (data.outputSchema !== undefined)
      patchData.outputSchema = data.outputSchema as Prisma.InputJsonValue;
    if (data.query !== undefined)
      patchData.query = shapes.query as Prisma.InputJsonValue;
    if (data.body !== undefined)
      patchData.body = shapes.body as Prisma.InputJsonValue;
    if (data.credentialRef !== undefined)
      patchData.credentialRef = data.credentialRef
        ? await requireVaultRef(db, data.credentialRef)
        : null;
    if (data.enabled !== undefined) patchData.enabled = data.enabled;
    if (data.expectedStatuses !== undefined)
      patchData.expectedStatuses = normalizeExpectedStatuses(
        data.expectedStatuses,
      );
    if (data.ackEnabled !== undefined) patchData.ackEnabled = data.ackEnabled;
    if (data.ackMessage !== undefined)
      patchData.ackMessage = data.ackMessage ?? null;
    await db.toolDefinition.update({ where: { id }, data: patchData });
    const row = await db.toolDefinition.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function deleteToolDefinition(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const res = await db.toolDefinition.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "tool definition not found",
        "errors.toolDefinitionNotFound",
      );
    }
  });
}

export interface ResourceReferences {
  // Agents that have granted this resource (id for deep-linking to /agents/:id). Deduped.
  agents: { id: string; name: string }[];
}

// Reverse index: which agents granted this HTTP tool (AgentToolSelection.toolDefinitionId), so the
// UI can list usage and warn before deletion. Deduped by agent. Empty when the id isn't found in the
// tenant (RLS-scoped read).
export async function toolReferences(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ResourceReferences> {
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.agentToolSelection.findMany({
      where: { toolDefinitionId: id },
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
