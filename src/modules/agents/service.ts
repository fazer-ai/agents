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
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { collectOversizedTextChanges } from "@/modules/agents/text-caps";
import {
  ALLOWED_LABELS_MAX,
  PROTECTED_LABELS_MAX,
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

// NOTE: the cap is a deliberate checkpoint (oversized prompts usually hold knowledge-base
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

// NOTE: the operator prose inside `settings` (tool guidance, guardrails policy, vision prompt,
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

// A `settings` bag REPLACES the column, which is the contract every caller has today and the reason
// this rule is a refusal rather than a merge: the console sends the whole bag, the MCP patch builds
// one, and flipping the write to merge would silently change what a caller who MEANT replacement
// gets: the same silence one door over. What is refused is the write that would cost blocks the
// caller never named. Measured on #612's acceptance run: `{"settings":{"split":{"enabled":false}}}`
// answered 200 and took signature, debounce, followUp, handoff and eleven other blocks with it.
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

// WHAT THE BAG WOULD COST, asked of the stored row inside the write's own lock like every other rule
// in this family. A key the bag names is this write's business whatever it holds: `{}` and `null`
// are edits of that block, and its reader answers what they mean. A key the bag does NOT name is a
// deletion, and the only ones worth refusing are the ones that would lose something: a block the
// operator never configured reads back as `{}` from agent_settings_get and materialises empty in
// the console, so refusing a save over those would be a refusal about nothing.
//
// Not `carriesConfiguration` below, which answers a different question on purpose: it reads
// `false` and `""` as nothing, so a retired taxonomy left as a tombstone is inert. Here a block
// switched OFF is a decision somebody made, and dropping it reverts that decision to the default.
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
  // By VALUE, not by `in`: a key that holds `undefined` is named in the object and gone from the row,
  // because JSON has no spelling for it and the write drops it on the way to Postgres. Measured by
  // mutation, which is how this stopped being `key in next`: the looser check let `{ signature:
  // undefined }` through as an edit of the block, and the column then had no signature at all.
  //
  // And OWN, not inherited: `{}.constructor` is a function, so a stored block named `constructor` or
  // `toString` read as present in an empty bag and was deleted without a word (review round 1).
  //
  // Except `__proto__`, which no bag can keep: zod's record rebuild drops it before the service and
  // Prisma drops an own one while serializing (both measured, see the `__proto__` notes in
  // src/modules/mcp/write.ts and tests/modules/audit-agent-family.test.ts). A row only carries one
  // from a migration or a direct write, and refusing over it would refuse every save of that agent
  // forever, over a key the caller has no way to send.
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

// The debug window's write boundary, and it sits beside the text-size one for the same reason: this
// is where every transport that writes an agent's settings converges (REST create, REST update, and
// the MCP patch, which imports it from here).
//
// The READER also refuses a deadline past the horizon, but that comparison MOVES: a value 48h ahead
// is refused today and, twenty-five hours later, sits comfortably inside `now + 24h` and arms the
// mode for the rest of its window. A read-time bound can only ever DELAY such a value, never refuse
// it, because nothing in a lone deadline says when it was armed. Refusing the write is what makes it
// permanent for everything this platform stores.
//
// Same shape as the text rule: only a value the write INTRODUCES or CHANGES is refused, so a bag
// that already holds one does not block an unrelated save.
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

// The signature's switch, refused at the write rather than normalised in the reader (#612). Its
// value is the only thing that says whether an agent is signing, and a reader that quietly maps
// `"sim"` onto a boolean leaves GET echoing `"sim"` while the runtime signs: two answers to one
// question, and the API's is the wrong one. The acceptance run measured exactly that.
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

// THE SIGNATURE'S CLOSED FIELDS, refused at the write rather than normalised in the reader (#616 for
// `frequency`, #618 for `position` and `separator`). All three normalise in the reader, so a wrong
// value is harmless to the runtime, and the tie-breaker is what GET does: the API echoes the bag as
// it was stored, so a normalised value leaves the operator's client reading `"esquerda"` on a field
// the runtime answered as `"top"`. #612 already settled that two answers to one question is one too
// many. One class for the three, driven by `SIGNATURE_CHOICES`, because the domains are the reader's
// own and a per-field copy of them is how two of the three went unguarded.
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

// The contact gate's local rule (issue #646), refused on the same terms as a precondition and for a
// sharper reason: the reader drops a rule it cannot parse, and an enabled gate without a rule falls
// back to the endpoint, or to `not_configured` without one. A list saved with a typo would be
// accepted, shown, and replaced by a different gate. Only a write that CHANGES the rule is refused,
// so an unrelated PATCH over a bag stored some other way is not the moment to fix it.
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

// A KEY THAT NO LONGER MEANS ANYTHING IS REFUSED, not merged (issue #568 review).
//
// `settings` blocks are LOOSE objects on purpose (settings-schema.ts says why): an undeclared key
// reaches the readers untouched, so a field added by someone who never opened the schema is not
// silently dropped. The cost is the mirror case — a field REMOVED from every reader keeps being
// accepted, stored and answered with 200, and the console shows a taxonomy that governs nothing.
// The verifier hit all four faces of it: a value outside the group applied, two groups with one
// name accepted where the previous release answered 400, `noteOnChange: true` inert, and the whole
// block with no editor to show it.
//
// Refused whenever the key CARRIES CONFIGURATION, rather than only when the write changes it (the
// rule its neighbours use, right for a stored value that still does something) and rather than on
// mere presence (which round 14 showed breaks ordinary saves — see carriesConfiguration below).
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

// A GUARD THAT LOOKS ACTIVE AND IS NOT is worse than no guard, which is the same argument
// `assertSettingsToolPreconditions` makes about a fence the console shows and the runtime ignores.
// `readProtectedLabels` keeps the first PROTECTED_LABELS_MAX entries and drops the rest — invisible
// truncation is fine for a list nobody reads back, and this one IS read back: the editor reloads
// what was stored, so the operator sees sixty labels presented as off limits while ten of them are
// there for `set_labels` to remove. Refused instead, and only when the write CHANGES the list, so an
// unrelated PATCH is not the moment to make somebody fix a field they did not come to edit — the
// rule this file's other size check uses (round 19).
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

// The allowed list (issue #638) is read back by the same editor, so it is refused past the ceiling
// for the same reason: sixty titles shown as the taxonomy while ten of them are refused is a list
// that lies about the tool.
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

export function assertSettingsProtectedLabels(
  settings: unknown,
  stored: unknown,
): void {
  if (labelListOverflows(settings, stored, "protected", PROTECTED_LABELS_MAX))
    throw new TooManyProtectedLabelsError(PROTECTED_LABELS_MAX);
  if (labelListOverflows(settings, stored, "allowed", ALLOWED_LABELS_MAX))
    throw new TooManyAllowedLabelsError(ALLOWED_LABELS_MAX);
}

// THE RETIRED NOTE FLAG, TAKEN OUT OF THE BAG ABOUT TO BE STORED, whatever it says.
//
// It governs a feature that no longer exists (the note is now something the operator writes in
// `toolGuidance.set_labels`, like any other instruction), so no value of it is worth keeping — and
// none of them is worth a 400 either, because the key is written by the previous release's console
// without anybody choosing it (round 33). Dropped rather than refused is the same verdict the
// import boundary reached for the same key, for the same reason: failing over a value that governs
// nothing blocks work the operator cannot unblock from where they are.
//
// IN PLACE, on the object the caller is about to write, the way `clampProtectedLabelsInPlace` does:
// these two asserts run on the settings the write stores, so removing the key here is what keeps a
// value the migration just cleared from being written straight back by an old console.
// A CLOSED SETTINGS VALUE THE READER WOULD THROW AWAY, refused on REST (#622). #612, #616 and #618
// closed this one field at a time; the rest of the bag had the same hole. REST parsed `settings` as a
// record of unknown, the block's reader replaced an unknown value with its default, the runtime acted
// on the default, and GET echoed what was sent: two answers to one question, the API's the wrong one.
//
// MCP never had it. `BEHAVIOR_PATCH_SHAPE` states the exact question in its own header: a value the
// reader would throw away is declared, a value it honours after measuring (a clamp, a cap) must still
// parse, and the blocks are loose so a key no schema knows reaches the reader as before. So this does
// not write a second list of domains; it asks REST the question MCP already asks.
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
// boundary below, which refuses the first one the write changes, and by the import (#631), which
// normalizes all of them, so the two cannot disagree about what a closed value outside its domain is.
function closedValueIssues(bag: Record<string, unknown>): ClosedValueIssue[] {
  const out: ClosedValueIssue[] = [];
  for (const [block, schema] of Object.entries(BEHAVIOR_PATCH_SHAPE)) {
    if (!Object.hasOwn(bag, block)) continue;
    const value = bag[block];
    // A block NAMED as null is an edit of it (#619): the reader answers it with its defaults, and GET
    // echoing `null` claims nothing the runtime reads differently.
    if (value === null) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success) continue;
    for (const issue of parsed.error.issues) {
      const next = valueAt(value, issue.path);
      // `never` is the schema saying "the runtime does not read this key here" (the reply-only
      // guardrail checks and generation prompt under `input`). MCP refuses them so a caller cannot
      // store configuration that does nothing; REST cannot refuse them outright, because the console's
      // own Guardrails save sends the reader's output for the block and that output materialises them
      // (measured on the base: refusing them refuses the editor on an agent that never had guardrails).
      // So the question for these is the reader's own: the TYPE it reads there passes, and anything
      // else is a value it throws away like any other (`"sim"` saved with a 200 until the acceptance
      // run of #626 asked).
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

// How many tail elements of one list are tried, and how many candidates are judged one by one when the
// block's whole batch is not reader-equal. Both are ceilings on WORK, not on correctness: past them the
// values stay where they are, which is the outcome that changes nothing the runtime reads. A bundle is
// caller input and the import runs inside a 5s transaction, so a bag holding fifty thousand unusable
// entries has to cost one pass over the block, not one pass per entry (review round 2).
const IMPORT_POP_LIMIT = 64;
const IMPORT_ONE_BY_ONE_MAX = 32;
// And a ceiling on the comparisons themselves, for the whole bag rather than per list: each one reads
// the block, so a bundle with thousands of lists pays thousands of reads before any per-list limit is
// reached (review round 4 measured 7.6s that way). Spent, the remaining values stay where they are.
const IMPORT_READING_CHECKS = 256;
// How many lists in one block get a tail cut tried on them. The element that slides into a reader's
// window comes from the list the removal was in, so trying every list of a bag that has thousands of
// them spends the whole budget before the useful answer is reached.
const IMPORT_POP_LISTS = 8;
// How many paths the pass carries back. The import names a handful and counts the rest, and a bundle
// can hold a million unusable entries in one list: an array of a million paths is neither answerable
// nor readable (review round 5 hit `RangeError` spreading one).
const IMPORT_PATHS_KEPT = 64;
// Every comparison costs a clone and a read of the BLOCK, so the budget above bounds how many are made
// and this bounds what each one may cost: a block gets fewer the bigger it is, down to the single pass
// that is the whole point of the batch (review round 7 measured 6s spending a small budget on a block
// of three hundred thousand labels). Sizes in JSON characters, measured once per block.
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
        // The ARRAY ITSELF, kept from here on. A nested list is addressed through its element's index,
        // so once an outer element is out the path that found it names something else, or nothing
        // (review round 3: resolving it again threw and took the import and its preview down).
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
    // Only when the window could be reached by the cuts this is willing to make. A list the reader does
    // not window at all is every list but a few, and trying the tail on a long one costs a read of the
    // whole block per element for nothing (review round 5 measured 12s on a list of fifteen thousand).
    if (arr.length - floor > IMPORT_POP_LIMIT) continue;
    // Tried on THIS list and undone when it does not settle it: the difference may belong to another
    // list entirely, and popping here would take an element no reader ignores (a valid label off a
    // step, measured while fixing review round 3).
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

// WHAT CREATE REFUSES, AN IMPORT NORMALIZES (#631).// WHAT CREATE REFUSES, AN IMPORT NORMALIZES (#631). A bundle is authored somewhere else, so the import
// path does not refuse it whole over one field (transfer.ts already clamps over-cap prose and the
// protected-label list for that reason); it takes the unusable value out, so the reader's default
// applies and GET agrees with the runtime, and hands back the paths so the import can say what it
// took. Asked by the same predicates the write boundary refuses on, never by a second copy of them.
// Returns the paths taken out, bounded, beside how many there were.
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
  // A guard that cannot parse guards nothing, and the reader drops it WHOLE; the import says so. Asked
  // the READER's question, not the write boundary's: a rule keyed by a custom tool (a bundled HTTP tool
  // named `assign_label`, one renamed to `set_labels_2`) is refused by create, which only offers the
  // natives, but `readToolPreconditions` honours it and the import has carried it on purpose since
  // #568, so removing it here would open a tool the bundle guards. Before the closed values, which
  // would otherwise take one field out of a rule: an `equals` of the wrong type removed alone turns "the
  // attribute must be X", which the runtime ignores, into "the attribute must exist", a guard nobody
  // wrote.
  // A bag that is not an object at all is the closed values' business below (the block's own schema
  // refuses it at its root); only the rules inside one are judged here. A `null` rule is a removal
  // create accepts and the reader ignores, so it stays.
  const guards = plainObject(bag.toolPreconditions);
  for (const [name, raw] of Object.entries(guards ?? {})) {
    if (raw === null || parseToolPrecondition(raw) !== null) continue;
    delete (guards as Record<string, unknown>)[name];
    takePath(dropped, `toolPreconditions.${name}`);
  }
  // The contact gate's local rule (issue #646), on the same terms: the reader drops one that does not
  // parse, and create refuses it, so an import that carried it silently would store a gate that reads
  // as a list in the bundle and as no rule at runtime. Taken out and named instead.
  const contactAuth = plainObject(bag.contactAuth);
  if (contactAuth && invalidContactAuthRule(contactAuth.rule)) {
    delete contactAuth.rule;
    takePath(dropped, "contactAuth.rule");
  }
  // THE INVARIANT: what the runtime reads does not change. A closed value the reader throws away is
  // taken out, which by definition leaves the block's reading as it was; a change the reader would
  // notice is not a normalization, and review round 1 found three (a padded guard scope whose field
  // removal voided the whole guard, a padded `tts.mode` the reader trims and honours, and an invalid
  // follow-up step whose removal pulled an eleventh step into the reader's ten-step window). So every
  // candidate is tried on a copy and kept only when `readBehaviorSettings` answers the same for the
  // block. Last issue first: zod reports a list in index order, so working from the end never moves
  // the path of an element still to be judged.
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
  // NOTE: `monitoring.noteOnChange` IS NOT REFUSED, it is stripped — see
  // `stripRetiredNoteFlagInPlace`, called by the same writers. Round 25 refused every value but
  // `false` on the argument that each asks for a behaviour that no longer exists; round 33 measured
  // what that costs during a rolling deploy and it is the rollout itself. The previous console does
  // not ask for the behaviour, it RECONSTRUCTS the key: `readMonitoringConfig` defaults it to
  // `true` when absent, `observationToForm` puts it in the form, and `observationToStored` writes
  // it back on every Behavior save. So the moment the migration clears the stored key, every save
  // made from a console of the previous release answers 400 naming `toolGuidance.set_labels` — for
  // a save that had nothing to do with labels, and with no control on that screen the operator can
  // act on. A refusal an operator cannot act on is not a refusal, it is an outage.
}

// A TOMBSTONE FOR A RULE THAT IS ACTUALLY THERE, which the catalog restriction must not block.
//
// The restriction is about what may be CREATED: outside the native catalog the exposed tool name is
// not stable identity, so a rule written on one can follow the name onto another tool or stop
// matching (issue #389). It is NOT about what may be removed — and a non-native rule can genuinely
// exist, because an agent import copies the settings bag verbatim and the RUNTIME enforces whatever
// name matches (only the write boundary filters by catalog). Refusing its tombstone left a caller
// able to READ an active guard and unable to delete it.
//
// Both halves matter. A tombstone for a name with nothing stored under it is still refused: there is
// nothing to delete, so accepting it would report success for a no-op — and that is exactly the
// shape a caller sends while believing they had created something.
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

// "IS THIS THE SAME RULE?", which is not the same question as "are these the same bytes".
//
// This comparison decides whether a write CHANGED an entry, and an unchanged one is exempt from the
// catalog restriction — that exemption is what lets a caller read the config and write it back. But
// `JSON.stringify` compares SPELLING: jsonb does not promise property order, and what
// `agent_settings_get` returns is the reader's normalized shape, not the bytes that were stored. So
// the same rule, read back and sent again, serialized differently and was refused as an edit.
//
// Parsed first, so two spellings of one rule collapse; falls back to the raw serialization for an
// entry that does not parse, which is the case the by-value comparison was written for in the first
// place (an already-broken entry re-sent untouched must not be refused).
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

// A FALLBACK IS A PROVIDER AND A MODEL, OR IT IS NOTHING — and the write is the only place that can
// say so, because every reader downstream agrees a half-named block is no fallback and none of them
// has anywhere to say it.
//
// Measured on the stored bag: naming a provider and saving without a model persists
// `{provider: "openai", model: null}`, `hasModelFallback` answers false, and the form reader maps it
// straight back to "No fallback". So the operator's provider is gone on the next load, with no error
// and nothing in the row to explain it, and the same bag reaches the MCP patch as a diff showing
// `provider: openai` for a fallback that does not exist. That is the ONE difference from the two
// other `*Required` fields this editor renders — theirs survive the round trip and come back with
// their error still on screen.
//
// Refused rather than repaired for the reason the whole block exists: repairing means choosing which
// half to drop, and both choices throw away something the operator typed. Whoever receives this can
// fix it — the operator picks a model, the MCP caller sends one — which is the test for whether a
// refusal belongs at a write boundary at all.
//
// Same shape as the two rules beside it: only a pair this write INTRODUCES or CHANGES is refused, so
// a bag that already holds a half-named block does not freeze every later save. Per field, because
// `mergeBehaviorSettings` merges a block one level deep: a patch naming only the model is a complete
// statement when the stored block already names a provider.
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

// WHAT THE WRITE WILL ACTUALLY STORE, which is not the same question on the two transports and was
// the defect in the first version of this: REST REPLACES the settings column with the bag it was
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

// REFUSED AT THE BOUNDARY, and only when this write introduces or changes it, the way every other
// rule in this family is scoped: a stored bad value must not freeze a save that edits some other
// section. `undefined` is not a bad value, it is the pre-#612 bag, and the reader answers it from
// the text.
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

// The write boundary for the agent's credential refs, and the only place a `vault:<id>` enters
// either JSON bag. `requireVaultRef` is what the other six ref columns have been held to since #124;
// the agent's two bags were left out of that sweep because they have no column to grep for, so a
// PATCH carrying a vault entry NAME answered 200 and the agent then produced nothing at all — no
// reply in production, "no runnable model configured" in the playground (#254).
//
// Canonical on the way in, not merely valid: requireVaultRef returns the one spelling every reader
// agrees on, and it is written back where the ref was found.
//
// And USABLE on the way in, not merely present: `requireVaultRefFor` also asks whether an entry of
// that kind can serve the field, which nothing did. Eight of these nine fields read a plain API key
// and hand it to a provider SDK; a `google_oauth` entry holds `{ clientId, clientSecret }`, so it
// resolved, stored, and reached `createChatModel` as an object typed `string` (#471).
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

// Allowlist of editable fields. tenantId/id are never touched; modelConfig/settings must be
// objects (the runtime's own parser validates their inner shape at load time).
// NOTE: The EFFECTIVE follow-up state: an ENABLED agent with followUp.enabled, in ANY mode — the
// sweep admits test-mode conversations explicitly activated with /teste, so test-mode agents need
// the fence armed too. Its OFF→ON transition stamps Agent.followUpArmedAt (the sweep's backlog
// fence) — see updateAgent/createAgent. Re-arming on every OFF→ON is deliberate: disabling and
// re-enabling means "from now on". Promotion to production ALSO re-arms (updateAgent): it widens
// the eligible set from /teste-activated conversations to every pending one, and a watermark from
// the test period would expose that whole historical backlog to the sweep at once.
function effectiveFollowUpOn(a: {
  enabled: boolean;
  settings: unknown;
}): boolean {
  return a.enabled && readFollowUpConfig(a.settings).enabled;
}

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

// Everything `updateAgent` decides about its PATCH before any database is involved: the prompt
// size, the schema, the model config, the "nothing to update" refusal, and the two schedule ids.
// Split out so the MCP preview can ask the same question the apply asks (#490) — that preview had
// no preflight at all, and its fence row passed an agent id that does not exist, so it proved the
// not-found path and nothing else.
//
// The two ids come back parsed, for the same reason `assertAgentCreatable` hands them back: a
// second `requireDbId` in the caller could disagree with this one about which row was asked for.
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
  // NOTE: refused, not collapsed into the NotFound the ownership check raises. This used to answer
  // 404 for a non-numeric id, which tells a caller who mistyped that the row is gone — and the same
  // file already answered 400 for a malformed tool-grant id (`bigOrThrow`), so one mistake got two
  // answers depending on which field carried it. Issue #407.
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

// THE OBSERVER REFUSAL, ASKABLE ON ITS OWN (issue #476 review, round 46). `updateAgent` refuses to
// save a non-monitoring mode on an agent that observes an inbox, and `deleteAgent` refuses to delete
// one — both from inside their transactions, where an MCP dry run never goes. A preview that cannot
// ask the same question approves what the apply then rejects, and the caller learns the truth from
// the 422; the previews call this instead, so the two answers cannot drift.
//
// Scoped like every other read here, and it asks about the AGENT rather than about the move: a
// production agent a race left observing is refused the same way, which is the state `updateAgent`
// deliberately refuses against.
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
  // Optimistic concurrency (editor): when set, the update only applies if the row's updatedAt still
  // matches; a mismatch yields 409 (errors.agentModifiedElsewhere) instead of silently overwriting a
  // change made elsewhere (another tab, the REST API, or the MCP server). Omitted ⇒ last-write-wins.
  //
  // `settingsMode: "replace"` is the caller saying the bag is COMPLETE, so the blocks it omits are
  // meant to go. Omitted, a bag that would drop configured blocks is refused instead (#614). Not a
  // default that changes the write: every path that already sends a whole bag (the console, the MCP
  // patch, which merges onto the stored one first) passes either way.
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
    // NOTE: Arm the follow-up backlog fence on the OFF→ON transition of the effective state. The row
    // lock (held to commit — runScopedOn is one interactive transaction) serializes the
    // read-compute-write against concurrent saves: without it, a save that read the old ON state
    // could land last after another save turned follow-up OFF, restoring ON with the STALE watermark
    // and re-exposing the pre-arm backlog to the sweep. RLS still applies to the raw read.
    //
    // NO KEY UPDATE rather than FOR UPDATE, and the difference is who else waits. Both conflict with
    // each other and with the `FOR UPDATE` that `deleteAgent` takes, so the serialization this note
    // is about is unchanged; what NO KEY UPDATE stops conflicting with is `FOR KEY SHARE`, which is
    // the lock a foreign key takes to REFERENCE this row. A save that also blocked references would
    // block `bindInbox`, which holds the Chatwoot account row while it asks (#546), so renaming an
    // agent would stall binds, syncs and disconnects for an account it has nothing to do with. This
    // statement changes no key, which is exactly the case the weaker mode exists for.
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
    // NOTE: read AFTER the lock, and that order is the whole point. The raw lock above reads the
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
    assertSettingsRetiredLabelKeys(rest.settings);
    stripRetiredNoteFlagInPlace(rest.settings);
    stripDerivedFullDetailInPlace(rest.settings);
    assertSettingsProtectedLabels(rest.settings, before?.settings);
    // LAST of the settings rules, after both strips: the dedicated rules above answer their fields
    // with their own sentences, and a retired or derived key is gone before the schema is asked.
    assertSettingsClosedValues(rest.settings, before?.settings);
    // NOTE: An OBSERVER of an inbox (issue #476) is a monitoring agent by construction — the route it
    // holds answers nothing whatever the mode says — so the mode is not this agent's to leave while
    // it observes. Refused rather than kept silently on the observer's path: an operator promoting a
    // watcher expects answers, and the honest answer is that the binding has to go first. Inside
    // the lock. A promotion that lands while an attach is in flight (the row is written only once
    // Chatwoot agreed) leaves a production observer; the receiver honours the row, and this refusal
    // holds from then on.
    //
    // ASKED OF THE TARGET, not of the move (issue #476 review, round 7): the same race that leaves a
    // production observer would then let every later write past this guard — production to test, and
    // back — because the mode it is leaving is no longer monitoring. What the refusal is about is
    // the state it refuses to save, so a non-monitoring mode with an observer row standing is
    // refused whatever the row said before.
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
    // NOTE: See normalizeSettingsForStorage — the host list is reduced to hosts on the way IN, on
    // every write path, not only when it is read back.
    const normalizedSettings = normalizeSettingsForStorage(rest.settings);
    if (normalizedSettings) updateData.settings = normalizedSettings;
    if (before) {
      const after = {
        enabled: rest.enabled !== undefined ? rest.enabled : before.enabled,
        mode: rest.mode !== undefined ? rest.mode : before.mode,
        settings: rest.settings !== undefined ? rest.settings : before.settings,
      };
      // NOTE: Promotion to production re-arms even with follow-up already effectively ON: the
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

// Everything `createAgent` can refuse about an input WITHOUT reading the database, as one call. It
// exists so the MCP dry run can answer with the same verdict the apply will: the preview returns
// before the core is ever reached, so a rule that lives only inside `createAgent` is a rule the
// preview promises away (issue #490). Returns the parsed row so the caller does not parse twice.
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
  assertSettingsRetiredLabelKeys(input.settings);
  stripRetiredNoteFlagInPlace(input.settings);
  stripDerivedFullDetailInPlace(input.settings);
  assertSettingsProtectedLabels(input.settings, undefined);
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
    // NOTE: An OBSERVER binding (issue #476) is a bot attached on Chatwoot's side, and the cascade
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
    // The namespace lock BEFORE the grants are read, for the reason `replaceAgentToolSelections`
    // gives and one step earlier: a clone copies target ids out of one agent and writes them under
    // another, so a tool deleted between the read and the insert leaves the copy pointing at a row
    // that is gone. The foreign key then refuses it, and because the whole clone is one transaction
    // the operator loses the agent, not the grant (round 35). Behind the lock the delete either
    // goes first, and its cascade takes the source grant with it so there is nothing to copy, or it
    // waits and takes both rows afterwards.
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
    // NOTE: The bag is copied verbatim, over-cap text included. A clone authors nothing, and refusing
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
    // Operator-authored code tools (issue #363); `name` is what the agent calls.
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
      native: NATIVE_TOOL_NAMES.map((n) => ({
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
      // A WEBHOOK entry (GENERIC, #818) has no tools to grant: offering it here would list a
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

// The knowledge bases THIS agent is granted that still hold documents nobody indexed — the two
// facts the configuration-health read needs out of the whole tool catalog.
//
// A query of its own rather than a projection of `getAgentToolSelections`, and the difference is not
// tidiness: that view loads every tool definition, MCP connection, integration instance, knowledge
// base and document-template body the TENANT has, then groups the unindexed documents of all of
// them. It is the right shape for the editor, which draws all of it. Health is now read on every
// agent write, so paying for the tenant's whole catalog there makes an unrelated `agent_update`
// scale with how much the tenant has configured.
//
// Scoped twice on purpose: to the agent's RAG grant, and to the bases that grant names.
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
// Every id list here comes off an UNCAPPED array on the published schema (`grants`, and
// `knowledgeBaseIds` inside each one), and each id is a BIND PARAMETER: Postgres takes at most
// 32,767, so one grant carrying 40k knowledge-base ids raised "The query parameter limit supported
// by your database is exceeded" rather than refusing. That was already true of the apply; making the
// preview ask the same question would have doubled the surface, and the dry run is the call an
// operator makes FIRST. Measured at 40,000 ids: a crash on both halves before this, a refusal on
// both after. Same shape as `deployment_set_accounts` (#492), same chunk.
const ID_CHUNK = 1000;

// SHORT-CIRCUITS on the first deficient chunk, and the reason is that the answer is already known
// there: a chunk that finds fewer rows than it asked for cannot be rescued by a later one. Without
// it a grant of 500,000 ids that names nothing spent 500 queries to reach a refusal the first one
// had settled (measured: 637ms; with the exit, one query).
//
// It is NOT the transaction timeout the review round suspected. `runScopedOn` gives 5s and the
// unshortened loop stayed three orders of magnitude inside it at every size a published schema can
// deliver — 40k ids in 94ms, 200k in 261ms, 500k in 637ms. The exit is worth having on its own
// terms; the timeout it was proposed to avoid does not happen.
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
// knowledge bases and integrations (plus the sub-tool allowlist an integration publishes). Split out of
// `replaceAgentToolSelections` so the preview can ask it (#490): the fence row for `agent_tools_set`
// passes `grants: []` behind an agent id that names no agent, so it proved the ownership check and
// none of this — and a preview echoed back `nextGrants` for a set the apply refuses (#510).
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
    // The NAMESPACE lock first, before the agent row, and the order is the whole point. Deleting a
    // tool takes this lock, then the tool row FOR UPDATE, then cascades into the selection rows;
    // this path took the agent row, deleted the selection rows and then asked the foreign key for
    // the tool row. Two transactions, each holding what the other needs next, which PostgreSQL
    // resolves by killing one: measured on the real pair, `40P01 deadlock detected`, surfacing as a
    // 500 on whichever lost (round 34). Behind this lock the two are serialized and neither can be
    // half-done when the other starts. Grant saves are an operator action, so the cost of holding
    // one lock per tenant across them is not a cost anyone can feel.
    await lockToolNames(db);
    // NOTE: the agent row is LOCKED before its version is read, and the grant snapshot below is
    // taken under that lock. The set lives in another table with no version of its own, so this row
    // is what serializes two replacements against each other: unlocked, one call can read set A,
    // wait while another commits B, and then write A back while its audit row claims A→A. The
    // agent is also what `expectedUpdatedAt` is checked against, so the precondition and the
    // snapshot now answer for the same instant. RLS still applies to the raw read.
    //
    // NO KEY UPDATE for the reason `updateAgent` gives above: it serializes replacements and still
    // conflicts with the delete, and it stops conflicting with the `FOR KEY SHARE` a reference to
    // this agent takes, which is what keeps a grant save out of the way of `bindInbox` (#546).
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
    // A target can be DELETED between `assertGrantTargetsExist` above and the insert: the check
    // reads the row, a delete commits in the gap, and the foreign key refuses the selection. That
    // is the same event as "no such tool", which the check itself would have reported a moment
    // earlier, so it gets the same terminal answer instead of a 500 for the console and a bare
    // P2003 in the log (round 31). The precedent, and the reasoning, is `issueDocument`'s in
    // documents/issue.ts.
    //
    // WHICH target vanished is asked afterwards, in a fresh scoped read, rather than parsed out of
    // the driver's constraint name: the aborted transaction can answer nothing,
    // `assertGrantTargetsExist` already knows how to name every source, and re-asking it costs one
    // round trip on a path that is already losing a race. If it now finds everything (the row came
    // back, or the key that failed was the agent's own), the original error stands rather than
    // being dressed up as a not-found.
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
