import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { isNativeToolName } from "@/graph/tools/catalog";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { normalizeToolName } from "@/graph/tools/toolName";
import { parseDbId } from "@/lib/db-id";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  markUndisclosed,
  redactEndpoint,
  refForAudit,
  undisclosedMoved,
} from "@/modules/audit/projection";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import { readAppointmentDeclaration } from "@/modules/tool-definitions/appointment";
import {
  readResponseTemplateResult,
  storableResponseTemplate,
} from "@/modules/tool-definitions/response-template";
import {
  dialableBaseUrl,
  readableVaultRef,
  readVaultRefFacts,
  requireVaultRef,
} from "@/modules/vault/service";
import { unsupportedBodyShape } from "./body-shape";
import {
  documentHoldingToolName,
  isRagToolName,
  lockToolNames,
  toolsUnderModelName,
} from "./namespace";
import { normalizeToolShapes, renderedVariableNames } from "./normalize";

// Custom HTTP tool definitions (per-tenant). A definition is the LLM-facing parameter schema +
// the server-trusted wiring (urlTemplate, allowedHosts, headers, credentialRef). The credential is
// referenced by vault name, never inlined; the runtime resolves it and the SSRF guard + origin
// allowlist apply at invoke time. Granting a definition to an agent is a separate concern
// (AgentToolSelection, source=HTTP).

// The methods a tool definition may carry. Exported because three writers reach that column: this
// module's zod schema (REST + MCP), the agent import, and the editor's one-shot test run.
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpToolMethod = (typeof HTTP_METHODS)[number];

// The method a definition takes when its author named none. Shared with the editor's test run so
// a definition with no method is tested with the same request it is saved as.
export const DEFAULT_HTTP_METHOD: HttpToolMethod = "POST";

// The label's authoring limit, shared with the import's rename: a label it moves must still be
// savable from the console, which validates against this.
export const TOOL_LABEL_MAX = 200;

// The method a caller sent, or null when it is not one of the five. Uppercases first, because the
// runtime does (`def.method.toUpperCase()`) and a hand-written `get` is the same request.
export function readHttpMethod(raw: unknown): HttpToolMethod | null {
  if (typeof raw !== "string") return null;
  const up = raw.trim().toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(up)
    ? (up as HttpToolMethod)
    : null;
}

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
  // What this tool's response declares about an appointment, or null.
  appointment: Record<string, unknown> | null;
  // The GENERIC integration instance this tool hands `{{conversation_ref}}` for, or null.
  conversationRefIntegrationId: string | null;
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
  appointment: true,
  conversationRefIntegrationId: true,
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
  appointment: unknown;
  conversationRefIntegrationId: bigint | null;
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
    // NOTE: verbatim, deliberately not re-read through `readResponseTemplateResult` like `appointment`:
    // that would erase a legacy JSON Schema a caller may still read back. The write already stores
    // a declared template normalized.
    outputSchema: (r.outputSchema ?? {}) as Record<string, unknown>,
    query: (r.query ?? {}) as Record<string, unknown>,
    body: (r.body ?? {}) as Record<string, unknown>,
    // NOTE: the stored value only where it NAMES an entry: a legacy row, written before `requireVaultRef`
    // guarded the writers, may hold a secret VALUE, and this DTO goes out over REST and `mcp:read`.
    credentialRef: readableVaultRef(r.credentialRef),
    enabled: r.enabled,
    expectedStatuses: r.expectedStatuses,
    ackEnabled: r.ackEnabled,
    ackMessage: r.ackMessage,
    // Read back through the same reader the runtime uses, so what the editor shows is what would
    // actually be honored: a declaration the reader refuses reads as none, here as well as there.
    appointment: readAppointmentDeclaration(r.appointment) as Record<
      string,
      unknown
    > | null,
    conversationRefIntegrationId:
      r.conversationRefIntegrationId === null
        ? null
        : String(r.conversationRefIntegrationId),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// What the audit row carries: identity, policy and shape. Every other mutable column is listed in
// `UNDISCLOSED` (compared, never carried); a column in neither half changes without writing a row,
// which `tests/modules/audit-config-families.test.ts` fences. `urlTemplate` is redacted to its
// origin because a token in the path or query is how these templates are actually written. The raw
// `credentialRef` is compared as well, since two different opaque refs project the same.
function auditProjection(r: {
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
  appointment: unknown;
  conversationRefIntegrationId: bigint | null;
}) {
  const cred = refForAudit(r.credentialRef);
  return {
    name: r.name,
    label: r.label,
    method: r.method,
    urlMasked: redactEndpoint(r.urlTemplate),
    // NOTE: the COUNT, not the entries: nothing tells a hostname from a pasted secret (`URL` accepts a
    // token as a host), and this row outlives every correction. The count still shows a widening.
    allowedHostCount: r.allowedHosts.length,
    credentialRef: cred.ref,
    credentialRefOpaque: cred.opaque,
    enabled: r.enabled,
    ackEnabled: r.ackEnabled,
    expectedStatuses: r.expectedStatuses,
    // An id, and the door it names is the point of the trail: a tool starting to hand this
    // conversation to an operator's system is exactly the change a reader of the trail looks for.
    conversationRefIntegrationId:
      r.conversationRefIntegrationId === null
        ? null
        : String(r.conversationRefIntegrationId),
  };
}

// The columns the projection above may not publish, compared and never carried
// (`@/modules/audit/projection`). `urlTemplate` and `credentialRef` are in BOTH halves on purpose:
// what the row shows is the origin and the readable ref, and what moves the trail is the whole
// value, so rotating a token inside the path still records that the tool changed.
const UNDISCLOSED = [
  "allowedHosts",
  "credentialRef",
  "description",
  "urlTemplate",
  "headers",
  "inputSchema",
  "outputSchema",
  "query",
  "body",
  "ackMessage",
  "appointment",
] as const;

export const toolDefinitionCreateSchema = z
  .object({
    // Canonicalized on the way in: `buildHttpTool` offers the model `sanitizeToolName(name)`, so
    // any other spelling stores a name the model never sees, and two spellings collide only there.
    name: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,64}$/)
      .transform(normalizeToolName),
    label: z.string().min(1).max(TOOL_LABEL_MAX),
    description: z.string().max(2000).nullish(),
    method: z.enum(HTTP_METHODS).optional(),
    urlTemplate: z.string().min(1).max(2000),
    // NOTE: allowedHosts may be empty when urlTemplate is relative (starts with /), because the
    // host comes from the credential's baseUrl; for absolute templates at least one host is required.
    allowedHosts: z.array(z.string().min(1).max(255)).max(50),
    headers: z.record(z.string(), z.unknown()).optional(),
    inputSchema: z.record(z.string(), z.unknown()).optional(),
    // What this tool's RESPONSE should look like by the time it reaches the model. Only a declared
    // `mode: "template"` is judged (refused when the reader would not honour it); any other object,
    // such as a legacy JSON Schema written through MCP, is accepted as is.
    outputSchema: z
      .record(z.string(), z.unknown())
      .optional()
      .superRefine((v, ctx) => {
        if (v === undefined) return;
        const r = readResponseTemplateResult(v);
        if (r.declared && !r.ok) {
          ctx.addIssue({ code: "custom", message: r.problem });
        }
      }),
    // Query-string params (Record<string,string> templates), applied for any method.
    query: z.record(z.string(), z.unknown()).optional(),
    // Body shape: { mode: "kv", rows } | { mode: "raw", raw } | legacy { mode: "fields" }, checked
    // by assertSupportedBody rather than a zod refinement: only an AppError reaches the author as a
    // message telling them what to write instead.
    body: z.record(z.string(), z.unknown()).optional(),
    credentialRef: z.string().min(1).max(128).nullish(),
    enabled: z.boolean().optional(),
    // Normalized (deduped/sorted, 2xx and out-of-range dropped) rather than rejected: see
    // graph/tools/http-status. Accepts numeric strings, which a JSON body from REST/MCP often carries.
    expectedStatuses: z.array(z.union([z.number(), z.string()])).optional(),
    // Optional "I'll look into that for you…" ack posted to the customer (with a typing indicator)
    // BEFORE this (typically slow) tool runs. Opt-in per tool.
    ackEnabled: z.boolean().optional(),
    ackMessage: z.string().max(2000).nullish(),
    // What this tool's RESPONSE declares about an appointment. Validated by the reader the runtime
    // uses, so a shape it would silently ignore is rejected instead of stored. Null clears it.
    appointment: z
      .record(z.string(), z.unknown())
      .nullish()
      .refine((v) => v == null || readAppointmentDeclaration(v) !== null, {
        message:
          'appointment must be { action: "book"|"cancel", idPath, startPath (book only), summaryPath?, reminderOffsetsHours?, askConfirmationOnLast? }; a path is dot-separated keys with numeric array indexes, e.g. data.items.0.id',
      }),
    // The GENERIC integration instance this tool hands `{{conversation_ref}}` for. An id, as a
    // string or a number (REST and MCP both carry either). Checked against the tenant's own
    // instances in the service; null clears it.
    conversationRefIntegrationId: z
      .union([z.string().regex(/^[1-9]\d{0,18}$/), z.number().int().positive()])
      .nullish(),
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
  // The name the row carries now. A save that does not MOVE the name is not asking the namespace
  // question, and the console sends the whole row on every save, so an unrelated edit to a tool
  // that was legal when created must not be refused.
  currentName?: string,
): Promise<void> {
  // Compared through the DERIVATION, not as text: a legacy `Search_Knowledge` and the
  // console's `normalizeToolName(label)` are one identity to the model. `undefined` is a CREATE and
  // stays separate, because `normalizeToolName("")` answers `"tool"`.
  const moving =
    currentName === undefined ||
    normalizeToolName(name) !== normalizeToolName(currentName);
  await lockToolNames(db);
  // NOTE: a native's name is reserved at assembly, so a tool under one would never reach the
  // model. Refused where it is typed; the import renames instead (agents/transfer.ts).
  if (isNativeToolName(name)) {
    throw new ConflictError(
      "tool name belongs to a built-in tool",
      "errors.toolNameReserved",
      undefined,
      "name",
    );
  }
  // One namespace reaches the model, so a code tool's name is taken here too (code-tools/service.ts
  // asks this table the same question).
  // RAG publishes its own built-ins, assembled before either tool table (namespace.ts).
  if (moving && isRagToolName(name)) {
    throw new ConflictError(
      "tool name belongs to a built-in tool",
      "errors.toolNameReserved",
      undefined,
      "name",
    );
  }
  const [under, document] = await Promise.all([
    // By the name the MODEL sees (namespace.ts): `buildHttpTool` sanitizes, so a row spelled `Foo`
    // and one spelled `foo` are one tool there.
    toolsUnderModelName(db, name),
    // A document template publishes `send_<slug>`, assembled before this table too.
    moving ? documentHoldingToolName(db, name) : null,
  ]);
  const existing = under.httpIds.filter((id) => id !== exceptId);
  if (existing.length > 0 || under.codeIds.length > 0 || document) {
    throw new ConflictError(
      "tool name already in use",
      "errors.toolNameTaken",
      undefined,
      "name",
    );
  }
}

// A tool that renders `{{conversation_ref}}` has to name the GENERIC instance it hands the handle
// for, and the instance has to be one: refused here rather than accepted and then failing every call.
async function resolveConversationRefIntegration(
  db: ScopedDb,
  raw: string | number | null | undefined,
): Promise<bigint | null> {
  if (raw == null) return null;
  const id = parseDbId(String(raw));
  const instance =
    id === null
      ? null
      : await db.integrationInstance.findUnique({
          where: { id },
          select: { catalogType: true },
        });
  if (id !== null && instance?.catalogType === "GENERIC") return id;
  throw new AppError(
    "conversationRefIntegrationId must name a generic webhook integration of this workspace",
    400,
    "errors.toolConversationRefIntegrationInvalid",
    undefined,
    "conversationRefIntegrationId",
  );
}

function assertConversationRefNamed(
  shapes: Parameters<typeof renderedVariableNames>[0],
  integrationId: bigint | null,
): void {
  // The name belongs to the minted ref: a field of that name would put a value the model (or a
  // constant) chose where the receiver expects the handle, and the callback would never correlate.
  const schema = shapes.inputSchema;
  if (
    schema &&
    typeof schema === "object" &&
    !Array.isArray(schema) &&
    Object.hasOwn(schema, "conversation_ref")
  ) {
    throw new AppError(
      "conversation_ref is reserved for the conversation reference the runtime mints; name the field something else",
      400,
      "errors.toolConversationRefFieldReserved",
      undefined,
      "inputSchema",
    );
  }
  if (integrationId !== null) return;
  if (!renderedVariableNames(shapes).has("conversation_ref")) return;
  throw new AppError(
    "this tool sends {{conversation_ref}}, so it has to name the generic webhook integration the reference is for (conversationRefIntegrationId)",
    400,
    "errors.toolConversationRefIntegrationRequired",
    undefined,
    "conversationRefIntegrationId",
  );
}

// The same two questions for a caller that previews without writing (the MCP dry run), asked in a
// scoped read of their own. ADVISORY, like the other preview checks: the apply asks them again inside
// its own transaction, which is the authority.
export async function assertToolConversationRefResolvable(
  ctx: TenantContext,
  shapes: Parameters<typeof renderedVariableNames>[0],
  rawIntegrationId: string | number | null | undefined,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const id = await resolveConversationRefIntegration(db, rawIntegrationId);
    assertConversationRefNamed(shapes, id);
  });
}

function assertSupportedBody(body: unknown): void {
  const reason = unsupportedBodyShape(body);
  if (reason) throw new AppError(reason, 400);
}

// The placeholders `graph/tools/http.ts` neutralizes before parsing a template, so this asks the
// runtime's question at write time. The single-brace form is here too because `normalizeToolShapes`
// rewrites `{name}` into `{{name}}` AFTER this check, so a host placeholder must be caught in both.
const URL_TEMPLATE_PLACEHOLDER =
  /\{\{\s*[a-zA-Z0-9_]+\s*\}\}|\{\s*[a-zA-Z0-9_]+\s*\}/g;

// Relative (`/path`) is legal and stays legal: the host comes from the credential's baseUrl, which
// this function cannot see and which the runtime resolves per call. What it judges is the shape a
// caller controls entirely.
//
// Three problems and three keys rather than one key and a computed sentence: the catalog answers in
// the reader's language, and a reason built here is English prose that would arrive inside a pt-BR
// template (the rule tests/api/error-catalog.test.ts holds, and the one `refuseUnstorable` follows).
export function urlTemplateProblem(
  urlTemplate: string,
): "not-a-url" | "origin-interpolated" | { protocol: string } | null {
  if (urlTemplate.startsWith("/")) return null;
  const originWith = (filler: string): string | null => {
    try {
      return new URL(urlTemplate.replace(URL_TEMPLATE_PLACEHOLDER, filler))
        .origin;
    } catch {
      return null;
    }
  };
  let parsed: URL;
  try {
    parsed = new URL(urlTemplate.replace(URL_TEMPLATE_PLACEHOLDER, "_"));
  } catch {
    return "not-a-url";
  }
  // NOTE: the scheme the outbound guard allows, refused where it is typed. The guard's other half
  // (private ranges, DNS) is read-backed and time-varying, so it is NOT mirrored here.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { protocol: parsed.protocol };
  }
  // NOTE: the runtime refuses any interpolation that moves the origin, so a placeholder in the
  // origin fails every call. Two fillers tell a host placeholder from a path one: the origin moves.
  if (originWith("aa") !== originWith("bb")) return "origin-interpolated";
  return null;
}

// A relative template (`/path`) needs a credential whose base URL `buildHttpTool` can prepend, or
// the tool throws on its first call. Read through `dialableBaseUrl`, the runtime's own reader: a
// credential kind whose base URL it ignores supplies no host either.
export async function relativeTemplateHasBase(
  db: ScopedDb,
  urlTemplate: string | null | undefined,
  credentialRef: string | null | undefined,
): Promise<boolean> {
  if (typeof urlTemplate !== "string" || !urlTemplate.startsWith("/")) {
    return true;
  }
  const facts = credentialRef
    ? await readVaultRefFacts(db, credentialRef)
    : null;
  return facts != null && dialableBaseUrl(facts.kind, facts.baseUrl) != null;
}

export async function assertRelativeTemplateHasBase(
  db: ScopedDb,
  urlTemplate: string | null | undefined,
  credentialRef: string | null | undefined,
): Promise<void> {
  if (await relativeTemplateHasBase(db, urlTemplate, credentialRef)) return;
  throw new AppError(
    "a urlTemplate starting with / takes its host from the credential's base URL, and no credential here supplies one",
    400,
    "errors.urlTemplateRelativeWithoutBase",
    undefined,
    "urlTemplate",
  );
}

// The preview's half of the rule above. ADVISORY: the check inside the write's transaction is the
// authority, and this one only stops a dry run from approving a row the apply refuses.
export async function assertToolRelativeTemplateResolvable(
  ctx: TenantContext,
  urlTemplate: string | null | undefined,
  credentialRef: string | null | undefined,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, (db) =>
    assertRelativeTemplateHasBase(db, urlTemplate, credentialRef),
  );
}

function assertUsableUrlTemplate(urlTemplate: string | undefined): void {
  if (urlTemplate === undefined) return;
  const problem = urlTemplateProblem(urlTemplate);
  if (problem === null) return;
  if (problem === "not-a-url") {
    throw new AppError(
      "urlTemplate must be an http(s) URL, or a path starting with / when the credential carries a base URL",
      400,
      "errors.urlTemplateNotAUrl",
      undefined,
      "urlTemplate",
    );
  }
  if (problem === "origin-interpolated") {
    throw new AppError(
      "urlTemplate may not put a placeholder in the scheme, host or port: the origin is fixed when the tool is written",
      400,
      "errors.urlTemplateOriginInterpolated",
      undefined,
      "urlTemplate",
    );
  }
  throw new AppError(
    `urlTemplate must be http or https; ${problem.protocol} is not sent by this tool`,
    400,
    "errors.urlTemplateNotHttp",
    { protocol: problem.protocol },
    "urlTemplate",
  );
}

// Everything `createToolDefinition` decides about its INPUT (schema, URL template, body shape)
// before any database is involved, so the MCP preview asks the same question the apply asks.
export function assertToolDefinitionCreatable(input: ToolDefinitionCreate) {
  const data = parseInput(toolDefinitionCreateSchema, input);
  assertSupportedBody(data.body);
  assertUsableUrlTemplate(data.urlTemplate);
  return data;
}

// The half of `createToolDefinition`'s verdict that has to READ, for the preview. ADVISORY: it
// reads outside the write's transaction and can be overtaken; `assertNameFree` inside the tx and
// the unique index are what keep one name to one tool.
export async function assertToolNameAvailable(
  ctx: TenantContext,
  name: string,
  base: PrismaClient = basePrisma,
  // The row being renamed, and the name it carries now: a tool keeping its own name is not
  // colliding with itself, and a save that does not MOVE the name is not asking the newer rules
  // (`assertNameFree`).
  exceptId?: bigint,
  currentName?: string,
): Promise<void> {
  await runScopedOn(base, ctx, (db) =>
    assertNameFree(db, name, exceptId, currentName),
  );
}

// The patch an update would apply, judged before any database is involved (the twin of
// `assertToolDefinitionCreatable`), so the MCP preview asks what the apply asks. An undefined field
// is NOT judged: an MCP patch may name only the description.
export function assertToolDefinitionPatchValid(
  patch: ToolDefinitionUpdate,
): ToolDefinitionUpdate {
  const data = parseInput(toolDefinitionUpdateSchema, patch);
  assertSupportedBody(data.body);
  assertUsableUrlTemplate(data.urlTemplate);
  return data;
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
  const data = assertToolDefinitionCreatable(input);
  // Canonicalize programmatic authoring shapes (JSON-Schema inputSchema, single-brace
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
      ? await requireVaultRef(db, data.credentialRef, "credentialRef")
      : null;
    await assertRelativeTemplateHasBase(
      db,
      (shapes.urlTemplate ?? data.urlTemplate) as string,
      credentialRef,
    );
    const conversationRefIntegrationId =
      await resolveConversationRefIntegration(
        db,
        data.conversationRefIntegrationId,
      );
    assertConversationRefNamed(shapes, conversationRefIntegrationId);
    const row = await db.toolDefinition.create({
      data: {
        tenantId,
        name: data.name,
        label: data.label,
        description: data.description ?? null,
        method: data.method ?? DEFAULT_HTTP_METHOD,
        urlTemplate: (shapes.urlTemplate ?? data.urlTemplate) as string,
        allowedHosts: data.allowedHosts,
        headers: (shapes.headers ?? {}) as Prisma.InputJsonValue,
        inputSchema: (shapes.inputSchema ?? {}) as Prisma.InputJsonValue,
        outputSchema: storableResponseTemplate(
          data.outputSchema,
        ) as Prisma.InputJsonValue,
        query: (shapes.query ?? {}) as Prisma.InputJsonValue,
        body: (shapes.body ?? {}) as Prisma.InputJsonValue,
        credentialRef,
        enabled: data.enabled ?? true,
        expectedStatuses: normalizeExpectedStatuses(data.expectedStatuses),
        ackEnabled: data.ackEnabled ?? false,
        ackMessage: data.ackMessage ?? null,
        // Stored as the READER understands it, not as it arrived: the zod refine above already
        // refused anything unreadable, and normalizing here means the row can never hold a key the
        // runtime would ignore.
        appointment: (readAppointmentDeclaration(data.appointment) ??
          Prisma.DbNull) as unknown as Prisma.InputJsonValue,
        conversationRefIntegrationId,
      },
      select: SELECT,
    });
    await auditMutation(db, ctx, {
      action: "tool.create",
      target: `tool:${row.id}`,
      after: auditProjection(row),
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
  const data = assertToolDefinitionPatchValid(patch);
  return runScopedOn(base, ctx, async (db) => {
    // NOTE: the row is locked before the snapshot the audit trail compares against, or two
    // concurrent PATCHes at READ COMMITTED file a row attributing one's change to the other.
    // The NAMESPACE lock comes first, unconditionally: an agent import takes it before any tool row
    // (agents/transfer.ts), so the reverse order deadlocks. Re-taking it in `assertNameFree` is
    // free (`pg_advisory_xact_lock` is re-entrant within a transaction).
    await lockToolNames(db);
    await db.$queryRaw`SELECT 1 FROM "tool_definitions" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.toolDefinition.findUnique({
      where: { id },
      select: SELECT,
    });
    if (!current) {
      throw new NotFoundError(
        "tool definition not found",
        "errors.toolDefinitionNotFound",
      );
    }
    if (data.name) await assertNameFree(db, data.name, id, current.name);
    // Canonicalize the patched shapes; the current row supplies the rest so the placeholder
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
      patchData.outputSchema = storableResponseTemplate(
        data.outputSchema,
      ) as Prisma.InputJsonValue;
    if (data.query !== undefined)
      patchData.query = shapes.query as Prisma.InputJsonValue;
    if (data.body !== undefined)
      patchData.body = shapes.body as Prisma.InputJsonValue;
    if (data.credentialRef !== undefined)
      patchData.credentialRef = data.credentialRef
        ? await requireVaultRef(db, data.credentialRef, "credentialRef")
        : null;
    // NOTE: the EFFECTIVE pair, patch over stored, judged only when the patch NAMES one of the two,
    // so a legacy row stays editable through everything else.
    if (data.urlTemplate !== undefined || data.credentialRef !== undefined) {
      await assertRelativeTemplateHasBase(
        db,
        patchData.urlTemplate !== undefined
          ? (patchData.urlTemplate as string)
          : current.urlTemplate,
        patchData.credentialRef !== undefined
          ? (patchData.credentialRef as string | null)
          : current.credentialRef,
      );
    }
    if (data.enabled !== undefined) patchData.enabled = data.enabled;
    if (data.expectedStatuses !== undefined)
      patchData.expectedStatuses = normalizeExpectedStatuses(
        data.expectedStatuses,
      );
    if (data.ackEnabled !== undefined) patchData.ackEnabled = data.ackEnabled;
    if (data.ackMessage !== undefined)
      patchData.ackMessage = data.ackMessage ?? null;
    if (data.appointment !== undefined)
      patchData.appointment = (readAppointmentDeclaration(data.appointment) ??
        Prisma.DbNull) as unknown as Prisma.InputJsonValue;
    // The EFFECTIVE pair again, and for the same reason as the relative template above: judged only
    // when the patch names a template or the instance, so a legacy row stays editable elsewhere.
    const nextRefIntegration =
      data.conversationRefIntegrationId !== undefined
        ? await resolveConversationRefIntegration(
            db,
            data.conversationRefIntegrationId,
          )
        : current.conversationRefIntegrationId;
    if (data.conversationRefIntegrationId !== undefined) {
      patchData.conversationRefIntegration =
        nextRefIntegration === null
          ? { disconnect: true }
          : { connect: { id: nextRefIntegration } };
    }
    if (
      data.conversationRefIntegrationId !== undefined ||
      data.urlTemplate !== undefined ||
      data.headers !== undefined ||
      data.query !== undefined ||
      data.body !== undefined ||
      data.inputSchema !== undefined
    ) {
      assertConversationRefNamed(
        {
          urlTemplate: shapes.urlTemplate ?? current.urlTemplate,
          headers: shapes.headers ?? current.headers,
          query: shapes.query ?? current.query,
          body: shapes.body ?? current.body,
          inputSchema: shapes.inputSchema ?? current.inputSchema,
        },
        nextRefIntegration,
      );
    }
    await db.toolDefinition.update({ where: { id }, data: patchData });
    const row = await db.toolDefinition.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    const beforeProj = auditProjection(current);
    const afterProj = auditProjection(row);
    const undisclosed = undisclosedMoved(current, row, UNDISCLOSED);
    // Only when something MOVED: the console PATCHes a whole editor tab per save, so a row per
    // apply would fill the trail with saves that changed nothing (`docs/api-and-fleet.md`).
    if (undisclosed || projectionMoved(beforeProj, afterProj)) {
      await auditMutation(db, ctx, {
        action: "tool.update",
        target: `tool:${id}`,
        before: undisclosed ? markUndisclosed(beforeProj) : beforeProj,
        after: undisclosed ? markUndisclosed(afterProj) : afterProj,
      });
    }
    return toDto(row);
  });
}

export async function deleteToolDefinition(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    // Locked, then read before the delete: after `deleteMany` there is nothing left to name what
    // was removed, and the same lock keeps a concurrent update from making the row describe a
    // definition that never looked like that.
    // The namespace lock on the DELETE too, for the reason `deleteCodeTool` in
    // modules/code-tools/service.ts spells out: an import resolves a grant and inserts the
    // selection rows under this lock, and a delete committing in that window fails a foreign key
    // that has already been read, taking the whole import down with it.
    await lockToolNames(db);
    await db.$queryRaw`SELECT 1 FROM "tool_definitions" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.toolDefinition.findUnique({
      where: { id },
      select: SELECT,
    });
    const res = await db.toolDefinition.deleteMany({ where: { id } });
    if (res.count === 0 || !current) {
      throw new NotFoundError(
        "tool definition not found",
        "errors.toolDefinitionNotFound",
      );
    }
    await auditMutation(db, ctx, {
      action: "tool.delete",
      target: `tool:${id}`,
      before: auditProjection(current),
    });
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
