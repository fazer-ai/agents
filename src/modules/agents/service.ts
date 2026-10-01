import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import { broadcastAgentConfigEvent } from "@/api/features/realtime/realtime.service";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { DEFAULT_MODEL_CONFIG, modelConfigSchema } from "@/graph/model-config";
import { modelOptionalFor } from "@/graph/model-defaults";
import {
  CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES,
  GRANTABLE_NATIVE_TOOL_NAMES,
  NATIVE_TOOL_NAMES,
  RAG_TOOL_NAMES,
} from "@/graph/tools/catalog";
import { parseDbId, requireDbId } from "@/lib/db-id";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  agentUpdateAudit,
  auditSafe,
  grantSetChanged,
} from "@/modules/agents/audit-projection";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import { collectCredentialRefWrites } from "@/modules/agents/credential-paths";
import { protectedResolveLabels } from "@/modules/agents/resolve-labels";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { collectOversizedTextChanges } from "@/modules/agents/text-caps";
import {
  ALLOWED_LABELS_MAX,
  PROTECTED_LABELS_MAX,
  readProtectedLabels,
} from "@/modules/agents/tool-guidance";
import {
  invalidToolPreconditions,
  parseToolPrecondition,
} from "@/modules/agents/tool-preconditions";
import { auditMutation } from "@/modules/audit/service";
import { isOutOfHoursNow, parseSchedule } from "@/modules/business-hours/hours";
import { renameAgentBots } from "@/modules/chatwoot/provisioning";
import { invalidateRouteTokenCache } from "@/modules/chatwoot/route-token-cache";
import { invalidContactAuthRule } from "@/modules/contact-auth/settings";
import { documentToolName } from "@/modules/documents/slug";
import { parseTemplateContent } from "@/modules/documents/validate";
import {
  FULL_DETAIL_MAX_HOURS,
  isFullDetailWindowOpen,
  parseIsoInstant,
} from "@/modules/flowlog/settings";
import { ensureTenantSweep } from "@/modules/followups/handlers";
import { readFollowUpConfig } from "@/modules/followups/settings";
import { normalizeSettingsForStorage } from "@/modules/images/settings";
import { getCatalogEntry } from "@/modules/integrations/catalog";
import {
  getToolpackToolNames,
  getToolpackToolViews,
} from "@/modules/integrations/toolpacks";
import { isOneOf, SIGNATURE_CHOICES } from "@/modules/signature/domains";
import { lockToolNames } from "@/modules/tool-definitions/namespace";
import { requireVaultRefFor } from "@/modules/vault/service";
import {
  AGENT_MODES,
  type AgentMode,
  isMonitoring,
  normalizeAgentMode,
} from "./mode";

// Agent configuration CRUD — the config the whole system orbits (the same core the UI config
// screen and the MCP `prompt_get/set` tools project over). All reads/writes are tenant-scoped;
// updates touch only an explicit allowlist of fields (never tenantId/id).

// Agent operating mode (item 1): a "test" agent stays silent in a conversation until /teste; a
// "production" agent answers normally; a "monitoring" agent never answers (./mode.ts). New agents
// are created in "test".
export { AGENT_MODES, type AgentMode } from "./mode";

export interface AgentDto {
  id: string;
  name: string;
  systemPrompt: string;
  modelConfig: Record<string, unknown>;
  businessHoursId: string | null;
  followUpHoursId: string | null;
  transferWithSummary: boolean;
  enabled: boolean;
  mode: AgentMode;
  settings: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export const AGENT_SELECT = {
  id: true,
  name: true,
  systemPrompt: true,
  modelConfig: true,
  businessHoursId: true,
  followUpHoursId: true,
  transferWithSummary: true,
  enabled: true,
  mode: true,
  settings: true,
  createdAt: true,
  updatedAt: true,
} as const;

export function toDto(a: {
  id: bigint;
  name: string;
  systemPrompt: string;
  modelConfig: unknown;
  businessHoursId: bigint | null;
  followUpHoursId: bigint | null;
  transferWithSummary: boolean;
  enabled: boolean;
  mode: string;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
}): AgentDto {
  return {
    id: String(a.id),
    name: a.name,
    systemPrompt: a.systemPrompt,
    modelConfig: (a.modelConfig ?? {}) as Record<string, unknown>,
    businessHoursId:
      a.businessHoursId === null ? null : String(a.businessHoursId),
    followUpHoursId:
      a.followUpHoursId === null ? null : String(a.followUpHoursId),
    transferWithSummary: a.transferWithSummary,
    enabled: a.enabled,
    mode: normalizeAgentMode(a.mode),
    settings: (a.settings ?? {}) as Record<string, unknown>,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

export async function listAgents(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<AgentDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.agent.findMany({ select: AGENT_SELECT, orderBy: { id: "asc" } }),
  );
  return rows.map(toDto);
}

const AGENT_ORDER_FIELDS = ["name", "createdAt", "updatedAt"] as const;
type AgentOrderField = (typeof AGENT_ORDER_FIELDS)[number];

export interface ListAgentsOptions {
  q?: string;
  orderBy?: string;
  order?: string;
  offset?: number;
  limit?: number;
  // Filter by active state; omit for all agents (the status pills in the console).
  enabled?: boolean;
}

// The console list view enriches each agent with the inboxes it answers (Inbox.agentId reverse
// lookup). Kept off the canonical AgentDto (and the unpaged `listAgents`/`getAgent` used by the MCP
// transport) so only the paged REST list carries it.
export interface PagedAgentItem extends AgentDto {
  inboxes: { id: string; name: string }[];
  // True when the agent's availability schedule (businessHoursId) is currently closed (item 23).
  // Computed server-side in the schedule's timezone; false when there's no schedule (always-on).
  outOfHours: boolean;
}

export interface PagedAgents {
  agents: PagedAgentItem[];
  total: number;
}

// Paginated + searchable agent listing for the console (REST). `listAgents` stays the
// unpaginated all-rows reader used by the MCP transport and internal callers.
export async function listAgentsPaged(
  ctx: TenantContext,
  options: ListAgentsOptions = {},
  base: PrismaClient = basePrisma,
): Promise<PagedAgents> {
  const q = options.q?.trim();
  const orderField: AgentOrderField = AGENT_ORDER_FIELDS.includes(
    options.orderBy as AgentOrderField,
  )
    ? (options.orderBy as AgentOrderField)
    : "updatedAt";
  const order: "asc" | "desc" = options.order === "asc" ? "asc" : "desc";
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 20), 1), 100);
  const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
  const where: Prisma.AgentWhereInput = {};
  if (q) where.name = { contains: q, mode: "insensitive" };
  if (typeof options.enabled === "boolean") where.enabled = options.enabled;
  return runScopedOn(base, ctx, async (db) => {
    const [rows, total] = await Promise.all([
      db.agent.findMany({
        where,
        select: AGENT_SELECT,
        // The id breaks ties, so paging is DETERMINISTIC: two agents sharing a timestamp (or a name)
        // could otherwise be ordered differently per query, and a walk over pages would return one
        // twice and miss the other.
        orderBy: [{ [orderField]: order }, { id: "asc" }],
        skip: offset,
        take: limit,
      }),
      db.agent.count({ where }),
    ]);
    // Reverse lookup of the inboxes each listed agent answers, in one batched query (no N+1).
    const ids = rows.map((r) => r.id);
    const inboxRows = ids.length
      ? await db.inbox.findMany({
          where: { agentId: { in: ids } },
          select: { id: true, name: true, agentId: true },
          orderBy: { name: "asc" },
        })
      : [];
    const byAgent = new Map<bigint, { id: string; name: string }[]>();
    for (const ib of inboxRows) {
      if (ib.agentId === null) continue;
      const list = byAgent.get(ib.agentId) ?? [];
      list.push({ id: String(ib.id), name: ib.name });
      byAgent.set(ib.agentId, list);
    }
    // Out-of-hours per agent (item 23): batch-load the distinct availability schedules referenced by
    // the page, evaluate "now" in each schedule's timezone. One query, no N+1.
    const hoursIds = [
      ...new Set(rows.map((r) => r.businessHoursId).filter((h) => h !== null)),
    ];
    const hoursRows = hoursIds.length
      ? await db.businessHours.findMany({
          where: { id: { in: hoursIds } },
          select: { id: true, windows: true, exceptions: true, timezone: true },
        })
      : [];
    const now = new Date();
    const outOfHoursById = new Map<bigint, boolean>();
    for (const h of hoursRows) {
      outOfHoursById.set(h.id, isOutOfHoursNow(parseSchedule(h), now));
    }
    return {
      agents: rows.map((r) => ({
        ...toDto(r),
        inboxes: byAgent.get(r.id) ?? [],
        outOfHours:
          r.businessHoursId != null
            ? (outOfHoursById.get(r.businessHoursId) ?? false)
            : false,
      })),
      total,
    };
  });
}

export async function getAgent(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<AgentDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.agent.findUnique({ where: { id }, select: AGENT_SELECT }),
  );
  if (!row) throw new NotFoundError("agent not found", "errors.agentNotFound");
  return toDto(row);
}

// The cap is a deliberate checkpoint (oversized prompts usually hold knowledge-base
// content and degrade instruction adherence), raised only via AGENT_PROMPT_MAX_CHARS — on
// purpose, no UI affordance points at the override. Checked BEFORE the schema parse so every
// transport surfaces this localized error instead of a raw validation failure.
export class PromptTooLongError extends AppError {
  constructor(length: number) {
    const max = config.agent.promptMaxChars;
    super(
      `system prompt is too long: ${length} characters (limit ${max})`,
      400,
      "errors.promptTooLong",
      { len: length, max },
      "systemPrompt",
    );
  }
}

export function assertPromptSize(systemPrompt: string | undefined): void {
  if (
    systemPrompt !== undefined &&
    systemPrompt.length > config.agent.promptMaxChars
  ) {
    throw new PromptTooLongError(systemPrompt.length);
  }
}

// The operator prose inside `settings` (tool guidance, guardrails policy, vision prompt,
// follow-up steps) is clamped by the READERS, which is invisible to whoever wrote it: the row keeps
// every character and only the model-facing copy is short. Refusing at the boundary is the same
// checkpoint the system prompt gets — see text-caps.ts for why it is a refusal here and a clamp on
// import. Checked BEFORE the schema parse so every transport surfaces this error instead of a raw
// validation failure.
export class SettingsTextTooLongError extends AppError {
  constructor(field: string, length: number, max: number) {
    super(
      `settings text is too long: ${field} has ${length} characters (limit ${max})`,
      400,
      "errors.settingsTextTooLong",
      { field, len: length, max },
      // NOTE: the dotted path collectOversizedTextChanges reports, which is the same string the console's
      // own text-cap warning already routes on (TEXT_CAP_TARGETS).
      field,
    );
  }
}

// A `settings` bag REPLACES the column (the console sends it whole, the MCP patch builds one), so a
// write that would delete configured blocks it never named is refused rather than turned into a merge.
export class SettingsBlocksDroppedError extends AppError {
  constructor(blocks: string[]) {
    super(
      `settings would delete configured blocks it does not name: ${blocks.join(", ")}`,
      400,
      "errors.settingsBlocksDropped",
      { blocks: blocks.join(", "), count: blocks.length },
      "settings",
    );
  }
}

// Whether an unnamed stored block would lose something if dropped (an empty block would not). Unlike
// `carriesConfiguration`, `false` and `""` count: a block switched OFF is a decision, and dropping it
// reverts to the default.
function holdsSomething(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function assertSettingsBlocksKept(
  settings: unknown,
  stored: unknown,
): void {
  // `undefined` is "this write does not touch the column" (a rename, a mode change) and not an
  // empty bag. An empty bag IS the whole wipe, and goes through the same question as any other.
  if (settings === undefined) return;
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return;
  const next =
    settings && typeof settings === "object" && !Array.isArray(settings)
      ? (settings as Record<string, unknown>)
      : {};
  // Named by an OWN key holding a VALUE: an `undefined` value is dropped on the way to Postgres,
  // and an inherited `constructor` is not a block. `__proto__` is skipped: no write can carry it, so
  // refusing over a stored one would block every save of the agent.
  const dropped = Object.entries(stored as Record<string, unknown>)
    .filter(
      ([key, value]) =>
        key !== "__proto__" &&
        (!Object.hasOwn(next, key) || next[key] === undefined) &&
        holdsSomething(value),
    )
    .map(([key]) => key)
    .sort();
  // Every block at once, not the first: a caller who learns the size of the mistake one refusal at a
  // time fixes it one refusal at a time, and the point of this rule is that the whole cost is said
  // out loud before anything is written.
  if (dropped.length > 0) throw new SettingsBlocksDroppedError(dropped);
}

// `stored` is the bag this write replaces, and it is what keeps the refusal answerable: only text the
// write introduces or changes is refused. See collectOversizedTextChanges for why an already-stored
// value cannot be one (the editor has no control for several of these fields).
export function assertSettingsTextSizes(
  settings: unknown,
  stored: unknown,
): void {
  const [first] = collectOversizedTextChanges(settings, stored);
  if (first) {
    throw new SettingsTextTooLongError(first.path, first.length, first.max);
  }
}

// The debug window's write boundary, shared by every transport. The reader's horizon check moves with
// the clock (a deadline 48h out fits `now + 24h` a day later), so only the write can refuse it. Only a
// value the write introduces or changes is refused.
export class DebugWindowTooLongError extends AppError {
  constructor(hours: number) {
    super(
      `observability.fullDetailUntil is further than ${hours}h ahead`,
      400,
      "errors.debugWindowTooLong",
      { hours },
      "observability.fullDetailUntil",
    );
  }
}

// The signature's switch, refused at the write rather than normalised in the reader: GET echoes the
// stored bag, so a normalised `"sim"` would give the API and the runtime two answers to one question.
export class InvalidSignatureSwitchError extends AppError {
  constructor(got: string) {
    super(
      `signature.enabled must be a boolean, got ${got}`,
      400,
      "errors.invalidSignatureSwitch",
      { got },
      "signature.enabled",
    );
  }
}

// The signature's closed fields (`frequency`, `position`, `separator`), refused at the write for the
// same reason as the switch. Driven by `SIGNATURE_CHOICES`, the reader's own domains.
export class InvalidSignatureChoiceError extends AppError {
  constructor(field: string, allowed: readonly string[], got: string) {
    const list = allowed.map((v) => `"${v}"`).join(", ");
    super(
      `signature.${field} must be one of ${list}, got ${got}`,
      400,
      "errors.invalidSignatureChoice",
      { field, allowed: list, got },
      `signature.${field}`,
    );
  }
}

export class InvalidToolPreconditionError extends AppError {
  constructor(toolName: string) {
    super(
      `settings.toolPreconditions.${toolName} is not a valid precondition`,
      400,
      "errors.invalidToolPrecondition",
      { tool: toolName },
      `toolPreconditions.${toolName}`,
    );
  }
}

export class InvalidContactAuthRuleError extends AppError {
  constructor() {
    super(
      "settings.contactAuth.rule is not a valid rule",
      400,
      "errors.invalidContactAuthRule",
      {},
      "contactAuth.rule",
    );
  }
}

function rawContactAuthRule(settings: unknown): unknown {
  if (!settings || typeof settings !== "object") return undefined;
  const block = (settings as Record<string, unknown>).contactAuth;
  return block && typeof block === "object"
    ? (block as Record<string, unknown>).rule
    : undefined;
}

// The contact gate's local rule, refused when a write CHANGES it to something unparseable: the reader
// drops such a rule, and the gate then falls back to the endpoint, a different gate than the one shown.
export function assertSettingsContactAuthRule(
  settings: unknown,
  stored: unknown,
): void {
  const next = rawContactAuthRule(settings);
  if (!invalidContactAuthRule(next)) return;
  if (JSON.stringify(next) === JSON.stringify(rawContactAuthRule(stored))) {
    return;
  }
  throw new InvalidContactAuthRuleError();
}

export class ContactFieldNotInContextError extends AppError {
  constructor(fields: string[]) {
    super(
      `settings.contactFields.writable names fields outside context: ${fields.join(", ")}`,
      400,
      "errors.contactFieldNotInContext",
      { fields: fields.join(", ") },
      "contactFields.writable",
    );
  }
}

function rawContactFieldsBlock(settings: unknown): unknown {
  if (!settings || typeof settings !== "object") return undefined;
  return (settings as Record<string, unknown>).contactFields;
}

// A writable field outside context is dropped by the reader, so the agent would get no update_contact
// for it while the stored bag says it can write it. Refused when the write CHANGES the block, like the
// contact gate's rule above.
export function assertSettingsContactFields(
  settings: unknown,
  stored: unknown,
): void {
  const block = rawContactFieldsBlock(settings);
  if (!block || typeof block !== "object") return;
  const { context, writable } = block as Record<string, unknown>;
  if (!Array.isArray(writable)) return;
  const seen = Array.isArray(context) ? context : [];
  const outside = writable.filter((f) => !seen.includes(f));
  if (outside.length === 0) return;
  if (JSON.stringify(block) === JSON.stringify(rawContactFieldsBlock(stored))) {
    return;
  }
  throw new ContactFieldNotInContextError(outside.map(String));
}

// A precondition that does not parse is REFUSED here rather than dropped at turn time, and the two
// halves are the same parse on purpose. The cost of the other arrangement is specific: the operator
// saves a rule, the console shows it saved, and the runtime treats the tool as ungoverned — a tool
// the operator believes is fenced and is not, which is worse than never having offered the fence.
//
// Only what the write CHANGES is refused. A bag stored before this shipped keeps its bad entries
// (dropped at read time) and an unrelated PATCH is not the moment to make the operator fix them,
// because the field they would have to fix is not the field they came to edit.
export function assertSettingsToolPreconditions(
  settings: unknown,
  stored: unknown,
): void {
  const next = invalidToolPreconditions(settings);
  if (next.length === 0) return;
  // NOTE: Compared by VALUE, not by name. A name that was already invalid and is now invalid DIFFERENTLY
  // is an edit, and an edit is exactly what this refuses: comparing name membership would accept the
  // operator rewriting a broken rule into another broken rule and reading it as saved.
  // NOTE: The BAG itself being the wrong shape is not a per-name question — `invalidToolPreconditions`
  // answers it with a synthetic name that appears in neither value map, so a name-wise comparison
  // finds "unchanged" and lets an array or a string through. Compared as a whole, once.
  if (next.length === 1 && next[0] === "toolPreconditions") {
    const nextBag = JSON.stringify(rawPreconditionBag(settings));
    if (nextBag === JSON.stringify(rawPreconditionBag(stored))) return;
    throw new InvalidToolPreconditionError("toolPreconditions");
  }
  const before = storedPreconditionValues(stored);
  const now = storedPreconditionValues(settings);
  const introduced = next.find(
    (name) =>
      now.get(name) !== before.get(name) &&
      !removesAStoredRule(name, now, before),
  );
  if (introduced === undefined) return;
  throw new InvalidToolPreconditionError(introduced);
}

// A retired settings key is refused whenever it CARRIES CONFIGURATION: loose blocks would otherwise
// store and echo a field no reader uses. Mere presence is not refused (see carriesConfiguration), and
// `20260910140000_drop_retired_label_settings` clears what is already stored.
export class RetiredLabelSettingError extends AppError {
  constructor(key: string) {
    super(
      `settings.${key} was retired: say which labels exist and which exclude each other in settings.toolGuidance.set_labels`,
      400,
      "errors.retiredLabelSetting",
      { key },
      key,
    );
  }
}

// AN EMPTY TOMBSTONE IS NOT A REFUSAL, and the difference is the whole of what makes this shippable.
// The previous Behavior editor wrote `monitoring.labelGroups` unconditionally, so an agent that never
// had a taxonomy still carries `[]`; the migration clears what is stored, but during a rolling deploy
// the OLD console keeps writing it back, and a hard refusal would then fail every save on the new one
// for a key the operator cannot see or act on. Refusing what carries CONFIGURATION and ignoring what
// carries none teaches the operator exactly where a real taxonomy went, and is inert for the rest.
function carriesConfiguration(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object")
    return Object.values(value as Record<string, unknown>).some(
      carriesConfiguration,
    );
  return value !== false;
}

// The reader keeps only the first PROTECTED_LABELS_MAX entries while the editor shows them all, a
// guard that looks active and is not. Refused when the write CHANGES the list.
export class TooManyProtectedLabelsError extends AppError {
  constructor(max: number) {
    super(
      `settings.setLabels.protected takes at most ${max} labels`,
      400,
      "errors.tooManyProtectedLabels",
      { max },
      "setLabels.protected",
    );
  }
}

// The allowed list is read back by the same editor, so it is refused past the ceiling too.
export class TooManyAllowedLabelsError extends AppError {
  constructor(max: number) {
    super(
      `settings.setLabels.allowed takes at most ${max} labels`,
      400,
      "errors.tooManyAllowedLabels",
      { max },
      "setLabels.allowed",
    );
  }
}

function rawLabelList(
  settings: unknown,
  key: "protected" | "allowed",
): unknown[] | null {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return null;
  const block = (settings as Record<string, unknown>).setLabels;
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const raw = (block as Record<string, unknown>)[key];
  return Array.isArray(raw) ? raw : null;
}

// Whether a write CHANGES the list to one past `max`, counted the way the READER counts, or the
// refusal and the truncation would disagree about the same list: blanks, non-strings and duplicates
// never became entries in the first place. Counted HERE rather than by calling the reader, because
// the reader stops AT the ceiling — asking it how many there are can never answer more than the
// ceiling, which is the whole question.
function labelListOverflows(
  settings: unknown,
  stored: unknown,
  key: "protected" | "allowed",
  max: number,
): boolean {
  const next = rawLabelList(settings, key);
  if (next === null) return false;
  const kept = new Set<string>();
  for (const entry of next) {
    if (typeof entry !== "string") continue;
    const label = entry.trim();
    if (label) kept.add(label);
  }
  if (kept.size <= max) return false;
  const before = rawLabelList(stored, key);
  return !(before !== null && JSON.stringify(before) === JSON.stringify(next));
}

// A LABEL THE AGENT'S CLOSE WRITES CANNOT ALSO BE ONE `set_labels` IS FENCED OFF. The
// two settings would contradict each other, and which one won would depend on which writer ran
// last. Refused on save, naming the label, rather than quietly skipped at the close: the operator
// is the one who has to decide which list it belongs to.
export class ProtectedResolveLabelError extends AppError {
  constructor(labels: string[]) {
    super(
      `settings.resolveConversation.assignLabels cannot hold a label set_labels protects: ${labels.join(", ")}`,
      400,
      "errors.protectedResolveLabel",
      { labels: labels.join(", ") },
      "resolveConversation.assignLabels",
    );
  }
}

export function assertResolveLabelsNotProtected(bag: unknown): void {
  const clash = protectedResolveLabels(bag);
  if (clash.length > 0) throw new ProtectedResolveLabelError(clash);
}

export function assertSettingsProtectedLabels(
  settings: unknown,
  stored: unknown,
): void {
  if (labelListOverflows(settings, stored, "protected", PROTECTED_LABELS_MAX))
    throw new TooManyProtectedLabelsError(PROTECTED_LABELS_MAX);
  if (labelListOverflows(settings, stored, "allowed", ALLOWED_LABELS_MAX))
    throw new TooManyAllowedLabelsError(ALLOWED_LABELS_MAX);
}

// A closed settings value the reader would throw away, refused on REST by asking the schema MCP uses
// (`BEHAVIOR_PATCH_SHAPE`), so REST and MCP share one list of domains.
export class InvalidSettingsValueError extends AppError {
  constructor(path: string, expected: string, got: string) {
    super(
      `settings.${path} expects ${expected}, got ${got}`,
      400,
      "errors.invalidSettingsValue",
      { field: path, expected, got },
      path,
    );
  }
}

function plainObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function valueAt(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    if (!Object.hasOwn(cur, seg)) return undefined;
    cur = (cur as Record<PropertyKey, unknown>)[seg];
  }
  return cur;
}

function describeGot(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function describeExpected(issue: z.core.$ZodIssue): string {
  if (issue.code === "invalid_value")
    return `one of ${issue.values.map((v) => JSON.stringify(v)).join(", ")}`;
  if (issue.code === "invalid_type") return issue.expected;
  if (issue.code === "invalid_format" && "pattern" in issue && issue.pattern)
    return `a value matching ${issue.pattern}`;
  return "a valid value";
}

// One closed value a block's schema refuses, with the path it sits at and what the reader reads there.
interface ClosedValueIssue {
  block: string;
  path: PropertyKey[];
  next: unknown;
  expected: string;
}

// Every closed value in `bag` the schema MCP asks would refuse, block by block. Shared by the write
// boundary below, which refuses the first one the write changes, and by the import, which
// normalizes all of them, so the two cannot disagree about what a closed value outside its domain is.
function closedValueIssues(bag: Record<string, unknown>): ClosedValueIssue[] {
  const out: ClosedValueIssue[] = [];
  for (const [block, schema] of Object.entries(BEHAVIOR_PATCH_SHAPE)) {
    if (!Object.hasOwn(bag, block)) continue;
    const value = bag[block];
    // NOTE: A block NAMED as null is an edit of it: the reader answers it with its defaults, and GET
    // echoing `null` claims nothing the runtime reads differently.
    if (value === null) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      const next = valueAt(value, issue.path);
      // `never` marks a key the runtime does not read here (reply-only checks under `input`).
      // REST cannot refuse it outright, since the console's Guardrails save materialises it, so the
      // reader's TYPE passes and anything else is refused like any other thrown-away value.
      let expected: string | undefined;
      if (issue.code === "invalid_type" && issue.expected === "never") {
        const read = valueAt(
          (
            readBehaviorSettings({ [block]: value }) as unknown as Record<
              string,
              unknown
            >
          )[block],
          issue.path,
        );
        if (typeof next === typeof read) continue;
        expected = typeof read;
      }
      out.push({
        block,
        path: issue.path,
        next,
        expected: expected ?? describeExpected(issue),
      });
    }
  }
  return out;
}

export function assertSettingsClosedValues(
  settings: unknown,
  stored: unknown,
): void {
  const bag = plainObject(settings);
  if (!bag) return;
  const storedBag = plainObject(stored);
  for (const { block, path, next, expected } of closedValueIssues(bag)) {
    // ONLY WHAT THIS WRITE INTRODUCES OR CHANGES, by value and per path, so a legacy row re-sent
    // untouched saves and a list element is judged field by field. Path by index: a value that moved
    // to another index is a change, and naming its new path is what lets the caller find it.
    if (isDeepStrictEqual(next, valueAt(storedBag?.[block], path))) continue;
    throw new InvalidSettingsValueError(
      [block, ...path.map(String)].join("."),
      expected,
      describeGot(next),
    );
  }
}

// DERIVED, never stored: `observability.fullDetail` is computed from `fullDetailUntil` (docs/logs.md),
// and a bag that stores it leaves GET and the runtime disagreeing about whether the debug mode is on.
// The MCP path already writes the storable projection; REST drops the key on the way in, which also
// cleans a legacy row the next time it is saved. Dropped rather than refused, so that row keeps saving.
export function stripDerivedFullDetailInPlace(settings: unknown): void {
  const obs = plainObject(plainObject(settings)?.observability);
  if (obs && Object.hasOwn(obs, "fullDetail")) delete obs.fullDetail;
}

// Removes what `path` points at: a key of an object, or an element of a list (the reader drops a list
// element of the wrong type, so removing it is what the runtime already reads). False when nothing
// was there, so a refusal about an ABSENT value is not reported as something taken away.
function removeAt(root: unknown, path: readonly PropertyKey[]): boolean {
  const parentPath = [...path];
  const last = parentPath.pop();
  if (last === undefined) return false;
  const parent = valueAt(root, parentPath);
  if (Array.isArray(parent)) {
    const i = typeof last === "number" ? last : Number(last);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) return false;
    parent.splice(i, 1);
    return true;
  }
  const obj = plainObject(parent);
  if (!obj || !Object.hasOwn(obj, last as string)) return false;
  delete obj[last as string];
  return true;
}

// Sets what `path` points at, when its parent exists. False otherwise.
function setAt(
  root: unknown,
  path: readonly PropertyKey[],
  value: unknown,
): boolean {
  const parentPath = [...path];
  const last = parentPath.pop();
  if (last === undefined) return false;
  const parent = valueAt(root, parentPath);
  if (Array.isArray(parent)) {
    const i = typeof last === "number" ? last : Number(last);
    if (!Number.isInteger(i) || i < 0 || i >= parent.length) return false;
    parent[i] = value;
    return true;
  }
  const obj = plainObject(parent);
  if (!obj || !Object.hasOwn(obj, last as string)) return false;
  obj[last as string] = value;
  return true;
}

// Ceilings on WORK, not correctness: how many tail elements of one list are tried, and how many
// candidates are judged one by one. Past them values stay put. A bundle is caller input and the import
// runs in a 5s transaction.
const IMPORT_POP_LIMIT = 64;
const IMPORT_ONE_BY_ONE_MAX = 32;
// And a ceiling on the comparisons for the whole bag, since each reads the block and thousands of lists
// would pay thousands of reads first. Spent, the remaining values stay where they are.
const IMPORT_READING_CHECKS = 256;
// How many lists in one block get a tail cut tried on them. The element that slides into a reader's
// window comes from the list the removal was in, so trying every list of a bag that has thousands of
// them spends the whole budget before the useful answer is reached.
const IMPORT_POP_LISTS = 8;
// How many paths the pass carries back. The import names a handful and counts the rest, since one list
// can hold a million unusable entries.
const IMPORT_PATHS_KEPT = 64;
// Every comparison costs a clone and a read of the BLOCK, so a bigger block gets fewer, down to the
// single batch pass. Sizes in JSON characters, taken once per block.
function importChecksFor(weight: number): number {
  if (weight <= 64_000) return IMPORT_READING_CHECKS;
  if (weight <= 512_000) return 16;
  return 1;
}

// The paths taken out, bounded, beside how many there were.
interface ImportTaken {
  paths: string[];
  count: number;
}

function newTaken(): ImportTaken {
  return { paths: [], count: 0 };
}

function takePath(taken: ImportTaken, path: string): void {
  taken.count += 1;
  if (taken.paths.length < IMPORT_PATHS_KEPT) taken.paths.push(path);
}

function absorbTaken(into: ImportTaken, from: ImportTaken): void {
  for (const path of from.paths) takePath(into, path);
  // `takePath` counted only what it kept; the rest are counted here.
  into.count += from.count - from.paths.length;
}

type ImportFix =
  | { kind: "trim"; path: PropertyKey[]; trimmed: string }
  | { kind: "remove"; path: PropertyKey[] };

// Applies every fix to a copy of the block and answers it with the paths it took out, or null when the
// block's reading changed anyway. Paths are the BUNDLE's: every fix is applied to a copy of the original
// value, so an index never names a position some earlier removal created.
function applyImportFixes(
  fixes: readonly ImportFix[],
  value: unknown,
  block: string,
  reads: (candidate: unknown) => boolean,
  attemptCap: number,
): { next: unknown; taken: ImportTaken } | null {
  // This attempt's own share of the block's comparisons, so the first one cannot leave the next with
  // nothing: the batch that fails over a padding is followed by the batch that takes the paddings out.
  let used = 0;
  const sameReading = (candidate: unknown) => {
    if (used >= attemptCap) return false;
    used += 1;
    return reads(candidate);
  };
  const trial = structuredClone(value);
  const taken = newTaken();
  for (const fix of fixes) {
    if (fix.kind === "trim") setAt(trial, fix.path, fix.trimmed);
  }
  // Keys first, elements after: a key is addressed inside an element the bundle numbered, so removing
  // elements first would renumber the list under the paths still to be applied.
  const lists = new Map<
    string,
    { at: PropertyKey[]; drop: Set<number>; kept: number[]; arr: unknown[] }
  >();
  for (const fix of fixes) {
    if (fix.kind !== "remove") continue;
    const at = [...fix.path];
    const last = at.pop();
    const parent = valueAt(trial, at);
    if (Array.isArray(parent) && last !== undefined) {
      const key = at.map(String).join(".");
      const list = lists.get(key) ?? {
        at,
        drop: new Set<number>(),
        kept: [],
        // NOTE: The ARRAY ITSELF, kept from here on: once an outer element is out, the index path that
        // found a nested list names something else, or nothing.
        arr: parent,
      };
      list.drop.add(Number(last));
      lists.set(key, list);
      takePath(taken, [block, ...fix.path.map(String)].join("."));
      continue;
    }
    if (removeAt(trial, fix.path))
      takePath(taken, [block, ...fix.path.map(String)].join("."));
  }
  // Deepest list first, for the same reason: an inner list is addressed through its element's index.
  const byDepth = [...lists.values()].sort((a, b) => b.at.length - a.at.length);
  for (const list of byDepth) {
    const arr = list.arr;
    const kept: unknown[] = [];
    arr.forEach((element, i) => {
      if (list.drop.has(i)) return;
      kept.push(element);
      list.kept.push(i);
    });
    arr.length = 0;
    for (const element of kept) arr.push(element);
  }
  // A list the reader cuts to a window BEFORE it filters: what slid into the window from past it is an
  // element the reader ignored, and taking that too is what keeps the window's contents. Named by its
  // own index in the bundle, which is why the kept indices are carried here.
  let settled = sameReading(trial);
  let listsTried = 0;
  for (const list of byDepth) {
    if (settled || listsTried >= IMPORT_POP_LISTS || used >= attemptCap) break;
    listsTried += 1;
    const arr = list.arr;
    let floor = Number.POSITIVE_INFINITY;
    for (const i of list.drop) floor = Math.min(floor, i);
    // NOTE: Only when the reader's window is reachable by the cuts this will make: most lists are not
    // windowed, and trying the tail of a long one costs a whole-block read per element.
    if (arr.length - floor > IMPORT_POP_LIMIT) continue;
    // Tried on THIS list and undone when it does not settle it: the difference may belong to
    // another list, and popping here would take an element no reader ignores.
    const before = [...arr];
    const keptBefore = [...list.kept];
    const takenBefore = { paths: [...taken.paths], count: taken.count };
    let pops = 0;
    while (
      !settled &&
      pops < IMPORT_POP_LIMIT &&
      arr.length > 0 &&
      (list.kept[list.kept.length - 1] ?? -1) > floor
    ) {
      takePath(
        taken,
        [block, ...list.at.map(String), String(list.kept.pop())].join("."),
      );
      arr.pop();
      pops += 1;
      settled = sameReading(trial);
    }
    if (settled) continue;
    arr.length = 0;
    for (const element of before) arr.push(element);
    list.kept = keptBefore;
    taken.paths = takenBefore.paths;
    taken.count = takenBefore.count;
  }
  return settled ? { next: trial, taken } : null;
}

// What create refuses, an import normalizes: a bundle authored elsewhere is not refused whole over one
// field. The unusable value is taken out (so the reader's default applies and GET agrees with the
// runtime), judged by the write boundary's own predicates. Returns the paths taken, bounded, and a count.
export function dropUnusableImportedSettingsInPlace(
  settings: unknown,
): ImportTaken {
  const bag = plainObject(settings);
  if (!bag) return newTaken();
  const dropped = newTaken();
  // Derived from `fullDetailUntil`, and dropped as create drops it. Named here, unlike on create: the
  // bundle's author wrote the flag believing the debug mode was on, and an import is the one door
  // where nobody is at the editor to see that it is not.
  const obs = plainObject(bag.observability);
  if (obs && Object.hasOwn(obs, "fullDetail")) {
    stripDerivedFullDetailInPlace(bag);
    takePath(dropped, "observability.fullDetail");
  }
  // A rule that cannot parse is dropped WHOLE, as the reader does. Judged by the READER, not the
  // write boundary: a rule on a custom tool name is honoured at runtime. Done before the closed values,
  // which would strip one field (`equals`) and leave a weaker guard nobody wrote. `null` rules stay.
  const guards = plainObject(bag.toolPreconditions);
  for (const [name, raw] of Object.entries(guards ?? {})) {
    if (raw === null || parseToolPrecondition(raw) !== null) continue;
    delete (guards as Record<string, unknown>)[name];
    takePath(dropped, `toolPreconditions.${name}`);
  }
  // The contact gate's local rule, on the same terms: the reader drops one that does not parse,
  // so it is taken out and named rather than stored as a list the runtime never reads.
  const contactAuth = plainObject(bag.contactAuth);
  if (contactAuth && invalidContactAuthRule(contactAuth.rule)) {
    delete contactAuth.rule;
    takePath(dropped, "contactAuth.rule");
  }
  // A label the close writes that `set_labels` also fences off: create refuses the pair, and the
  // import takes the label out of the close's list, keeping the fence, which is the stronger claim.
  // Every entry is judged, not only the reader's window: taking one out moves the next into it.
  const fenced = new Set(readProtectedLabels(bag).map((l) => l.toLowerCase()));
  const resolve = plainObject(bag.resolveConversation);
  if (fenced.size > 0 && resolve && Array.isArray(resolve.assignLabels)) {
    const list = resolve.assignLabels as unknown[];
    for (let i = list.length - 1; i >= 0; i--) {
      const l = list[i];
      if (typeof l === "string" && fenced.has(l.trim().toLowerCase())) {
        list.splice(i, 1);
        takePath(dropped, `resolveConversation.assignLabels.${i}`);
      }
    }
  }
  // Invariant: what the runtime reads does not change. Each removal is tried on a copy and kept
  // only when `readBehaviorSettings` reads the block the same (a trimmed value or a list window can
  // differ). Last issue first, so removals never shift a path still to be judged.
  const now = new Date();
  const readBlock = (block: string, value: unknown) =>
    (
      readBehaviorSettings({ [block]: value }, now) as unknown as Record<
        string,
        unknown
      >
    )[block];
  const budget = { left: IMPORT_READING_CHECKS };
  const byBlock = new Map<string, ClosedValueIssue[]>();
  for (const issue of closedValueIssues(bag)) {
    const list = byBlock.get(issue.block) ?? [];
    list.push(issue);
    byBlock.set(issue.block, list);
  }
  for (const [block, issues] of byBlock) {
    const reading = readBlock(block, bag[block]);
    const allowance = {
      left: Math.min(
        budget.left,
        importChecksFor(JSON.stringify(bag[block])?.length ?? 0),
      ),
    };
    const sameReading = (candidate: unknown) => {
      if (allowance.left <= 0) return false;
      allowance.left -= 1;
      budget.left -= 1;
      return isDeepStrictEqual(readBlock(block, candidate), reading);
    };
    // The block itself is the wrong type: the reader answers it with every default.
    if (issues.some((i) => i.path.length === 0)) {
      if (sameReading(undefined)) {
        delete bag[block];
        takePath(dropped, block);
      }
      continue;
    }
    // A padded value the reader trims and honours is stored trimmed rather than taken out, and nothing
    // is lost to warn about. Which paddings the schema then accepts is asked ONCE, not per value.
    const padded = issues.filter(
      (i) => typeof i.next === "string" && i.next.trim() !== i.next,
    );
    let trimmable = new Set<string>();
    if (padded.length > 0) {
      const trimTrial = structuredClone(bag[block]);
      for (const i of padded)
        setAt(trimTrial, i.path, (i.next as string).trim());
      const stillFlagged = new Set(
        closedValueIssues({ [block]: trimTrial }).map((i) =>
          i.path.map(String).join("."),
        ),
      );
      trimmable = new Set(
        padded
          .map((i) => i.path.map(String).join("."))
          .filter((key) => !stillFlagged.has(key)),
      );
    }
    const fixFor = (issue: ClosedValueIssue): ImportFix =>
      trimmable.has(issue.path.map(String).join("."))
        ? {
            kind: "trim",
            path: issue.path,
            trimmed: (issue.next as string).trim(),
          }
        : { kind: "remove", path: issue.path };
    const fixes = issues.map(fixFor);
    // The whole block in one pass first, which is what a bundle with many unusable entries costs.
    // Half the block's share, so the second attempt below still has one.
    const batch = applyImportFixes(
      fixes,
      bag[block],
      block,
      sameReading,
      Math.max(1, Math.floor(allowance.left / 2)),
    );
    if (batch) {
      bag[block] = batch.next;
      absorbTaken(dropped, batch.taken);
      continue;
    }
    // One padding the reader does not honour would otherwise cost the block its whole pass, and with it
    // every other value in there once the list is past the one-by-one ceiling. Asked once more with the
    // paddings taken out instead of trimmed.
    if (trimmable.size > 0) {
      const asRemovals = issues.map((issue) => ({
        kind: "remove" as const,
        path: issue.path,
      }));
      const second = applyImportFixes(
        asRemovals,
        bag[block],
        block,
        sameReading,
        allowance.left,
      );
      if (second) {
        bag[block] = second.next;
        absorbTaken(dropped, second.taken);
        continue;
      }
    }
    // Some value in there is one the runtime reads. Judged one by one, each time from the bundle's own
    // value plus what has been accepted so far, so a rejected fix leaves no trace and an index still
    // names the position the bundle wrote. Bounded, because this is the quadratic path.
    if (fixes.length > IMPORT_ONE_BY_ONE_MAX) continue;
    const accepted: ImportFix[] = [];
    let best: { next: unknown; taken: ImportTaken } | null = null;
    for (const fix of fixes) {
      if (allowance.left <= 0) break;
      const withTrim = applyImportFixes(
        [...accepted, fix],
        bag[block],
        block,
        sameReading,
        allowance.left,
      );
      if (withTrim) {
        accepted.push(fix);
        best = withTrim;
        continue;
      }
      if (fix.kind !== "trim") continue;
      // Trimming it changed the reading; taking it out may not.
      const asRemoval: ImportFix = { kind: "remove", path: fix.path };
      const withRemoval = applyImportFixes(
        [...accepted, asRemoval],
        bag[block],
        block,
        sameReading,
        allowance.left,
      );
      if (withRemoval) {
        accepted.push(asRemoval);
        best = withRemoval;
      }
    }
    if (best) {
      bag[block] = best.next;
      absorbTaken(dropped, best.taken);
    }
  }
  // Half a fallback is no fallback to the runtime (`hasModelFallback`), and a stored half is what the
  // write boundary refuses: the pair goes, the rest of the block stays. After the closed values, since
  // a provider outside its domain taken out above leaves exactly this half.
  const pair = fallbackPair(bag);
  if (pair) {
    const provider = namedOrNull(pair.provider);
    const model = namedOrNull(pair.model);
    const complete =
      provider !== null && (model !== null || modelOptionalFor(provider));
    if (!complete && (provider !== null || model !== null)) {
      const fb = bag.modelFallback as Record<string, unknown>;
      delete fb.provider;
      delete fb.model;
      takePath(dropped, "modelFallback");
    }
  }
  return dropped;
}

export function stripRetiredNoteFlagInPlace(settings: unknown): boolean {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return false;
  const monitoring = (settings as Record<string, unknown>).monitoring;
  if (
    !monitoring ||
    typeof monitoring !== "object" ||
    Array.isArray(monitoring)
  )
    return false;
  const mon = monitoring as Record<string, unknown>;
  if (!("noteOnChange" in mon)) return false;
  delete mon.noteOnChange;
  return true;
}

export function assertSettingsRetiredLabelKeys(settings: unknown): void {
  if (!settings || typeof settings !== "object" || Array.isArray(settings))
    return;
  const bag = settings as Record<string, unknown>;
  if (carriesConfiguration(bag.labels))
    throw new RetiredLabelSettingError("labels");
  const monitoring = bag.monitoring;
  if (
    !monitoring ||
    typeof monitoring !== "object" ||
    Array.isArray(monitoring)
  )
    return;
  const mon = monitoring as Record<string, unknown>;
  if (carriesConfiguration(mon.labelGroups))
    throw new RetiredLabelSettingError("monitoring.labelGroups");
  // NOTE: `monitoring.noteOnChange` is stripped, not refused (`stripRetiredNoteFlagInPlace`): an older
  // console writes it back on every Behavior save, and refusing would break saves unrelated to labels.
}

// A tombstone for a rule that IS stored passes the catalog restriction, which limits what may be
// CREATED: an imported non-native rule is enforced at runtime and must stay deletable. A tombstone for
// a name with nothing stored is still refused, since it would report success for a no-op.
function removesAStoredRule(
  name: string,
  now: Map<string, string>,
  before: Map<string, string>,
): boolean {
  return now.get(name) === "null" && before.get(name) !== undefined;
}

// The raw entries, serialized, so "did this one change?" is one comparison. `undefined` for a name
// that is not there, which is what makes an ADDED invalid entry differ from an absent one.
function rawPreconditionBag(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return undefined;
  }
  return (settings as Record<string, unknown>).toolPreconditions;
}

function storedPreconditionValues(settings: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return out;
  }
  const bag = (settings as Record<string, unknown>).toolPreconditions;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return out;
  for (const [name, raw] of Object.entries(bag as Record<string, unknown>)) {
    out.set(name, canonicalPrecondition(raw));
  }
  return out;
}

// Whether a write CHANGED a rule (an unchanged one is exempt from the catalog restriction, so a read
// config can be written back). Parsed first, since jsonb keeps no key order and GET returns the
// normalized shape; an unparseable entry falls back to its raw serialization.
function canonicalPrecondition(raw: unknown): string {
  if (raw === null) return "null";
  const parsed = parseToolPrecondition(raw);
  if (parsed) {
    return JSON.stringify([
      parsed.kind,
      parsed.scope,
      parsed.key,
      parsed.equals ?? null,
    ]);
  }
  return `raw:${JSON.stringify(raw) ?? "undefined"}`;
}

// A fallback is a provider AND a model, or nothing: every reader treats a half-named block as no
// fallback, so the operator's half would vanish silently. Refused, not repaired, and only when this
// write introduces or changes the pair, judged per field after the merge with the stored block.
export class HalfConfiguredFallbackError extends AppError {
  constructor(missing: "provider" | "model") {
    // Names WHICH half, and does not promise both: the model is not required for every provider (see
    // `modelOptionalFor`), so "needs a provider and a model" would send an operator on
    // `openai-compatible` looking for a field they do not need. ONE literal with one placeholder,
    // matching the catalog entry and sitting directly after `super(` — the error-catalog reader
    // pairs the sentence with the key by regex, and it can span neither a ternary of two literals
    // nor a comment between the paren and the string.
    super(
      `settings.modelFallback is only half configured: ${missing} is missing`,
      400,
      "errors.halfConfiguredFallback",
      { missing },
      `settings.modelFallback.${missing}`,
    );
  }
}

// The two fields, plus whether the bag MENTIONED each of them. A key that is absent is a key this
// write says nothing about, which only matters on the path that merges.
function fallbackPair(settings: unknown): {
  provider: unknown;
  model: unknown;
  sets: { provider: boolean; model: boolean };
} | null {
  const bag =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).modelFallback
      : undefined;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) return null;
  const o = bag as Record<string, unknown>;
  return {
    provider: o.provider,
    model: o.model,
    sets: { provider: "provider" in o, model: "model" in o },
  };
}

// One spelling for "not named", so a blank string, a null and an absent key compare equal — the
// editor trims before it stores and the readers treat all three as no fallback.
const namedOrNull = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

// WHAT THE WRITE WILL ACTUALLY STORE, which is not the same question on the two transports: REST
// REPLACES the settings column with the bag it was
// handed (`updateData = { ...rest }`), while the MCP patch runs `mergeBehaviorSettings` first and
// merges a block one level deep. Asking the merge question on the replace path lets
// `settings: { modelFallback: { model: "new" } }` borrow the stored provider to pass the check and
// then store a bag that has none — the exact half-named row this rule exists to refuse.
export type SettingsWriteMode = "replace" | "merge";

export function assertSettingsModelFallback(
  settings: unknown,
  stored: unknown,
  mode: SettingsWriteMode,
): void {
  const next = fallbackPair(settings);
  if (!next) return;
  const prev = fallbackPair(stored);
  const inherit = mode === "merge";
  const provider = namedOrNull(
    inherit && !next.sets.provider ? prev?.provider : next.provider,
  );
  const model = namedOrNull(
    inherit && !next.sets.model ? prev?.model : next.model,
  );
  // The model is required for every provider that needs one, which is not all of them: an
  // `openai-compatible` endpoint that serves a single model discards the name it is sent, and the
  // repo has said so since the primary's own schema. `modelOptionalFor` is that one predicate.
  if (provider !== null && (model !== null || modelOptionalFor(provider)))
    return;
  if (provider === null && model === null) return;
  // ONLY WHAT THE WRITE CHANGES. A bag that already holds a half-named pair is re-sent untouched by
  // every save that edits some other section, and refusing those would freeze the agent on a field
  // nobody is editing. By VALUE, not by which half is filled: swapping the provider of a broken
  // pair for another provider edits it and leaves it just as broken, so "same shape" would wave
  // through a write that is not the one this exemption is for.
  if (
    provider === namedOrNull(prev?.provider) &&
    model === namedOrNull(prev?.model)
  ) {
    return;
  }
  throw new HalfConfiguredFallbackError(
    provider !== null ? "model" : "provider",
  );
}

// Refused at the boundary only when this write introduces or changes it, so a stored bad value does
// not freeze saves of other sections. `undefined` is an older bag, answered by the reader from the text.
export function assertSettingsSignature(
  settings: unknown,
  stored: unknown,
): void {
  const next = rawSignatureField(settings, "enabled");
  if (next !== undefined && typeof next !== "boolean") {
    if (!isDeepStrictEqual(next, rawSignatureField(stored, "enabled")))
      throw new InvalidSignatureSwitchError(
        next === null ? "null" : typeof next,
      );
  }
  // Per FIELD, with the family's scoping: only a value this write introduces or changes. A legacy row
  // re-sent untouched saves, and fixing one of its fields does not require fixing the others.
  for (const [choice, allowed] of Object.entries(SIGNATURE_CHOICES)) {
    const value = rawSignatureField(settings, choice);
    if (value === undefined || isOneOf(allowed, value)) continue;
    // By VALUE: a legacy `position: {}` re-sent through JSON is a new object every time, and `===`
    // would refuse the very save this exemption is for.
    if (isDeepStrictEqual(value, rawSignatureField(stored, choice))) continue;
    throw new InvalidSignatureChoiceError(
      choice,
      allowed,
      value === null
        ? "null"
        : typeof value === "string"
          ? `"${value}"`
          : Array.isArray(value)
            ? "array"
            : typeof value,
    );
  }
}

function rawSignatureField(settings: unknown, field: string): unknown {
  if (!settings || typeof settings !== "object") return undefined;
  const sg = (settings as Record<string, unknown>).signature;
  if (!sg || typeof sg !== "object") return undefined;
  return (sg as Record<string, unknown>)[field];
}

export function assertSettingsDebugWindow(
  settings: unknown,
  stored: unknown,
  now: Date = new Date(),
): void {
  const next = rawFullDetailUntil(settings);
  if (next === undefined || next === rawFullDetailUntil(stored)) return;
  const at = parseIsoInstant(next);
  if (at !== null && isFullDetailWindowOpen(at, now)) return;
  // A value that reads as OFF is allowed through only when it is genuinely off — past, absent, or
  // unreadable. What is refused is the one that is off TODAY and arms itself later.
  if (at === null || at.getTime() <= now.getTime()) return;
  throw new DebugWindowTooLongError(FULL_DETAIL_MAX_HOURS);
}

function rawFullDetailUntil(settings: unknown): unknown {
  if (!settings || typeof settings !== "object") return undefined;
  const o = (settings as Record<string, unknown>).observability;
  if (!o || typeof o !== "object") return undefined;
  return (o as Record<string, unknown>).fullDetailUntil;
}

// The write boundary for the agent's credential refs, the only place a `vault:<id>` enters either
// JSON bag. Each changed ref is written back in canonical form (`requireVaultRef`) and must be an entry
// whose kind can serve the field (`requireVaultRefFor`): most read a plain API key.
async function assertCredentialRefsResolve(
  db: ScopedDb,
  next: { modelConfig?: unknown; settings?: unknown },
  stored: { modelConfig?: unknown; settings?: unknown },
): Promise<void> {
  for (const write of collectCredentialRefWrites(next, stored)) {
    write.replace(
      await requireVaultRefFor(db, write.ref, write.path, write.use),
    );
  }
}

// The credential half of `createAgent`'s verdict, on its own scoped read. ADVISORY: the entry it
// finds can be deleted or re-kinded before the apply lands, and the copy inside the write's
// transaction stays the authority.
//
// NOTE: it REWRITES the refs it was handed, because `assertCredentialRefsResolve` does — canonical
// on the way in is the point of that function. The preview echoes the payload it validated, so what
// the operator reads back is the spelling the apply would store, not the one they typed.
export async function assertCredentialRefsUsable(
  ctx: TenantContext,
  next: { modelConfig?: unknown; settings?: unknown },
  base: PrismaClient = basePrisma,
  // The bag this write REPLACES. `{}` on create, where nothing is stored yet and every ref the
  // payload carries is one this write introduces; the stored row on update, because "did this write
  // change the ref" can only be asked of the value being replaced.
  stored: { modelConfig?: unknown; settings?: unknown } = {},
): Promise<void> {
  await runScopedOn(base, ctx, (db) =>
    assertCredentialRefsResolve(db, next, stored),
  );
}

// The EFFECTIVE follow-up state, in any mode (the sweep admits /teste conversations). Every OFF to ON
// transition stamps Agent.followUpArmedAt, the sweep's backlog fence, meaning "from now on"; promotion
// to production re-arms too, or the test-period watermark would expose the whole backlog.
function effectiveFollowUpOn(a: {
  enabled: boolean;
  settings: unknown;
}): boolean {
  return a.enabled && readFollowUpConfig(a.settings).enabled;
}

// Allowlist of editable fields. modelConfig/settings must be objects; the runtime's own parser
// validates their inner shape at load time.
export const agentUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    systemPrompt: z.string().max(config.agent.promptMaxChars).optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(AGENT_MODES).optional(),
    transferWithSummary: z.boolean().optional(),
    modelConfig: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    // Re-assignable after creation (a `null` detaches). Ownership is validated below, inside the
    // scoped tx, exactly like createAgent — a cross-tenant id is invisible there and fails closed.
    businessHoursId: z.string().nullable().optional(),
    followUpHoursId: z.string().nullable().optional(),
  })
  .strict();

export type AgentUpdate = z.infer<typeof agentUpdateSchema>;

// Everything `updateAgent` decides about its PATCH before any database is involved, shared with the
// MCP preview so it asks what the apply asks. The two schedule ids come back parsed, so the caller
// cannot disagree about which row was asked for.
export function assertAgentUpdatable(patch: AgentUpdate): {
  data: AgentUpdate;
  rest: Omit<AgentUpdate, "businessHoursId" | "followUpHoursId">;
  hasBh: boolean;
  hasFuh: boolean;
  businessHoursId: bigint | null;
  followUpHoursId: bigint | null;
} {
  assertPromptSize(patch.systemPrompt);
  const data = parseInput(agentUpdateSchema, patch);
  validateModelConfigForWrite(data.modelConfig);
  const { businessHoursId, followUpHoursId, ...rest } = data;
  const hasBh = businessHoursId !== undefined;
  const hasFuh = followUpHoursId !== undefined;
  if (Object.keys(rest).length === 0 && !hasBh && !hasFuh) {
    throw new AppError(
      "no updatable fields provided",
      400,
      "errors.noUpdatableFields",
    );
  }
  // NOTE: A malformed id is a 400 here, not the ownership check's 404, which would say the row is
  // gone; the same answer as a malformed tool-grant id (`bigOrThrow`).
  return {
    data,
    rest,
    hasBh,
    hasFuh,
    businessHoursId:
      hasBh && businessHoursId !== null
        ? requireDbId(businessHoursId, "businessHoursId")
        : null,
    followUpHoursId:
      hasFuh && followUpHoursId !== null
        ? requireDbId(followUpHoursId, "followUpHoursId")
        : null,
  };
}

// The observer refusal that `updateAgent` (non-monitoring mode) and `deleteAgent` make inside their
// transactions, askable on its own so the MCP previews answer the same. Asks about the AGENT, not the
// move, so a production agent a race left observing is refused too.
export async function assertAgentNotObserving(
  ctx: TenantContext,
  id: bigint,
  base?: PrismaClient,
): Promise<void> {
  const observing = await runScopedOn(base ?? basePrisma, ctx, (db) =>
    db.inboxObserver.count({ where: { agentId: id } }),
  );
  if (observing > 0) {
    throw new AppError(
      "this agent observes inboxes; remove it as an observer first",
      422,
      "errors.agentObservesInboxes",
    );
  }
}

export async function updateAgent(
  ctx: TenantContext,
  id: bigint,
  patch: AgentUpdate,
  base: PrismaClient = basePrisma,
  // `expectedUpdatedAt`: optimistic concurrency, 409 (errors.agentModifiedElsewhere) on a mismatch;
  // omitted, last write wins. `settingsMode: "replace"` says the bag is COMPLETE, so omitted blocks
  // are meant to go; without it, a bag that would drop configured blocks is refused.
  opts: { expectedUpdatedAt?: Date; settingsMode?: "replace" } = {},
): Promise<AgentDto> {
  const {
    rest,
    hasBh,
    hasFuh,
    businessHoursId: bhId,
    followUpHoursId: fuhId,
  } = assertAgentUpdatable(patch);
  const dto = await runScopedOn(base, ctx, async (db) => {
    await assertSchedulesExistOn(db, bhId, fuhId);
    const updateData: Record<string, unknown> = { ...rest };
    if (hasBh) updateData.businessHoursId = bhId;
    if (hasFuh) updateData.followUpHoursId = fuhId;
    // The row lock (held to commit) serializes the follow-up fence's read-compute-write, so a
    // stale ON cannot land after an OFF with an old watermark. NO KEY UPDATE, not FOR UPDATE: it still
    // conflicts with saves and `deleteAgent` but not with the FOR KEY SHARE a foreign-key reference
    // takes, so a save does not stall `bindInbox`. RLS still applies to the raw read.
    const beforeRows = await db.$queryRaw<
      Array<{
        enabled: boolean;
        mode: string;
        settings: unknown;
        model_config: unknown;
        updated_at: Date;
      }>
    >`SELECT enabled, mode, settings, model_config, updated_at FROM agents WHERE id = ${id} FOR NO KEY UPDATE`;
    const before = beforeRows[0];
    // Read AFTER the lock, and that order is the whole point. The raw lock above reads the
    // four columns the follow-up fence needs; the trail answers for every column an operator can
    // write, and which of the three actions this call IS comes from comparing them
    // (audit-projection.ts). Taken BEFORE the lock, this read can observe state A, wait on the lock
    // while another save commits B, and then have its own write applied against B while the row
    // says A — and a write that restores A would compare equal and go unrecorded entirely, which is
    // the one outcome an audit trail cannot have.
    const beforeRow = await db.agent.findUnique({
      where: { id },
      select: AGENT_SELECT,
    });
    // NOTE: The optimistic-concurrency check comes FIRST, on the locked row. A stale editor resends
    // the settings it loaded, so if the other writer edited a capped field our copy of it is an edit
    // too — validating first would answer 400 "text too long" to what is really a 409, and the
    // editor's conflict flow (reload, or save again to overwrite) would never run. A forced retry
    // sends no precondition and still gets validated.
    if (
      before &&
      opts.expectedUpdatedAt != null &&
      before.updated_at.getTime() !== opts.expectedUpdatedAt.getTime()
    ) {
      throw new AppError(
        "agent was modified elsewhere",
        409,
        "errors.agentModifiedElsewhere",
      );
    }
    // NOTE: Inside the lock, against the row this write replaces — reading the stored bag separately
    // would compare against a value another writer could have changed in between.
    // FIRST of the settings rules, because it is the only structural one: the others ask whether a
    // value is allowed, this one asks whether the write keeps the blocks it does not mention. A bag
    // that is both partial and carries a bad value has a bigger problem than the value.
    if (opts.settingsMode !== "replace") {
      assertSettingsBlocksKept(rest.settings, before?.settings);
    }
    assertSettingsTextSizes(rest.settings, before?.settings);
    assertSettingsDebugWindow(rest.settings, before?.settings);
    assertSettingsModelFallback(rest.settings, before?.settings, "replace");
    assertSettingsSignature(rest.settings, before?.settings);
    assertSettingsToolPreconditions(rest.settings, before?.settings);
    assertSettingsContactAuthRule(rest.settings, before?.settings);
    assertSettingsContactFields(rest.settings, before?.settings);
    assertSettingsRetiredLabelKeys(rest.settings);
    stripRetiredNoteFlagInPlace(rest.settings);
    stripDerivedFullDetailInPlace(rest.settings);
    assertSettingsProtectedLabels(rest.settings, before?.settings);
    assertResolveLabelsNotProtected(rest.settings);
    // LAST of the settings rules, after both strips: the dedicated rules above answer their fields
    // with their own sentences, and a retired or derived key is gone before the schema is asked.
    assertSettingsClosedValues(rest.settings, before?.settings);
    // NOTE: An inbox OBSERVER answers nothing whatever its mode, so a non-monitoring mode is refused
    // while an observer row stands: the binding has to go first. Asked of the TARGET mode, not the
    // move, so a race that left a production observer cannot pass every later write.
    if (before && rest.mode !== undefined && !isMonitoring(rest.mode)) {
      const observing = await db.inboxObserver.count({
        where: { agentId: id },
      });
      if (observing > 0) {
        throw new AppError(
          "this agent observes inboxes; remove it as an observer first",
          422,
          "errors.agentObservesInboxes",
        );
      }
    }
    // NOTE: Inside the lock and against the same row, for the reason above: "did this write change
    // the ref" has to be asked of the value this write replaces. It also rewrites `rest` in place,
    // so the normalization below copies the canonical bag rather than the submitted one.
    await assertCredentialRefsResolve(db, rest, {
      modelConfig: before?.model_config,
      settings: before?.settings,
    });
    // See normalizeSettingsForStorage — the host list is reduced to hosts on the way IN, on
    // every write path, not only when it is read back.
    const normalizedSettings = normalizeSettingsForStorage(rest.settings);
    if (normalizedSettings) updateData.settings = normalizedSettings;
    if (before) {
      const after = {
        enabled: rest.enabled !== undefined ? rest.enabled : before.enabled,
        mode: rest.mode !== undefined ? rest.mode : before.mode,
        settings: rest.settings !== undefined ? rest.settings : before.settings,
      };
      // Promotion to production re-arms even with follow-up already effectively ON: the
      // eligible set widens from /teste-activated conversations to EVERY pending one, and keeping a
      // watermark from the test period would blast the whole pre-promotion backlog (the community
      // incident this fence exists to prevent).
      const promotedToProduction =
        before.mode !== "production" && after.mode === "production";
      if (
        effectiveFollowUpOn(after) &&
        (!effectiveFollowUpOn(before) || promotedToProduction)
      ) {
        updateData.followUpArmedAt = new Date();
      }
    }
    // updateMany so a cross-tenant id (invisible under RLS) yields count 0 → NotFound, rather
    // than a P2025 throw. The $extends does not auto-scope updates, but RLS does. With an
    // expectedUpdatedAt precondition (editor optimistic concurrency), it joins the filter: count 0
    // then means the row is gone OR another writer advanced updatedAt — a re-read disambiguates so
    // the caller gets 404 (gone) vs 409 (stale).
    const where =
      opts.expectedUpdatedAt != null
        ? { id, updatedAt: opts.expectedUpdatedAt }
        : { id };
    const res = await db.agent.updateMany({ where, data: updateData });
    if (res.count === 0) {
      if (opts.expectedUpdatedAt != null) {
        const exists = await db.agent.findUnique({
          where: { id },
          select: { id: true },
        });
        if (exists) {
          throw new AppError(
            "agent was modified elsewhere",
            409,
            "errors.agentModifiedElsewhere",
          );
        }
      }
      throw new NotFoundError("agent not found");
    }
    const row = await db.agent.findUniqueOrThrow({
      where: { id },
      select: AGENT_SELECT,
    });
    const applied = toDto(row);
    if (beforeRow) {
      const audit = agentUpdateAudit(
        toDto(beforeRow) as unknown as Record<string, unknown>,
        applied as unknown as Record<string, unknown>,
      );
      if (audit) {
        await auditMutation(db, ctx, {
          action: audit.action,
          target: `agent:${id}`,
          before: audit.before,
          after: audit.after,
        });
      }
    }
    return applied;
  });
  // Arm the sweep if settings were updated and follow-up is now enabled (idempotent).
  if (rest.settings !== undefined && ctx.tenantId !== null) {
    const cfg = readFollowUpConfig(dto.settings);
    if (cfg.enabled) await ensureTenantSweep(ctx.tenantId, base);
  }
  // Keep the persona's Chatwoot bot name(s) in sync on rename (best-effort; no-op if not bound).
  if (rest.name !== undefined && ctx.tenantId !== null) {
    await renameAgentBots(ctx.tenantId, id, dto.name, { base });
  }
  // Heads-up for any open editor (other tab / another operator) that this agent's config changed, so
  // it can warn before overwriting. Best-effort, metadata-only; the save precondition is the real gate.
  if (ctx.tenantId !== null) {
    broadcastAgentConfigEvent(ctx.tenantId, {
      agentId: id.toString(),
      updatedAt: dto.updatedAt.toISOString(),
    });
  }
  return dto;
}

// modelConfig may be {} (unconfigured — the agent simply won't run until set); any non-empty value
// must be a full, valid model config (immediate feedback instead of a silent no-run at invoke).
function validateModelConfigForWrite(raw: unknown): void {
  if (raw == null) return;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new AppError(
      "modelConfig must be an object",
      400,
      "errors.invalidModelConfig",
    );
  }
  if (Object.keys(raw as Record<string, unknown>).length === 0) return;
  const parsed = modelConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(
      `invalid model config: ${parsed.error.message}`,
      400,
      "errors.invalidModelConfigDetail",
      { reason: parsed.error.message },
    );
  }
}

export function requireTenant(ctx: TenantContext): bigint {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx.tenantId;
}

export const agentCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    systemPrompt: z.string().max(config.agent.promptMaxChars).optional(),
    enabled: z.boolean().optional(),
    mode: z.enum(AGENT_MODES).optional(),
    transferWithSummary: z.boolean().optional(),
    modelConfig: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    businessHoursId: z.string().nullable().optional(),
    followUpHoursId: z.string().nullable().optional(),
  })
  .strict();
export type AgentCreate = z.infer<typeof agentCreateSchema>;

// The two schedule ids EXIST, asked on whatever scoped handle the caller already has. It reads,
// so it lives here rather than in `assertAgentCreatable`, which is pure.
async function assertSchedulesExistOn(
  db: ScopedDb,
  businessHoursId: bigint | null,
  followUpHoursId: bigint | null,
): Promise<void> {
  for (const id of [businessHoursId, followUpHoursId]) {
    if (id === null) continue;
    const row = await db.businessHours.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!row) {
      throw new NotFoundError(
        "business hours not found",
        "errors.businessHoursNotFound",
      );
    }
  }
}

// The half of `createAgent`'s verdict that has to read. ADVISORY, like the uniqueness checks: the
// schedule it finds can be deleted before the apply arrives, and the scoped read inside the write
// stays the authority. `assertAgentCreatable` already parses both ids and hands them back, so the
// preview passes those rather than parsing a second time — a caller that re-parsed could disagree
// with the write about which row it even asked for.
export async function assertSchedulesExist(
  ctx: TenantContext,
  businessHoursId: bigint | null,
  followUpHoursId: bigint | null,
  base: PrismaClient = basePrisma,
): Promise<void> {
  if (businessHoursId === null && followUpHoursId === null) return;
  await runScopedOn(base, ctx, (db) =>
    assertSchedulesExistOn(db, businessHoursId, followUpHoursId),
  );
}

// Everything `createAgent` can refuse WITHOUT reading the database, shared with the MCP dry run so the
// preview gives the apply's verdict. Returns the parsed row so the caller does not parse twice.
export function assertAgentCreatable(input: AgentCreate): {
  data: AgentCreate;
  businessHoursId: bigint | null;
  followUpHoursId: bigint | null;
} {
  assertPromptSize(input.systemPrompt);
  assertSettingsTextSizes(input.settings, undefined);
  assertSettingsDebugWindow(input.settings, undefined);
  assertSettingsModelFallback(input.settings, undefined, "replace");
  assertSettingsSignature(input.settings, undefined);
  assertSettingsToolPreconditions(input.settings, undefined);
  assertSettingsContactAuthRule(input.settings, undefined);
  assertSettingsContactFields(input.settings, undefined);
  assertSettingsRetiredLabelKeys(input.settings);
  stripRetiredNoteFlagInPlace(input.settings);
  stripDerivedFullDetailInPlace(input.settings);
  assertSettingsProtectedLabels(input.settings, undefined);
  assertResolveLabelsNotProtected(input.settings);
  assertSettingsClosedValues(input.settings, undefined);
  const data = parseInput(agentCreateSchema, input);
  validateModelConfigForWrite(data.modelConfig);
  // NOTE: the two schedule ids are parsed HERE and handed back, not left to the caller. They are a
  // pure judgement about the input — a malformed id, or one past the column's range — and leaving
  // them out let the preview approve an `agent_create` the apply then 400s on. The ids come back
  // rather than being parsed twice, so the two readings cannot disagree.
  return {
    data,
    businessHoursId:
      data.businessHoursId != null
        ? requireDbId(data.businessHoursId, "businessHoursId")
        : null,
    followUpHoursId:
      data.followUpHoursId != null
        ? requireDbId(data.followUpHoursId, "followUpHoursId")
        : null,
  };
}

export async function createAgent(
  ctx: TenantContext,
  input: AgentCreate,
  base: PrismaClient = basePrisma,
): Promise<AgentDto> {
  const tenantId = requireTenant(ctx);
  const {
    data,
    businessHoursId: bhId,
    followUpHoursId: fuhId,
  } = assertAgentCreatable(input);
  const dto = await runScopedOn(base, ctx, async (db) => {
    if (bhId !== null) {
      const bh = await db.businessHours.findUnique({
        where: { id: bhId },
        select: { id: true },
      });
      if (!bh) {
        throw new NotFoundError(
          "business hours not found",
          "errors.businessHoursNotFound",
        );
      }
    }
    if (fuhId !== null) {
      const fuh = await db.businessHours.findUnique({
        where: { id: fuhId },
        select: { id: true },
      });
      if (!fuh) {
        throw new NotFoundError(
          "business hours not found",
          "errors.businessHoursNotFound",
        );
      }
    }
    // NOTE: Nothing is stored yet, so every ref the payload carries is one this write introduces.
    // Rewrites `data` in place; both bags below read from it.
    await assertCredentialRefsResolve(db, data, {});
    const createShape = {
      enabled: data.enabled ?? true,
      // NOTE: New agents are born in test mode (operator opt-in before going live).
      mode: data.mode ?? "test",
      settings: (data.settings ?? {}) as Prisma.InputJsonValue,
    };
    const row = await db.agent.create({
      data: {
        tenantId,
        name: data.name,
        systemPrompt: data.systemPrompt ?? "",
        enabled: createShape.enabled,
        mode: createShape.mode,
        transferWithSummary: data.transferWithSummary ?? true,
        modelConfig: (data.modelConfig ??
          DEFAULT_MODEL_CONFIG) as Prisma.InputJsonValue,
        settings: (normalizeSettingsForStorage(createShape.settings) ??
          createShape.settings) as Prisma.InputJsonValue,
        businessHoursId: bhId,
        followUpHoursId: fuhId,
        // NOTE: Born already effectively follow-up-ON (enabled + followUp.enabled, any mode: the
        // sweep admits /teste-activated conversations) → armed from creation, so only post-creation
        // episodes are swept.
        ...(effectiveFollowUpOn(createShape)
          ? { followUpArmedAt: new Date() }
          : {}),
      },
      select: AGENT_SELECT,
    });
    const created = toDto(row);
    await auditMutation(db, ctx, {
      action: "agent.create",
      target: `agent:${created.id}`,
      after: auditSafe({
        id: created.id,
        name: created.name,
        enabled: created.enabled,
      }),
    });
    return created;
  });
  // Arm the sweep if follow-up is enabled on the new agent (idempotent).
  const followUpCfg = readFollowUpConfig(dto.settings);
  if (followUpCfg.enabled) await ensureTenantSweep(tenantId, base);
  return dto;
}

export async function deleteAgent(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    // Read inside the transaction that deletes AND under its lock: the row is what the record is
    // OF, and after the statement there is nothing left to name it with. Unlocked, a rename that
    // commits between this read and the delete leaves an `agent.update` saying A→B followed by an
    // `agent.delete` claiming A was what went.
    const doomedRows = await db.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM agents WHERE id = ${id} FOR UPDATE`;
    const doomed = doomedRows[0];
    // An OBSERVER binding is a bot attached on Chatwoot's side, and the cascade
    // below would retire the row and the route token while the fork kept delivering to a bot that
    // is gone. The detach is a Chatwoot call, which this transaction cannot make, so the deletion
    // is refused while the agent observes anything — the same answer its mode change gets.
    const observing = await db.inboxObserver.count({ where: { agentId: id } });
    if (observing > 0) {
      throw new AppError(
        "this agent observes inboxes; remove it as an observer first",
        422,
        "errors.agentObservesInboxes",
      );
    }
    // Inbox.agentId and Experiment.agentId are plain references (no FK cascade) — null them so a
    // deleted agent leaves no dangling binding. AgentToolSelection cascades via its FK.
    await db.inbox.updateMany({
      where: { agentId: id },
      data: { agentId: null, responderBoundAt: null },
    });
    await db.experiment.updateMany({
      where: { agentId: id },
      data: { agentId: null },
    });
    const res = await db.agent.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    await auditMutation(db, ctx, {
      action: "agent.delete",
      target: `agent:${id}`,
      before: auditSafe({ id: String(id), name: doomed?.name }),
      after: null,
    });
  });
  // NOTE: ChatwootAgentBot cascades off the agent (schema.prisma: `onDelete: Cascade`), so deleting a
  // persona retires its route token without this module ever naming one. The receiver caches
  // resolutions by token hash and would keep authenticating the retired one from memory.
  invalidateRouteTokenCache();
}

export async function cloneAgent(
  ctx: TenantContext,
  id: bigint,
  newName: string | undefined,
  base: PrismaClient = basePrisma,
): Promise<AgentDto> {
  const tenantId = requireTenant(ctx);
  return runScopedOn(base, ctx, async (db) => {
    // NOTE: The namespace lock BEFORE the grants are read: a tool deleted between the read and the
    // insert would fail the foreign key and the whole clone with it. Behind the lock the delete either
    // cascades first (nothing to copy) or waits.
    await lockToolNames(db);
    const src = await db.agent.findUnique({
      where: { id },
      select: {
        name: true,
        systemPrompt: true,
        modelConfig: true,
        settings: true,
        businessHoursId: true,
        followUpHoursId: true,
        transferWithSummary: true,
      },
    });
    if (!src) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    // The bag is copied verbatim, over-cap text included. A clone authors nothing, and refusing
    // it would make a legacy agent unclonable while its own saves go through.
    const grants = await db.agentToolSelection.findMany({
      where: { agentId: id },
      select: {
        source: true,
        toolDefinitionId: true,
        mcpServerConnectionId: true,
        integrationInstanceId: true,
        documentTemplateId: true,
        codeToolDefinitionId: true,
        knowledgeBaseIds: true,
        enabledTools: true,
      },
    });
    // A clone starts DISABLED: review the copy before it goes live.
    const created = await db.agent.create({
      data: {
        tenantId,
        name: newName?.trim() || `${src.name} (copy)`,
        systemPrompt: src.systemPrompt,
        modelConfig: (src.modelConfig ?? {}) as Prisma.InputJsonValue,
        settings: (src.settings ?? {}) as Prisma.InputJsonValue,
        businessHoursId: src.businessHoursId,
        followUpHoursId: src.followUpHoursId,
        transferWithSummary: src.transferWithSummary,
        enabled: false,
      },
      select: AGENT_SELECT,
    });
    if (grants.length > 0) {
      await db.agentToolSelection.createMany({
        data: grants.map((g) => ({
          tenantId,
          agentId: created.id,
          source: g.source,
          toolDefinitionId: g.toolDefinitionId,
          mcpServerConnectionId: g.mcpServerConnectionId,
          integrationInstanceId: g.integrationInstanceId,
          documentTemplateId: g.documentTemplateId,
          codeToolDefinitionId: g.codeToolDefinitionId,
          knowledgeBaseIds: g.knowledgeBaseIds,
          enabledTools: g.enabledTools,
        })),
      });
    }
    const clone = toDto(created);
    await auditMutation(db, ctx, {
      action: "agent.clone",
      target: `agent:${clone.id}`,
      after: auditSafe({
        id: clone.id,
        name: clone.name,
        clonedFrom: String(id),
      }),
    });
    return clone;
  });
}

// ── tool selection (the unified per-agent grant set) ──

const AGENT_TOOL_SOURCES = [
  "NATIVE",
  "RAG",
  "HTTP",
  "MCP",
  "INTEGRATION",
  "DOCUMENT",
  "CODE",
] as const;
type AgentToolSourceLit = (typeof AGENT_TOOL_SOURCES)[number];

export interface ToolGrantInput {
  source: string;
  toolDefinitionId?: string | null;
  mcpServerConnectionId?: string | null;
  integrationInstanceId?: string | null;
  documentTemplateId?: string | null;
  codeToolDefinitionId?: string | null;
  knowledgeBaseIds?: string[];
  enabledTools?: string[];
}

export interface ToolGrantDto {
  source: AgentToolSourceLit;
  toolDefinitionId: string | null;
  mcpServerConnectionId: string | null;
  integrationInstanceId: string | null;
  documentTemplateId: string | null;
  codeToolDefinitionId: string | null;
  knowledgeBaseIds: string[];
  enabledTools: string[];
}

const DELIVERS_TO_CUSTOMER = new Set<string>(
  CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES,
);

export interface ToolSelectionView {
  grants: ToolGrantDto[];
  catalog: {
    // `deliversToCustomer` is what a MUTED turn will not be offered (the observer's): the editor
    // reads it instead of keeping its own list of names.
    native: { name: string; deliversToCustomer?: boolean }[];
    rag: { name: string }[];
    toolDefinitions: {
      id: string;
      name: string;
      label: string;
      enabled: boolean;
    }[];
    mcpConnections: { id: string; name: string; enabled: boolean }[];
    integrationInstances: {
      id: string;
      catalogType: string;
      kind: string | null;
      name: string;
      enabled: boolean;
      tools: {
        name: string;
        args: { name: string; description?: string; required: boolean }[];
        // Same question the natives above answer, from the pack's own spec.
        deliversToCustomer?: boolean;
      }[];
    }[];
    // Operator-authored code tools; `name` is what the agent calls.
    codeTools: { id: string; name: string; label: string; enabled: boolean }[];
    documentTemplates: {
      id: string;
      name: string;
      // The tool name the agent will see (send_<slug>), so the editor shows WHAT it grants rather
      // than making the operator derive it from the template name.
      toolName: string;
      description: string | null;
      enabled: boolean;
      // Whether the RUNTIME would actually expose this tool, which is a different question from the
      // stored flag: assembly also skips a template whose content this build cannot parse — one
      // written by a newer version, after a downgrade — because a tool with an empty argument list
      // that renders a blank document is worse for the customer than a tool the agent does not
      // have. A screen that answers "what can this agent call" has to ask the same question the
      // assembly does, or it draws a tool that is not in the graph.
      available: boolean;
    }[];
    knowledgeBases: {
      id: string;
      name: string;
      description: string | null;
      // How many documents are imported but not yet indexed (status UNINDEXED). Drives the editor's
      // "this base needs indexing" warning; zero once every document is indexed.
      unindexedCount: number;
    }[];
  };
  // The agent's version token (its updatedAt), so the editor can capture it after a grant save for the
  // optimistic-concurrency precondition. null when the agent row is absent. Replacing the grant set
  // bumps this (see replaceAgentToolSelections) so a single token covers the whole editor.
  agentUpdatedAt: Date | null;
}

interface NormalizedGrant {
  source: AgentToolSourceLit;
  toolDefinitionId: bigint | null;
  mcpServerConnectionId: bigint | null;
  integrationInstanceId: bigint | null;
  documentTemplateId: bigint | null;
  codeToolDefinitionId: bigint | null;
  knowledgeBaseIds: bigint[];
  enabledTools: string[];
}

// Every grant's id, from REST and from MCP alike, and both halves of "is this an id?" matter here.
// `BigInt` accepts spellings a column does not (`0x11` is 17n), so a request that never named the
// template it got could be handed one — and it accepts values past 2^63-1, which reach the database
// as a bind error and answer 500 on a path that advertises a validation error. `parseDbId` holds
// both; see lib/db-id.ts.
function bigOrThrow(v: string | null | undefined, field: string): bigint {
  if (v == null) {
    throw new AppError(
      `${field} is required`,
      400,
      "errors.toolGrantIdRequired",
      { field },
      field,
    );
  }
  const id = parseDbId(v);
  if (id === null) {
    throw new AppError(
      `${field} must be a numeric id`,
      400,
      "errors.toolGrantIdInvalid",
      { field },
      field,
    );
  }
  return id;
}

// Shape + enum-membership validation (no DB). Ownership of referenced ids and the integration
// tool-name allowlist are validated inside the scoped tx (cross-tenant ids are invisible there).
function normalizeGrants(input: ToolGrantInput[]): NormalizedGrant[] {
  const out: NormalizedGrant[] = [];
  let sawNative = false;
  let sawRag = false;
  const httpSeen = new Set<string>();
  const codeSeen = new Set<string>();
  const mcpSeen = new Set<string>();
  const intSeen = new Set<string>();
  const docSeen = new Set<string>();
  const nativeSet = new Set<string>(NATIVE_TOOL_NAMES);
  const ragSet = new Set<string>(RAG_TOOL_NAMES);
  for (const g of input) {
    const enabledTools = (g.enabledTools ?? []).filter(
      (x): x is string => typeof x === "string",
    );
    switch (g.source) {
      case "NATIVE": {
        if (sawNative) {
          throw new AppError(
            "duplicate NATIVE grant",
            400,
            "errors.toolGrantDuplicate",
            { source: "NATIVE" },
          );
        }
        sawNative = true;
        const bad = enabledTools.find((t) => !nativeSet.has(t));
        if (bad) {
          throw new AppError(
            `unknown native tool: ${bad}`,
            400,
            "errors.toolGrantUnknownTool",
            { tool: bad, source: "NATIVE" },
          );
        }
        out.push({
          source: "NATIVE",
          toolDefinitionId: null,
          mcpServerConnectionId: null,
          integrationInstanceId: null,
          documentTemplateId: null,
          codeToolDefinitionId: null,
          knowledgeBaseIds: [],
          enabledTools,
        });
        break;
      }
      case "RAG": {
        if (sawRag) {
          throw new AppError(
            "duplicate RAG grant",
            400,
            "errors.toolGrantDuplicate",
            { source: "RAG" },
          );
        }
        sawRag = true;
        const bad = enabledTools.find((t) => !ragSet.has(t));
        if (bad) {
          throw new AppError(
            `unknown rag tool: ${bad}`,
            400,
            "errors.toolGrantUnknownTool",
            { tool: bad, source: "RAG" },
          );
        }
        const knowledgeBaseIds = (g.knowledgeBaseIds ?? []).map((k) =>
          bigOrThrow(k, "knowledgeBaseIds"),
        );
        // A RAG grant that names knowledge bases but no tools is a silent no-op: assemble.ts only
        // builds ragConfig (the search_knowledge tool) when enabledTools is non-empty, so the KB would
        // be "granted" yet unreachable. Default to search_knowledge so granting a KB without listing
        // tools (e.g. via MCP agent_tools_set) actually works.
        const ragTools =
          enabledTools.length === 0 && knowledgeBaseIds.length > 0
            ? ["search_knowledge"]
            : enabledTools;
        out.push({
          source: "RAG",
          toolDefinitionId: null,
          mcpServerConnectionId: null,
          integrationInstanceId: null,
          documentTemplateId: null,
          codeToolDefinitionId: null,
          knowledgeBaseIds,
          enabledTools: ragTools,
        });
        break;
      }
      case "HTTP": {
        const id = bigOrThrow(g.toolDefinitionId, "toolDefinitionId");
        if (httpSeen.has(String(id))) {
          throw new AppError(
            "duplicate HTTP grant",
            400,
            "errors.toolGrantDuplicate",
            { source: "HTTP" },
          );
        }
        httpSeen.add(String(id));
        out.push({
          source: "HTTP",
          toolDefinitionId: id,
          mcpServerConnectionId: null,
          integrationInstanceId: null,
          documentTemplateId: null,
          codeToolDefinitionId: null,
          knowledgeBaseIds: [],
          enabledTools: [],
        });
        break;
      }
      case "MCP": {
        const id = bigOrThrow(g.mcpServerConnectionId, "mcpServerConnectionId");
        if (mcpSeen.has(String(id))) {
          throw new AppError(
            "duplicate MCP grant",
            400,
            "errors.toolGrantDuplicate",
            { source: "MCP" },
          );
        }
        mcpSeen.add(String(id));
        out.push({
          source: "MCP",
          toolDefinitionId: null,
          mcpServerConnectionId: id,
          integrationInstanceId: null,
          documentTemplateId: null,
          codeToolDefinitionId: null,
          knowledgeBaseIds: [],
          enabledTools,
        });
        break;
      }
      case "INTEGRATION": {
        const id = bigOrThrow(g.integrationInstanceId, "integrationInstanceId");
        if (intSeen.has(String(id))) {
          throw new AppError(
            "duplicate INTEGRATION grant",
            400,
            "errors.toolGrantDuplicate",
            { source: "INTEGRATION" },
          );
        }
        intSeen.add(String(id));
        out.push({
          source: "INTEGRATION",
          toolDefinitionId: null,
          mcpServerConnectionId: null,
          integrationInstanceId: id,
          documentTemplateId: null,
          codeToolDefinitionId: null,
          knowledgeBaseIds: [],
          enabledTools,
        });
        break;
      }
      case "DOCUMENT": {
        const id = bigOrThrow(g.documentTemplateId, "documentTemplateId");
        if (docSeen.has(String(id))) {
          throw new AppError(
            "duplicate DOCUMENT grant",
            400,
            "errors.toolGrantDuplicate",
            { source: "DOCUMENT" },
          );
        }
        docSeen.add(String(id));
        out.push({
          source: "DOCUMENT",
          toolDefinitionId: null,
          mcpServerConnectionId: null,
          integrationInstanceId: null,
          documentTemplateId: id,
          codeToolDefinitionId: null,
          // NOTE: no enabledTools. A template grant exposes exactly one tool — the one derived from
          // that template — so there is nothing to narrow, and an allowlist here would be a second
          // switch for the grant itself.
          knowledgeBaseIds: [],
          enabledTools: [],
        });
        break;
      }
      case "CODE": {
        const id = bigOrThrow(g.codeToolDefinitionId, "codeToolDefinitionId");
        if (codeSeen.has(String(id))) {
          throw new AppError(
            "duplicate CODE grant",
            400,
            "errors.toolGrantDuplicate",
            { source: "CODE" },
          );
        }
        codeSeen.add(String(id));
        out.push({
          source: "CODE",
          toolDefinitionId: null,
          mcpServerConnectionId: null,
          integrationInstanceId: null,
          documentTemplateId: null,
          codeToolDefinitionId: id,
          // NOTE: one tool per grant, like a document template: nothing to narrow.
          knowledgeBaseIds: [],
          enabledTools: [],
        });
        break;
      }
      default:
        throw new AppError(
          `unknown tool source: ${g.source}`,
          400,
          "errors.toolGrantUnknownSource",
          { source: String(g.source) },
        );
    }
  }
  return out;
}

function toGrantDto(g: {
  source: AgentToolSourceLit;
  toolDefinitionId: bigint | null;
  mcpServerConnectionId: bigint | null;
  integrationInstanceId: bigint | null;
  documentTemplateId: bigint | null;
  codeToolDefinitionId: bigint | null;
  knowledgeBaseIds: bigint[];
  enabledTools: string[];
}): ToolGrantDto {
  return {
    source: g.source,
    toolDefinitionId:
      g.toolDefinitionId === null ? null : String(g.toolDefinitionId),
    mcpServerConnectionId:
      g.mcpServerConnectionId === null ? null : String(g.mcpServerConnectionId),
    integrationInstanceId:
      g.integrationInstanceId === null ? null : String(g.integrationInstanceId),
    documentTemplateId:
      g.documentTemplateId === null ? null : String(g.documentTemplateId),
    codeToolDefinitionId:
      g.codeToolDefinitionId === null ? null : String(g.codeToolDefinitionId),
    knowledgeBaseIds: g.knowledgeBaseIds.map((k) => String(k)),
    enabledTools: g.enabledTools,
  };
}

// Just the granted set, for the audit snapshot. `buildToolSelectionView` answers a different
// question — it also loads every tool definition, MCP connection, integration, knowledge base and
// document template, plus a tenant-wide groupBy for unindexed documents — and the snapshot is taken
// while holding the agent's row lock, where that catalog would be paid twice and held open.
async function readGrantSet(
  db: ScopedDb,
  agentId: bigint,
): Promise<ToolGrantDto[]> {
  const grants = await db.agentToolSelection.findMany({
    where: { agentId },
    select: {
      source: true,
      toolDefinitionId: true,
      mcpServerConnectionId: true,
      integrationInstanceId: true,
      documentTemplateId: true,
      codeToolDefinitionId: true,
      knowledgeBaseIds: true,
      enabledTools: true,
    },
    orderBy: { id: "asc" },
  });
  return grants.map(toGrantDto);
}

async function buildToolSelectionView(
  db: ScopedDb,
  agentId: bigint,
): Promise<ToolSelectionView> {
  const grants = await db.agentToolSelection.findMany({
    where: { agentId },
    select: {
      source: true,
      toolDefinitionId: true,
      mcpServerConnectionId: true,
      integrationInstanceId: true,
      documentTemplateId: true,
      codeToolDefinitionId: true,
      knowledgeBaseIds: true,
      enabledTools: true,
    },
    orderBy: { id: "asc" },
  });
  const toolDefinitions = await db.toolDefinition.findMany({
    select: {
      id: true,
      name: true,
      label: true,
      enabled: true,
    },
    orderBy: { name: "asc" },
  });
  const mcpConnections = await db.mcpServerConnection.findMany({
    select: { id: true, name: true, enabled: true },
    orderBy: { name: "asc" },
  });
  const integrationInstances = await db.integrationInstance.findMany({
    select: { id: true, catalogType: true, name: true, enabled: true },
    orderBy: { name: "asc" },
  });
  const knowledgeBases = await db.knowledgeBase.findMany({
    select: { id: true, name: true, description: true },
    orderBy: { name: "asc" },
  });
  const codeTools = await db.codeToolDefinition.findMany({
    select: { id: true, name: true, label: true, enabled: true },
    orderBy: { name: "asc" },
  });
  const documentTemplates = await db.documentTemplate.findMany({
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      enabled: true,
      // Selected to answer `available` below, the same way the toolset assembly answers it.
      blocks: true,
      fields: true,
      style: true,
    },
    orderBy: { name: "asc" },
  });
  // Per-KB count of documents imported but not yet indexed (an agent import that bundled the source
  // text lands them as UNINDEXED). groupBy keeps this robust regardless of Prisma's filtered-_count
  // support.
  const unindexedGroups = await db.knowledgeDocument.groupBy({
    by: ["knowledgeBaseId"],
    where: { status: "UNINDEXED" },
    _count: { _all: true },
  });
  const unindexedByKb = new Map<bigint, number>();
  for (const g of unindexedGroups) {
    unindexedByKb.set(g.knowledgeBaseId, g._count._all);
  }
  const agent = await db.agent.findUnique({
    where: { id: agentId },
    select: { updatedAt: true },
  });
  return {
    agentUpdatedAt: agent?.updatedAt ?? null,
    grants: grants.map(toGrantDto),
    catalog: {
      native: GRANTABLE_NATIVE_TOOL_NAMES.map((n) => ({
        name: n,
        ...(DELIVERS_TO_CUSTOMER.has(n) ? { deliversToCustomer: true } : {}),
      })),
      rag: RAG_TOOL_NAMES.map((n) => ({ name: n })),
      toolDefinitions: toolDefinitions.map((t) => ({
        id: String(t.id),
        name: t.name,
        label: t.label,
        enabled: t.enabled,
      })),
      mcpConnections: mcpConnections.map((m) => ({
        id: String(m.id),
        name: m.name,
        enabled: m.enabled,
      })),
      // NOTE: A WEBHOOK entry (GENERIC) has no tools to grant: offering it here would list a
      // selectable integration that gives the agent nothing.
      integrationInstances: integrationInstances
        .filter((i) => getCatalogEntry(i.catalogType)?.kind !== "WEBHOOK")
        .map((i) => ({
          id: String(i.id),
          catalogType: i.catalogType,
          kind: getCatalogEntry(i.catalogType)?.kind ?? null,
          name: i.name,
          enabled: i.enabled,
          // name + arg specs (label/description come from the frontend's toolpackToolMeta).
          tools: getToolpackToolViews(i.catalogType),
        })),
      knowledgeBases: knowledgeBases.map((k) => ({
        id: String(k.id),
        name: k.name,
        description: k.description,
        unindexedCount: unindexedByKb.get(k.id) ?? 0,
      })),
      codeTools: codeTools.map((c) => ({
        id: String(c.id),
        name: c.name,
        label: c.label,
        enabled: c.enabled,
      })),
      documentTemplates: documentTemplates.map((d) => ({
        id: String(d.id),
        name: d.name,
        // The tool name the agent will see, so the editor can show WHAT it is granting rather than
        // making the operator derive it from the template name.
        toolName: documentToolName(d.slug),
        description: d.description,
        enabled: d.enabled,
        available:
          d.enabled && parseTemplateContent(d.blocks, d.fields, d.style).ok,
      })),
    },
  };
}

// The knowledge bases THIS agent is granted that still hold unindexed documents, for the health read.
// Its own query, not `getAgentToolSelections` (the tenant's whole catalog), since health is read on
// every agent write. Scoped to the agent's RAG grant and the bases it names.
export async function listKnowledgeBasesNeedingIndex(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<{ id: string; name: string }[]> {
  return runScopedOn(base, ctx, async (db) => {
    // ONE row, and that is a fact about the table rather than a convention worth defending here:
    // `CREATE UNIQUE INDEX ats_rag_uq ON agent_tool_selections (agent_id) WHERE source = 'RAG'`
    // (the init migration). A second RAG grant is refused by Postgres, so reading "all of them" and
    // merging would be code standing guard over a state that cannot exist. Written down because the
    // question comes up looking answerable in TypeScript — `replaceAgentToolSelections` also throws
    // `duplicate RAG grant`, which reads like the only thing holding the line, and it is not.
    const grant = await db.agentToolSelection.findFirst({
      where: { agentId, source: "RAG" },
      select: { knowledgeBaseIds: true },
    });
    const ids = grant?.knowledgeBaseIds ?? [];
    if (ids.length === 0) return [];
    const unindexed = await db.knowledgeDocument.groupBy({
      by: ["knowledgeBaseId"],
      where: { status: "UNINDEXED", knowledgeBaseId: { in: ids } },
      _count: { _all: true },
    });
    const needing = unindexed
      .filter((g) => g._count._all > 0)
      .map((g) => g.knowledgeBaseId);
    if (needing.length === 0) return [];
    const bases = await db.knowledgeBase.findMany({
      where: { id: { in: needing } },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    return bases.map((k) => ({ id: String(k.id), name: k.name }));
  });
}

export async function getAgentToolSelections(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ToolSelectionView> {
  return runScopedOn(base, ctx, async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { id: true },
    });
    if (!agent) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    return buildToolSelectionView(db, agentId);
  });
}

// Replace-the-set: the editor sends the full desired grant set; we validate ownership + the
// integration tool allowlist, then atomically delete-and-recreate the agent's grants.
// Id lists come off UNCAPPED arrays and each id is a bind parameter (Postgres takes at most 32,767),
// so they are checked in chunks.
const ID_CHUNK = 1000;

// Short-circuits on the first chunk that finds fewer rows than it asked for: no later chunk can
// rescue it.
async function assertAllPresent(
  ids: bigint[],
  count: (chunk: bigint[]) => Promise<number>,
  missing: () => never,
): Promise<void> {
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK);
    if ((await count(chunk)) !== chunk.length) missing();
  }
}

// Every id inside a grant array, checked against what the tenant actually has: an HTTP grant naming
// no tool, an MCP grant naming no connection, and the same for document templates, code tools,
// knowledge bases and integrations (plus the sub-tool allowlist an integration publishes). Shared
// with the preview so it never echoes a set the apply refuses.
async function assertGrantTargetsExist(
  db: ScopedDb,
  grants: NormalizedGrant[],
): Promise<void> {
  const tdIds = [
    ...new Set(
      grants
        .filter((g) => g.source === "HTTP")
        .map((g) => g.toolDefinitionId as bigint),
    ),
  ];
  const mcpIds = [
    ...new Set(
      grants
        .filter((g) => g.source === "MCP")
        .map((g) => g.mcpServerConnectionId as bigint),
    ),
  ];
  const intIds = [
    ...new Set(
      grants
        .filter((g) => g.source === "INTEGRATION")
        .map((g) => g.integrationInstanceId as bigint),
    ),
  ];
  const docIds = [
    ...new Set(
      grants
        .filter((g) => g.source === "DOCUMENT")
        .map((g) => g.documentTemplateId as bigint),
    ),
  ];
  const codeIds = [
    ...new Set(
      grants
        .filter((g) => g.source === "CODE")
        .map((g) => g.codeToolDefinitionId as bigint),
    ),
  ];
  const kbIds = [...new Set(grants.flatMap((g) => g.knowledgeBaseIds))];

  await assertAllPresent(
    tdIds,
    (ids) => db.toolDefinition.count({ where: { id: { in: ids } } }),
    () => {
      throw new NotFoundError(
        "tool definition not found",
        "errors.toolDefinitionNotFound",
      );
    },
  );
  await assertAllPresent(
    mcpIds,
    (ids) => db.mcpServerConnection.count({ where: { id: { in: ids } } }),
    () => {
      throw new NotFoundError(
        "mcp connection not found",
        "errors.mcpConnectionNotFound",
      );
    },
  );
  await assertAllPresent(
    docIds,
    (ids) => db.documentTemplate.count({ where: { id: { in: ids } } }),
    () => {
      throw new NotFoundError(
        "document template not found",
        "errors.documentTemplateNotFound",
      );
    },
  );
  await assertAllPresent(
    codeIds,
    (ids) => db.codeToolDefinition.count({ where: { id: { in: ids } } }),
    () => {
      throw new NotFoundError("code tool not found", "errors.codeToolNotFound");
    },
  );
  await assertAllPresent(
    kbIds,
    (ids) => db.knowledgeBase.count({ where: { id: { in: ids } } }),
    () => {
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    },
  );
  if (intIds.length > 0) {
    // This one GATHERS rather than counts (the catalog type of each instance is the next rule's
    // input), so its short-circuit is the same comparison one chunk at a time.
    const instances: Array<{ id: bigint; catalogType: string }> = [];
    for (let i = 0; i < intIds.length; i += ID_CHUNK) {
      const chunk = intIds.slice(i, i + ID_CHUNK);
      const rows = await db.integrationInstance.findMany({
        where: { id: { in: chunk } },
        select: { id: true, catalogType: true },
      });
      if (rows.length !== chunk.length) {
        throw new NotFoundError(
          "integration instance not found",
          "errors.integrationInstanceNotFound",
        );
      }
      instances.push(...rows);
    }
    const typeById = new Map(
      instances.map((i) => [String(i.id), i.catalogType]),
    );
    for (const g of grants) {
      if (g.source !== "INTEGRATION") continue;
      const catalogType = typeById.get(String(g.integrationInstanceId));
      const allowed = new Set(
        catalogType ? getToolpackToolNames(catalogType) : [],
      );
      const bad = g.enabledTools.find((t) => !allowed.has(t));
      if (bad) {
        throw new AppError(
          `tool ${bad} is not available for integration ${catalogType}`,
          400,
          "errors.toolGrantToolNotInIntegration",
          { tool: bad, integration: String(catalogType) },
        );
      }
    }
  }
}

// The ADVISORY wrapper, and the word is load-bearing for the same reason as everywhere else on this
// surface: it opens its own scoped read outside the write's transaction, so a tool deleted between
// the preview and the apply still refuses there. The check inside `replaceAgentToolSelections`
// stays the authority; this only moves the refusal an operator actually hits to where they asked.
export async function assertAgentToolGrantsResolvable(
  ctx: TenantContext,
  input: ToolGrantInput[],
  base: PrismaClient = basePrisma,
): Promise<void> {
  const grants = normalizeGrants(input);
  await runScopedOn(base, ctx, (db) => assertGrantTargetsExist(db, grants));
}

export async function replaceAgentToolSelections(
  ctx: TenantContext,
  agentId: bigint,
  input: ToolGrantInput[],
  base: PrismaClient = basePrisma,
  // Optimistic concurrency (editor): when set, replacing the set only applies if the agent's updatedAt
  // still matches; a mismatch yields 409. Omitted ⇒ last-write-wins. Mirrors updateAgent's gate.
  opts: { expectedUpdatedAt?: Date } = {},
): Promise<ToolSelectionView> {
  const tenantId = requireTenant(ctx);
  const grants = normalizeGrants(input);
  const view = await runScopedOn(base, ctx, async (db) => {
    // NOTE: The NAMESPACE lock first, before the agent row: deleting a tool takes this lock, then the
    // tool row, then cascades into selections, and the opposite order deadlocks (`40P01`).
    await lockToolNames(db);
    // The agent row is LOCKED before its version is read and the grant snapshot is taken under
    // it: the grant set has no version of its own, so this row serializes two replacements and ties
    // `expectedUpdatedAt` to the snapshot. NO KEY UPDATE as in `updateAgent`. RLS still applies.
    const locked = await db.$queryRaw<Array<{ updated_at: Date }>>`
      SELECT updated_at FROM agents WHERE id = ${agentId} FOR NO KEY UPDATE`;
    const agent = locked[0] ? { updatedAt: locked[0].updated_at } : null;
    if (!agent) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    if (
      opts.expectedUpdatedAt != null &&
      agent.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()
    ) {
      throw new AppError(
        "agent was modified elsewhere",
        409,
        "errors.agentModifiedElsewhere",
      );
    }

    await assertGrantTargetsExist(db, grants);

    // The set as it stands, read before the delete-and-recreate replaces it. Same shape the view
    // returns, so the row's two halves are comparable.
    const grantsBefore = await readGrantSet(db, agentId);
    await db.agentToolSelection.deleteMany({ where: { agentId } });
    if (grants.length > 0) {
      await db.agentToolSelection.createMany({
        data: grants.map((g) => ({
          tenantId,
          agentId,
          source: g.source,
          toolDefinitionId: g.toolDefinitionId,
          mcpServerConnectionId: g.mcpServerConnectionId,
          integrationInstanceId: g.integrationInstanceId,
          documentTemplateId: g.documentTemplateId,
          codeToolDefinitionId: g.codeToolDefinitionId,
          knowledgeBaseIds: g.knowledgeBaseIds,
          enabledTools: g.enabledTools,
        })),
      });
    }
    // Bump the agent's version token so a grants-only change still advances updatedAt — that single
    // token then covers the whole editor (general/behavior via PATCH, tools/knowledge via this path),
    // so an optimistic-concurrency precondition on either save catches a change made through the other.
    await db.agent.update({
      where: { id: agentId },
      data: { updatedAt: new Date() },
    });
    const next = await buildToolSelectionView(db, agentId);
    // Same rule the update path follows: the trail records changes, and the editor resubmits the
    // whole set on every save of the Tools tab.
    if (grantSetChanged(grantsBefore, next.grants)) {
      await auditMutation(db, ctx, {
        action: "agent.tools_set",
        target: `agent:${agentId}`,
        before: auditSafe({ grants: grantsBefore }),
        after: auditSafe({ grants: next.grants }),
      });
    }
    return next;
  }).catch(async (err: unknown) => {
    // NOTE: A target deleted between the existence check and the insert fails the foreign key: the
    // same event as "no such tool", so the check is re-asked in a fresh read to name it. If it finds
    // everything, the original error stands.
    if (err instanceof Error && (err as { code?: string }).code === "P2003") {
      await runScopedOn(base, ctx, (db) => assertGrantTargetsExist(db, grants));
    }
    throw err;
  });
  // Heads-up for any open editor (other tab / another operator) — best-effort, metadata-only.
  if (ctx.tenantId !== null && view.agentUpdatedAt) {
    broadcastAgentConfigEvent(ctx.tenantId, {
      agentId: agentId.toString(),
      updatedAt: view.agentUpdatedAt.toISOString(),
    });
  }
  return view;
}
