import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { isNativeToolName } from "@/graph/tools/catalog";
import { SANDBOX_CODE_MAX_CHARS } from "@/graph/tools/code-sandbox-limits";
import { normalizeToolName } from "@/graph/tools/toolName";
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
  toolsUnderModelName,
} from "@/modules/tool-definitions/namespace";
import {
  hasReservedFieldName,
  normalizeToolShapes,
} from "@/modules/tool-definitions/normalize";
import {
  type ResourceReferences,
  TOOL_LABEL_MAX,
} from "@/modules/tool-definitions/service";

// Operator-authored code tools (per-tenant), the sibling of tool-definitions/service.ts for the kind
// whose wiring is a JavaScript function body. The model only ever supplies arguments
// (graph/tools/code.ts); granting one to an agent is AgentToolSelection, source=CODE. Invalid code is
// STORED with a warning (lib/code-tool-syntax.ts never refuses): refusing would lock a half-typed body
// out of the one place it can be edited.

export interface CodeToolDto {
  id: string;
  name: string;
  label: string;
  description: string;
  inputSchema: Record<string, unknown>;
  code: string;
  enabled: boolean;
  // A clip of what the body returns is logged at info instead of paging; false is the default.
  silenceTruncationAlert: boolean;
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
  silenceTruncationAlert: true,
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
  silenceTruncationAlert: boolean;
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
    silenceTruncationAlert: r.silenceTruncationAlert,
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
    silenceTruncationAlert: r.silenceTruncationAlert,
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
  silenceTruncationAlert: boolean;
}) {
  const schema = r.inputSchema;
  return {
    name: r.name,
    label: r.label,
    enabled: r.enabled,
    silenceTruncationAlert: r.silenceTruncationAlert,
    inputFieldCount:
      schema && typeof schema === "object" ? Object.keys(schema).length : 0,
  };
}

const UNDISCLOSED = ["description", "inputSchema", "code"] as const;

export const codeToolCreateSchema = z
  .object({
    // Canonicalized on the way in: the name the model is offered is `normalizeToolName(name)` (the
    // console derives it that way, and an HTTP tool's is sanitized at build), so storing another
    // spelling means the row and the model disagree — and two rows that differ only in case would
    // reach the model as ONE name, with the assembly dropping whichever came second.
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .transform(normalizeToolName),
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
    silenceTruncationAlert: z.boolean().optional(),
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

// One namespace reaches the model: a native's name is reserved, and an HTTP tool's name is taken too,
// since `dropDuplicateToolNames` would otherwise decide which of the two the agent gets with a flow-log
// line as the only trace. The HTTP service asks this table the same question.
async function assertNameFree(
  db: ScopedDb,
  name: string,
  exceptId?: bigint,
  // The name the row already carries, on an update. A save that does not MOVE the name skips the
  // namespace rules: the editor sends the whole row on every save, and newer rules must not refuse an
  // unrelated edit to a tool that was legal when created.
  currentName?: string,
): Promise<void> {
  // Compared through `normalizeToolName`, not as text: a row stored as `Search_Knowledge` and the
  // console's normalized label are one identity to the model, so the save is not a rename.
  // `undefined` is a CREATE and always moves; not folded into the comparison because
  // `normalizeToolName("")` is `"tool"`.
  const moving =
    currentName === undefined ||
    normalizeToolName(name) !== normalizeToolName(currentName);
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
  if (moving && isRagToolName(name)) {
    throw new ConflictError(
      "tool name belongs to a built-in tool",
      "errors.toolNameReserved",
      "name",
    );
  }
  const [under, document] = await Promise.all([
    // By the name the MODEL sees, not by the stored spelling: a row written before names were
    // canonicalized reaches the model normalized, and two spellings would then be one name there.
    toolsUnderModelName(db, name),
    // A document template publishes `send_<slug>`, and it is assembled before either tool table.
    moving ? documentHoldingToolName(db, name) : null,
  ]);
  const own = under.codeIds.filter((id) => id !== exceptId);
  if (own.length > 0 || under.httpIds.length > 0 || document) {
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

// Everything `createCodeTool` decides about its INPUT (name pattern, required description, body size)
// before any database is involved, so the MCP preview asks the same question the apply asks.
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

// The half of the verdict that has to READ, so the preview can give it too. ADVISORY: it runs outside
// the write's transaction and can be overtaken; `assertNameFree` inside the tx and the
// `(tenant_id, name)` unique index keep one name to one tool. This only moves the common refusal to
// where the operator asked the question.
export async function assertCodeToolNameAvailable(
  ctx: TenantContext,
  name: string,
  base: PrismaClient = basePrisma,
  // The row being renamed, for an update: a tool keeping its own name is not colliding with itself.
  exceptId?: bigint,
  // ...and the name it carries now, so a preview of a save that does not move the name asks what
  // the apply asks (see `assertNameFree`).
  currentName?: string,
): Promise<void> {
  await runScopedOn(base, ctx, (db) =>
    assertNameFree(db, name, exceptId, currentName),
  );
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
        silenceTruncationAlert: data.silenceTruncationAlert ?? false,
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
    // The namespace lock before the row lock, for the ordering reason `updateToolDefinition` in
    // tool-definitions/service.ts spells out.
    await lockToolNames(db);
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
    if (data.name) await assertNameFree(db, data.name, id, current.name);
    const patchData: Prisma.CodeToolDefinitionUpdateInput = {};
    if (data.name !== undefined) patchData.name = data.name;
    if (data.label !== undefined) patchData.label = data.label;
    if (data.description !== undefined)
      patchData.description = data.description;
    if (data.inputSchema !== undefined)
      patchData.inputSchema = canonicalSchema(data.inputSchema);
    if (data.code !== undefined) patchData.code = data.code;
    if (data.enabled !== undefined) patchData.enabled = data.enabled;
    if (data.silenceTruncationAlert !== undefined)
      patchData.silenceTruncationAlert = data.silenceTruncationAlert;
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
    // NOTE: the namespace lock, before the row, on the DELETE too: an import holds it while resolving
    // a grant and inserting selection rows, and a delete committing in between would fail the whole
    // import transaction (agent, tools, knowledge bases). Serialized, the import either reports
    // `codeGrantNotFound` or never sees the row.
    await lockToolNames(db);
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
