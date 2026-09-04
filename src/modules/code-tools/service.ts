import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { isNativeToolName } from "@/graph/tools/catalog";
import { SANDBOX_CODE_MAX_CHARS } from "@/graph/tools/code-sandbox-limits";
import {
  type CodeSyntaxWarning,
  checkCodeToolSyntax,
} from "@/lib/code-tool-syntax";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { markUndisclosed, undisclosedMoved } from "@/modules/audit/projection";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import {
  documentHoldingToolName,
  isRagToolName,
  lockToolNames,
} from "@/modules/tool-definitions/namespace";
import {
  hasReservedFieldName,
  normalizeToolShapes,
} from "@/modules/tool-definitions/normalize";
import {
  type ResourceReferences,
  TOOL_LABEL_MAX,
} from "@/modules/tool-definitions/service";

// Operator-authored code tools (per-tenant), the sibling of tool-definitions/service.ts for the
// kind whose "wiring" is a JavaScript function body instead of an HTTP request (issue #363). The
// row is the operator's: name, description, the typed input schema and the body. The model only
// ever supplies arguments (graph/tools/code.ts). Granting one to an agent is a separate concern
// (AgentToolSelection, source=CODE).
//
// Invalid code is STORED, with a warning: the static check (lib/code-tool-syntax.ts) answers
// alongside the row and never refuses, and a body that does not parse fails at call time as the
// operator's failure. A save that refused would lock a half-typed body out of the one place it can
// be edited.

export interface CodeToolDto {
  id: string;
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// The list's row: the same thing without the body (see LIST_SELECT).
export type CodeToolListDto = Omit<CodeToolDto, "code">;

export interface CodeToolWriteResult {
  tool: CodeToolDto;
  warnings: CodeSyntaxWarning[];
}

const SELECT = {
  id: true,
  name: true,
  label: true,
  description: true,
  inputSchema: true,
  code: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

// The list never carries the bodies. Each is up to SANDBOX_CODE_MAX_CHARS and a tenant's tools are
// not counted, so a list of forty is most of a megabyte of source that both consumers throw away:
// the console's list shows a name and a badge, and `code_tool_list` deletes the field after loading
// it. Whoever wants a body asks for the row (`getCodeTool`, `code_tool_get`).
export const LIST_SELECT = { ...SELECT, code: false } as const;

interface Row {
  id: bigint;
  name: string;
  label: string;
  description: string;
  inputSchema: unknown;
  code: string;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toListDto(r: Omit<Row, "code">): CodeToolListDto {
  return {
    id: String(r.id),
    name: r.name,
    label: r.label,
    description: r.description,
    inputSchema: (r.inputSchema ?? {}) as Record<string, unknown>,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function toDto(r: Row): CodeToolDto {
  return {
    id: String(r.id),
    name: r.name,
    label: r.label,
    description: r.description,
    inputSchema: (r.inputSchema ?? {}) as Record<string, unknown>,
    code: r.code,
    enabled: r.enabled,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// What the audit row carries: identity, policy and shape. The body is NOT projected — it is the
// operator's program, may be long, and may hold whatever the operator pasted into a comparison —
// nor is the description or the schema; all three are compared (`UNDISCLOSED`) so that an edit to
// any of them still writes the row. `tests/modules/audit-config-families.test.ts` holds the fence:
// it reads this model's columns out of `prisma/schema.prisma` and fails while one is in neither
// half.
function auditProjection(r: {
  name: string;
  label: string;
  description: string;
  inputSchema: unknown;
  code: string;
  enabled: boolean;
}) {
  const schema = r.inputSchema;
  return {
    name: r.name,
    label: r.label,
    enabled: r.enabled,
    inputFieldCount:
      schema && typeof schema === "object" ? Object.keys(schema).length : 0,
  };
}

const UNDISCLOSED = ["description", "inputSchema", "code"] as const;

export const codeToolCreateSchema = z
  .object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    // `.trim()` before the minimum, on both: `min(1)` counts characters, and a label of spaces is a
    // row whose name in the console is blank while a description of spaces is worse — it is the
    // only thing that tells the model when to call the tool, and it would be REQUIRED and empty.
    label: z.string().trim().min(1).max(TOOL_LABEL_MAX),
    // Required, unlike an HTTP tool's: it is the only thing that tells the model when to call.
    description: z.string().trim().min(1).max(2000),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    // NOT trimmed: leading whitespace is a body's own indentation, and the check is only that
    // something is there.
    code: z.string().min(1).max(SANDBOX_CODE_MAX_CHARS),
    enabled: z.boolean().optional(),
  })
  .strict();
export type CodeToolCreate = z.infer<typeof codeToolCreateSchema>;

export const codeToolUpdateSchema = codeToolCreateSchema.partial().strict();
export type CodeToolUpdate = z.infer<typeof codeToolUpdateSchema>;

export async function listCodeTools(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<CodeToolListDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.codeToolDefinition.findMany({
      select: LIST_SELECT,
      orderBy: { name: "asc" },
    }),
  );
  return rows.map(toListDto);
}

export async function getCodeTool(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<CodeToolDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.codeToolDefinition.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError("code tool not found", "errors.codeToolNotFound");
  }
  return toDto(row);
}

// One namespace reaches the model: a native's name is reserved (#457), and an HTTP tool's name is
// taken too, since `dropDuplicateToolNames` would otherwise decide which of the two the agent gets
// with a flow-log line as the only trace. The HTTP service asks this table the same question.
async function assertNameFree(
  db: ScopedDb,
  name: string,
  exceptId?: bigint,
): Promise<void> {
  await lockToolNames(db);
  if (isNativeToolName(name)) {
    throw new ConflictError(
      "tool name belongs to a built-in tool",
      "errors.toolNameReserved",
      "name",
    );
  }
  // RAG's names are built-ins of another kind: the tool exists whenever a knowledge base is granted
  // and it is assembled first, so a code tool under one of those names never reaches the model.
  if (isRagToolName(name)) {
    throw new ConflictError(
      "tool name belongs to a built-in tool",
      "errors.toolNameReserved",
      "name",
    );
  }
  const [own, http, document] = await Promise.all([
    db.codeToolDefinition.findFirst({ where: { name }, select: { id: true } }),
    db.toolDefinition.findFirst({ where: { name }, select: { id: true } }),
    // A document template publishes `send_<slug>`, and it is assembled before either tool table.
    documentHoldingToolName(db, name),
  ]);
  if ((own && own.id !== exceptId) || http || document) {
    throw new ConflictError(
      "tool name already in use",
      "errors.codeToolNameTaken",
      "name",
    );
  }
}

// The stored shape is the compact field map the runtime reads, whatever shape arrived: a
// JSON-Schema-shaped value from REST or MCP converts on write, as an HTTP tool's does.
function canonicalSchema(raw: unknown): Prisma.InputJsonValue {
  const { shapes } = normalizeToolShapes({ inputSchema: raw ?? {} });
  return (shapes.inputSchema ?? {}) as Prisma.InputJsonValue;
}

// Everything `createCodeTool` decides about its INPUT — the name pattern, the required description,
// the body's size — before any database is involved. Split out so the MCP preview can ask the same
// question the apply asks (#490).
export function assertCodeToolCreatable(input: CodeToolCreate): CodeToolCreate {
  assertNoReservedField(input?.inputSchema);
  return parseInput(codeToolCreateSchema, input);
}

// The same, for a PATCH: `updateCodeTool` parses it before it reads anything, so the preview can
// too, and a rename to a name the pattern refuses stops reading as a diff the apply would take.
export function assertCodeToolPatchValid(
  patch: CodeToolUpdate,
): CodeToolUpdate {
  assertNoReservedField(patch?.inputSchema);
  return parseInput(codeToolUpdateSchema, patch);
}

// Refused where it is typed, and refused rather than dropped: the operator asked for a parameter,
// and a schema stored without it would offer the model a tool whose declared argument is missing.
// The import path, which cannot refuse a whole bundle over one field, drops it with a warning
// instead (normalizeToolShapes).
function assertNoReservedField(rawInputSchema: unknown): void {
  if (!hasReservedFieldName(rawInputSchema)) return;
  // BOTH arguments: the bag fills `{{field}}` in the sentence, the last one is what the console keys
  // on to mark the input (parse-input.ts does the same). The bag has to FOLLOW the key with nothing
  // in between, or the sweep in tests/api/error-catalog.test.ts cannot read it.
  throw new AppError(
    "input schema field `__proto__` is reserved by JavaScript and cannot be a parameter name",
    422,
    "errors.invalidRequestValue",
    { field: "inputSchema" },
    "inputSchema",
  );
}

// The half of the verdict that has to READ, so the preview can give it too. ADVISORY, and the word
// is load-bearing: `assertCodeToolCreatable` above judges the input and cannot change its mind,
// while this runs its own scoped read outside the write's transaction and can be overtaken.
// `assertNameFree` INSIDE the tx, and the `(tenant_id, name)` unique index under it, are what keep
// one name to one tool. This only moves the refusal an operator hits almost every time — a native's
// name, or one an HTTP tool already took — to where they asked the question (#490).
export async function assertCodeToolNameAvailable(
  ctx: TenantContext,
  name: string,
  base: PrismaClient = basePrisma,
  // The row being renamed, for an update: a tool keeping its own name is not colliding with itself.
  exceptId?: bigint,
): Promise<void> {
  await runScopedOn(base, ctx, (db) => assertNameFree(db, name, exceptId));
}

export async function createCodeTool(
  ctx: TenantContext,
  input: CodeToolCreate,
  base: PrismaClient = basePrisma,
): Promise<CodeToolWriteResult> {
  if (ctx.tenantId === null) {
    throw new AppError("tenant required", 400);
  }
  const tenantId = ctx.tenantId;
  const data = assertCodeToolCreatable(input);
  const warnings = await checkCodeToolSyntax(data.code);
  const tool = await runScopedOn(base, ctx, async (db) => {
    await assertNameFree(db, data.name);
    const row = await db.codeToolDefinition.create({
      data: {
        tenantId,
        name: data.name,
        label: data.label,
        description: data.description,
        inputSchema: canonicalSchema(data.inputSchema),
        code: data.code,
        enabled: data.enabled ?? true,
      },
      select: SELECT,
    });
    await auditMutation(db, ctx, {
      action: "code_tool.create",
      target: `code_tool:${row.id}`,
      after: auditProjection(row),
    });
    return toDto(row);
  });
  return { tool, warnings };
}

export async function updateCodeTool(
  ctx: TenantContext,
  id: bigint,
  patch: CodeToolUpdate,
  base: PrismaClient = basePrisma,
): Promise<CodeToolWriteResult> {
  const data = assertCodeToolPatchValid(patch);
  const warnings =
    data.code !== undefined ? await checkCodeToolSyntax(data.code) : [];
  const tool = await runScopedOn(base, ctx, async (db) => {
    // Locked before the snapshot the trail compares against (tool-definitions/service.ts explains
    // the interleaving this prevents).
    await db.$queryRaw`SELECT 1 FROM "code_tool_definitions" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.codeToolDefinition.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) {
      throw new NotFoundError("code tool not found", "errors.codeToolNotFound");
    }
    if (data.name) await assertNameFree(db, data.name, id);
    const patchData: Prisma.CodeToolDefinitionUpdateInput = {};
    if (data.name !== undefined) patchData.name = data.name;
    if (data.label !== undefined) patchData.label = data.label;
    if (data.description !== undefined)
      patchData.description = data.description;
    if (data.inputSchema !== undefined)
      patchData.inputSchema = canonicalSchema(data.inputSchema);
    if (data.code !== undefined) patchData.code = data.code;
    if (data.enabled !== undefined) patchData.enabled = data.enabled;
    await db.codeToolDefinition.update({ where: { id }, data: patchData });
    const row = await db.codeToolDefinition.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    const beforeProj = auditProjection(current);
    const afterProj = auditProjection(row);
    const undisclosed = undisclosedMoved(current, row, UNDISCLOSED);
    if (undisclosed || projectionMoved(beforeProj, afterProj)) {
      await auditMutation(db, ctx, {
        action: "code_tool.update",
        target: `code_tool:${id}`,
        before: undisclosed ? markUndisclosed(beforeProj) : beforeProj,
        after: undisclosed ? markUndisclosed(afterProj) : afterProj,
      });
    }
    return toDto(row);
  });
  return { tool, warnings };
}

export async function deleteCodeTool(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    await db.$queryRaw`SELECT 1 FROM "code_tool_definitions" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.codeToolDefinition.findUnique({
      where: { id },
      select: SELECT,
    });
    const res = await db.codeToolDefinition.deleteMany({ where: { id } });
    if (res.count === 0 || !current) {
      throw new NotFoundError("code tool not found", "errors.codeToolNotFound");
    }
    await auditMutation(db, ctx, {
      action: "code_tool.delete",
      target: `code_tool:${id}`,
      before: auditProjection(current),
    });
  });
}

// Reverse index: which agents granted this code tool, so the UI can list usage and warn before
// deletion. Deduped by agent; empty when the id is not in the tenant (RLS-scoped read).
export async function codeToolReferences(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ResourceReferences> {
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.agentToolSelection.findMany({
      where: { codeToolDefinitionId: id },
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
