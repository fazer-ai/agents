import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { isNativeToolName } from "@/graph/tools/catalog";
import { normalizeExpectedStatuses } from "@/graph/tools/http-status";
import { normalizeToolName } from "@/graph/tools/toolName";
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
import { normalizeToolShapes } from "./normalize";

// Custom HTTP tool definitions (per-tenant). A definition is the LLM-facing parameter schema +
// the server-trusted wiring (urlTemplate, allowedHosts, headers, credentialRef). The credential is
// referenced by vault name, never inlined; the runtime resolves it and the SSRF guard + origin
// allowlist apply at invoke time. Granting a definition to an agent is a separate concern
// (AgentToolSelection, source=HTTP).

// The methods a tool definition may carry, and EXPORTED because three writers reach that column:
// this module's zod schema (REST + MCP), the agent import, and the editor's one-shot test run. Only
// the first had the list, so the other two could store or issue a method no console can produce.
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpToolMethod = (typeof HTTP_METHODS)[number];

// The method a definition takes when its author named none. EXPORTED for the same reason the
// list is: the create path defaulted here and the editor's test run defaulted to GET, so a
// definition with no method was TESTED as a GET and SAVED as a POST — two different requests
// from one screen, which is exactly what an endpoint justified by "it does what saving does"
// cannot do.
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
  // What this tool's response declares about an appointment, or null (issue #352).
  appointment: Record<string, unknown> | null;
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
    // Verbatim, and DELIBERATELY not re-read through `readResponseTemplateResult` the way
    // `appointment` below is. That normalization exists so the editor never shows a rule the runtime
    // ignores; here it would instead ERASE from the read surface a legacy JSON Schema that some
    // caller wrote and may still be reading back. The write already stores the reader's own shape,
    // so a declared template arrives here normalized anyway.
    outputSchema: (r.outputSchema ?? {}) as Record<string, unknown>,
    query: (r.query ?? {}) as Record<string, unknown>,
    body: (r.body ?? {}) as Record<string, unknown>,
    // The stored value only where it NAMES an entry. `requireVaultRef` has guarded both writers
    // since #126 (dc6c467a), and this module predates that by two months: a row written before it
    // holds whatever the caller sent, most plausibly a secret VALUE from someone who read the field
    // name as "the secret". This DTO goes out over REST and over `mcp:read`, a scope narrower than
    // the console's, so the read is seen by more people than the write ever was (issue #438).
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
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

// What the audit row carries.
//
// Every mutable column of the row is in one of two halves, and the split is the point rather than
// the contents of either. What is PROJECTED is identity, policy and shape — safe to keep in a row
// that is append-only and outlives the definition. Everything else is listed in `UNDISCLOSED`
// below, compared but never carried, so that a change to it still writes the row: a column left out
// of BOTH halves changes without the row noticing, `projectionMoved` sees nothing, and the edit
// writes nothing at all. Review found five such columns on the first pass of this PR.
//
// `urlTemplate` is REDACTED to its origin even though the column holds it whole and every read
// surface returns it whole. The schema accepts any template, and a token in the path or the query
// is how these are actually written — where a value is stored says nothing about whether it is a
// secret, which is the reasoning `redactEndpoint` carries from #397. A relative template has no
// origin to keep, so it masks to nothing; the comparison is what still reports that it moved.
//
// The RAW `credentialRef` is compared as well as projected, and that is not belt-and-braces: two
// different opaque values both project as `{ref: null, opaque: true}`, so swapping one for the
// other would move nothing. `requireVaultRef` has refused that spelling on the way in since #126,
// which makes it a legacy row rather than a reachable write — but the fence answers for columns and
// not for what today's writer happens to allow, and listing it costs one line.
// `tests/modules/audit-config-families.test.ts` holds the fence: it reads the columns of this model
// out of `prisma/schema.prisma` and fails while one is in neither half.
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
}) {
  const cred = refForAudit(r.credentialRef);
  return {
    name: r.name,
    label: r.label,
    method: r.method,
    urlMasked: redactEndpoint(r.urlTemplate),
    // The COUNT, and not the entries. Every entry is `z.string().min(1).max(255)` and nothing more,
    // and no test on the string can tell a hostname an operator meant from a secret they pasted:
    // `ghp_0123`, `xoxb-1-2` and a dotted JWT are all things `URL` will happily call a host. So the
    // same standard `redactEndpoint` applies to a URL applies here — where a value is STORED says
    // nothing about whether it is a secret, and this row outlives every correction. What a reader
    // needs from the trail is that the allowlist WIDENED, which the count says; which hosts it
    // names is on the live read surface, and that one is deletable.
    allowedHostCount: r.allowedHosts.length,
    credentialRef: cred.ref,
    credentialRefOpaque: cred.opaque,
    enabled: r.enabled,
    ackEnabled: r.ackEnabled,
    expectedStatuses: r.expectedStatuses,
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
    // Canonicalized on the way in, for the reason code-tools/service.ts gives: `buildHttpTool`
    // offers the model `sanitizeToolName(name)`, so any other spelling is a row whose name is not
    // the name that reaches the model — and two spellings of one name collide there, not here.
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
    // What this tool's RESPONSE should look like by the time it reaches the model (issue #456).
    // Only `mode: "template"` opts in, and only that shape is judged: this column has been writable
    // through the MCP tool since it existed, unvalidated and read nowhere, so a row may hold a real
    // JSON Schema. Refusing those now would break a published surface for rows that never asked for
    // this feature. A DECLARED template that the reader would not honour is refused rather than
    // stored, for the reason the appointment field below carries: a declaration that looks saved and
    // does nothing is the silence the feature exists to remove.
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
    // What this tool's RESPONSE declares about an appointment (issue #352). Validated by the same
    // reader the runtime uses — a shape it refuses is REJECTED here rather than stored and silently
    // ignored later, because a declaration that looks saved and does nothing is exactly the silence
    // this feature exists to remove. Null clears it.
    appointment: z
      .record(z.string(), z.unknown())
      .nullish()
      .refine((v) => v == null || readAppointmentDeclaration(v) !== null, {
        message:
          'appointment must be { action: "book"|"cancel", idPath, startPath (book only), summaryPath?, reminderOffsetsHours?, askConfirmationOnLast? }; a path is dot-separated keys with numeric array indexes, e.g. data.items.0.id',
      }),
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
  // question, and the console sends the whole row on every save — so the rules added later must not
  // refuse an unrelated edit to a tool that was legal when it was created (code-tools/service.ts
  // carries the same note).
  currentName?: string,
): Promise<void> {
  // Compared through the DERIVATION, not as text. The row may predate canonicalization on write
  // (`Search_Knowledge`), the console submits `normalizeToolName(label)` on every save, and the two
  // spellings are ONE identity to the model. Read as text, that save reads as a rename and meets
  // the namespace rules added later, which refuse an edit that moved nothing (round 29).
  // `undefined` is a CREATE, which always asks the namespace question. Not folded into the
  // comparison: `normalizeToolName("")` answers `"tool"`, so an absent current name would read as
  // unchanged for a tool actually named `tool`.
  const moving =
    currentName === undefined ||
    normalizeToolName(name) !== normalizeToolName(currentName);
  await lockToolNames(db);
  // A native's name is reserved at assembly (#457): a tool written under one would exist in the
  // console, be granted, and never reach the model, with a flow-log line as the only trace. Refused
  // where it is typed, the way a document slug is (documents/slug.ts). The import path does not
  // come through here and renames instead (agents/transfer.ts), as the migration did for rows
  // written before the name was native.
  if (isNativeToolName(name)) {
    throw new ConflictError(
      "tool name belongs to a built-in tool",
      "errors.toolNameReserved",
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
      "name",
    );
  }
}

function assertSupportedBody(body: unknown): void {
  const reason = unsupportedBodyShape(body);
  if (reason) throw new AppError(reason, 400);
}

// The same regex `graph/tools/http.ts` interpolates with, because the question here is that file's
// question asked earlier. A template is not a URL — it carries `{{placeholders}}` the runtime fills
// per call — so the runtime neutralizes them before parsing (`replace(PLACEHOLDER, "_")`) and
// requires the result to be a URL whose origin the interpolation cannot then move. Anything the
// runtime cannot parse is a tool that builds, gets granted, is offered to the model, and THROWS on
// the first call with `tool <name>: invalid urlTemplate` — a raw AppError rather than a failure the
// model can read. Nothing before this refused it, so the row was stored either way (issue #501).
// BOTH spellings, and the second is not decoration (review round 6). `normalizeToolShapes` rewrites
// an OpenAPI-style `{name}` into `{{name}}` when it matches a declared field or a context variable,
// and it does that AFTER this check runs — so a raw `https://api.{contact_id}.example.com/x` parses
// here with the braces left alone, is stored normalized, and the runtime then refuses it on every
// call with `interpolation altered the origin`. Measured. Neutralizing the single-brace form too
// costs no false positive: in a PATH it does not move the origin, and in a HOST a literal brace is
// not a name anything resolves, so the tool could never have called out either way.
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
  // The scheme the outbound guard allows, asked here so a `ftp:`/`mailto:` template is refused where
  // it is typed instead of at the call. The guard's other half — private ranges, DNS — is read-backed
  // and time-varying, so it stays where it is and is NOT mirrored here.
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { protocol: parsed.protocol };
  }
  // The origin is never interpolatable, which the runtime enforces by probing with a neutral filler
  // and comparing the real interpolation's origin against it — so a placeholder ANYWHERE in the
  // origin is a tool that parses here and is refused on every call it will ever make. Two fillers
  // rather than one: what tells a host placeholder apart from a path one is that the origin moves.
  if (originWith("aa") !== originWith("bb")) return "origin-interpolated";
  return null;
}

// The fourth site of the same sentence, and it is read-backed. A template that starts with `/` is
// RELATIVE: `buildHttpTool` prepends the credential's own base URL and, with no base to prepend,
// refuses to build the tool at all — `relative urlTemplate requires a credential with a base URL`,
// thrown before there is a request. The console's form already blocks that pair on save
// (`relativeWithoutBase` in `ToolEditModal`), and the runtime already refuses it, so the row written
// through REST or MCP is the one nothing asks about: it stores, gets granted, is offered to the
// model, and throws on the first call.
//
// `dialableBaseUrl` and not the raw column, because that is the reader the runtime itself uses when
// it assembles the tool: a credential kind whose base URL it ignores supplies no host either.
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

// The preview's half of the rule above. ADVISORY, like every read-backed rule since #490: the check
// inside the write's transaction is the authority, and this one only stops a dry run from approving
// a row the apply refuses.
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

// Everything `createToolDefinition` decides about its INPUT — the schema (the name pattern, the
// URL template, the declared response template) and the body shape — before any database is
// involved. Split out so the MCP preview can ask the same question the apply asks (#490).
export function assertToolDefinitionCreatable(input: ToolDefinitionCreate) {
  const data = parseInput(toolDefinitionCreateSchema, input);
  assertSupportedBody(data.body);
  assertUsableUrlTemplate(data.urlTemplate);
  return data;
}

// The half of `createToolDefinition`'s verdict that has to READ, so the preview can give it too.
// It is ADVISORY, and that word is load-bearing: `assertToolDefinitionCreatable` above judges the
// input and cannot change its mind, while this runs its own scoped read outside the write's
// transaction and can be overtaken. `assertNameFree` INSIDE the tx, and the unique index under it,
// are what actually keep one name to one tool. This only moves the refusal an operator will hit
// almost every time — a name they already used — to where they asked the question (#490).
// `exceptId` for the update path: a tool keeping its own name is not a collision, and omitting it
// would make every rename-to-itself preview refuse a write that succeeds — the inverse divergence,
// which is just as wrong.
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

// The patch an update would apply, judged before any database is involved — the twin of
// `assertToolDefinitionCreatable`, and the reason the MCP preview can show the name the apply will
// store rather than the spelling the caller typed.
//
// It carries the body shape and the url template as well as the schema, because `updateToolDefinition`
// asks all three and the preview has to ask what the apply asks (#490, #501). An undefined field is
// NOT judged, and that is the half a patch makes load-bearing: the console re-sends the whole record
// but an MCP patch that only moves the description names neither, and refusing it would put the
// divergence back inverted — the dry run saying no to a write the apply performs.
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
      ? await requireVaultRef(db, data.credentialRef, "credentialRef")
      : null;
    await assertRelativeTemplateHasBase(
      db,
      (shapes.urlTemplate ?? data.urlTemplate) as string,
      credentialRef,
    );
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
    // LOCKED before the snapshot the trail compares against, which is the rule the audited families
    // already follow (`agents`, `tenants`, `tenant_settings`, branding, the delivery requeue, and
    // the two the #397 round wrote). At READ COMMITTED two concurrent PATCHes both read state A;
    // the first commits B; the second's `update` blocks, wakes and writes C — and files a row
    // saying A became C, attributing B's change to whoever wrote C.
    // The NAMESPACE lock first, and it is an ordering rule rather than a need of this statement.
    // An agent import takes it once, before it touches any tool row (agents/transfer.ts), and reads
    // and writes rows under it. Taking the row lock first here inverts that order and the two
    // deadlock: this transaction holds the row and waits for the namespace, the import holds the
    // namespace and waits for the row (round 29). Unconditional, because a patch that carries no
    // name still locks the row and an order that depends on the payload is not an order.
    // Re-acquiring it inside the name check below costs nothing: `pg_advisory_xact_lock` is
    // re-entrant within a transaction, and every copy is released at commit.
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
    // The EFFECTIVE pair, patch over stored, and only when the patch NAMES one of the two: a save
    // that moves neither the template nor the credential is not a statement about their pairing, so
    // a row written before this rule stays editable through everything else. Same shape as the
    // chunking bound in #524, and the same reason.
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
