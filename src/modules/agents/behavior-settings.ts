import { readModelFallbackConfig } from "@/graph/fallback-settings";
import { readLimitsConfig } from "@/modules/agents/limits";
import { readToolGuidance } from "@/modules/agents/tool-guidance";
import { readToolPreconditions } from "@/modules/agents/tool-preconditions";
import { readAvailabilityConfig } from "@/modules/availability/away";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { readAttributeContextConfig } from "@/modules/chatwoot/attributes";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import { readDebounceConfig } from "@/modules/debounce/settings";
import {
  readObservabilityConfig,
  storableObservability,
} from "@/modules/flowlog/settings";
import { readFollowUpConfig } from "@/modules/followups/settings";
import { readGuardrailsConfig } from "@/modules/guardrails/settings";
import { readHandoffConfig } from "@/modules/handoff/settings";
import { readSendImageConfig } from "@/modules/images/settings";
import { readKanbanConfig } from "@/modules/kanban/settings";
import { readMemoryConfig } from "@/modules/memory/settings";
import { readServiceWindowConfig } from "@/modules/service-window/service";
import { readSplitConfig } from "@/modules/split/service";
import { readSttConfig } from "@/modules/stt/settings";
import { readTtsConfig } from "@/modules/tts/settings";
import { readVisionConfig } from "@/modules/vision/settings";

// Normalized read of the per-agent BEHAVIOR config that lives in the free-form `agent.settings` bag
// (debounce / stt / tts / split / serviceWindow + grounding + followUp). The same typed readers the
// runtime uses are the single source of defaults + clamping — this composes them so all three
// transports (REST/UI/MCP) project the SAME validated shape. credentialRef is a `vault:<id>`
// reference (never the secret itself), so it is safe to surface; the MCP transport translates it
// to/from the entry NAME at its boundary (write.ts).

// Grounding has no dedicated reader (it is read inline in the graph), so mirror that logic here:
// only a positive finite cosine distance is meaningful; anything else → null (no filtering).
function readGrounding(settings: unknown): { maxDistance: number | null } {
  if (!settings || typeof settings !== "object") return { maxDistance: null };
  const g = (settings as Record<string, unknown>).grounding;
  if (!g || typeof g !== "object") return { maxDistance: null };
  const v = (g as Record<string, unknown>).maxDistance;
  return {
    maxDistance:
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null,
  };
}

export interface BehaviorSettings {
  debounce: ReturnType<typeof readDebounceConfig>;
  stt: ReturnType<typeof readSttConfig>;
  tts: ReturnType<typeof readTtsConfig>;
  vision: ReturnType<typeof readVisionConfig>;
  split: ReturnType<typeof readSplitConfig>;
  serviceWindow: ReturnType<typeof readServiceWindowConfig>;
  grounding: { maxDistance: number | null };
  followUp: ReturnType<typeof readFollowUpConfig>;
  handoff: ReturnType<typeof readHandoffConfig>;
  sendImage: ReturnType<typeof readSendImageConfig>;
  limits: ReturnType<typeof readLimitsConfig>;
  availability: ReturnType<typeof readAvailabilityConfig>;
  contactAuth: ReturnType<typeof readContactAuthConfig>;
  channelRedirect: ReturnType<typeof readChannelRedirectConfig>;
  guardrails: ReturnType<typeof readGuardrailsConfig>;
  // NOTE: Which Chatwoot custom attributes (per scope) are injected into the system prompt.
  attributeContext: ReturnType<typeof readAttributeContextConfig>;
  observability: ReturnType<typeof readObservabilityConfig>;
  // NOTE: The one block in this bag whose default is ON (see modules/memory/settings), so a bag with
  // no `memory` key projects `enabled: true` rather than the usual "absent means off".
  memory: ReturnType<typeof readMemoryConfig>;
  // NOTE: All four fields null is the ordinary state and means NO fallback, not "the agent's own
  // model" the way the two sibling overrides read it (see graph/fallback-settings).
  modelFallback: ReturnType<typeof readModelFallbackConfig>;
  // NOTE: The five below joined this surface with issue #402, and they are the reason the guard over it
  // changed shape. Each was already written by the console and by REST; none was reachable over MCP,
  // because the check that should have noticed compared against the list right below rather than
  // against what the readers produce. `guardrails` is the one that was left out on purpose, and the
  // reason was never written anywhere — which is why "decided" and "forgotten" had become the same
  // thing from outside.
  kanban: ReturnType<typeof readKanbanConfig>;
  toolGuidance: ReturnType<typeof readToolGuidance>;
  toolPreconditions: ReturnType<typeof readToolPreconditions>;
}

// The keys this surface owns inside the settings bag. Any other key (future/unknown) is preserved
// untouched on write — this is the merge contract the REST/UI path also honors.
export const BEHAVIOR_SETTINGS_KEYS = [
  "debounce",
  "stt",
  "tts",
  "vision",
  "split",
  "serviceWindow",
  "grounding",
  "followUp",
  "handoff",
  "sendImage",
  "limits",
  "availability",
  "contactAuth",
  "channelRedirect",
  "guardrails",
  "attributeContext",
  "observability",
  "memory",
  "modelFallback",
  "kanban",
  "toolGuidance",
  "toolPreconditions",
] as const;
export type BehaviorSettingsKey = (typeof BEHAVIOR_SETTINGS_KEYS)[number];

// Normalize the whole behavior block from a raw settings bag (defaults + clamps applied).
// `now` is threaded rather than left to each reader's own default for the reason
// `readObservabilityConfig` states at its own signature: a caller that already holds an instant has
// to use the SAME one for every read of it. Two calls of this function on one stored bag are not
// otherwise guaranteed to agree — measured, 80ms apart across a `fullDetailUntil` expiry they differ
// in two fields, because that reader nulls the deadline once the window closes as well as flipping
// the derived flag.
export function readBehaviorSettings(
  settings: unknown,
  now: Date = new Date(),
): BehaviorSettings {
  return {
    debounce: readDebounceConfig(settings),
    stt: readSttConfig(settings),
    tts: readTtsConfig(settings),
    vision: readVisionConfig(settings),
    split: readSplitConfig(settings),
    serviceWindow: readServiceWindowConfig(settings),
    grounding: readGrounding(settings),
    followUp: readFollowUpConfig(settings),
    handoff: readHandoffConfig(settings),
    sendImage: readSendImageConfig(settings),
    limits: readLimitsConfig(settings),
    availability: readAvailabilityConfig(settings),
    contactAuth: readContactAuthConfig(settings),
    channelRedirect: readChannelRedirectConfig(settings),
    guardrails: readGuardrailsConfig(settings),
    attributeContext: readAttributeContextConfig(settings),
    observability: readObservabilityConfig(settings, now),
    memory: readMemoryConfig(settings),
    modelFallback: readModelFallbackConfig(settings),
    kanban: readKanbanConfig(settings),
    toolGuidance: readToolGuidance(settings),
    toolPreconditions: readToolPreconditions(settings),
  };
}

// A partial patch over the behavior blocks. Each block is itself partial — only the provided
// sub-keys are merged; absent ones keep their current (clamped) value.
export interface BehaviorSettingsPatch {
  debounce?: Record<string, unknown>;
  stt?: Record<string, unknown>;
  tts?: Record<string, unknown>;
  vision?: Record<string, unknown>;
  split?: Record<string, unknown>;
  serviceWindow?: Record<string, unknown>;
  grounding?: Record<string, unknown>;
  followUp?: Record<string, unknown>;
  handoff?: Record<string, unknown>;
  sendImage?: Record<string, unknown>;
  limits?: Record<string, unknown>;
  availability?: Record<string, unknown>;
  contactAuth?: Record<string, unknown>;
  channelRedirect?: Record<string, unknown>;
  guardrails?: Record<string, unknown>;
  attributeContext?: Record<string, unknown>;
  observability?: Record<string, unknown>;
  memory?: Record<string, unknown>;
  modelFallback?: Record<string, unknown>;
  kanban?: Record<string, unknown>;
  toolGuidance?: Record<string, unknown>;
  toolPreconditions?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Merge a patch into a stored block key by key, at ANY depth (issue #184). Two objects merge;
// anything else replaces.
//
// The depth is the whole point. One shallow spread kept the "untouched keys preserved" promise at
// the top level of a block and broke it one step in, and the break was silent rather than loud:
// each block is re-read through its typed reader afterwards, so a sub-object the patch replaced
// came back FILLED WITH DEFAULTS instead of absent. Turning off a guardrail direction returned a
// complete, plausible direction with the operator's refusal text swapped for the product's and
// `action: "silent"` — send nothing — swapped for `template` — send this.
//
// An ARRAY replaces, deliberately: a list patch means the new list. Merging element by element
// would make a shorter `followUp.steps` or a smaller attribute scope impossible to express, which
// is the opposite of what sending one means.
// How deep the merge will follow a patch before it stops descending and simply replaces. Both halves
// of that are load-bearing.
//
// It is BOUNDED because the settings bag is caller-supplied on both sides — the stored value and the
// patch — and `agentUpdateSchema.settings` accepts arbitrary nested `unknown`. Recursing once per
// level turns "store a deep object, then patch it" into `RangeError: Maximum call stack size
// exceeded` (measured against this tree: 5_000 levels merge fine, 20_000 throw), and since the throw
// escapes the write, the agent's settings would stay unwritable until the row was repaired by hand.
//
// The number comes from the shape the readers actually produce, not from the stack: the deepest is
// `guardrails.input.checks.toxicity`, at 4. Eight is double that and four orders of magnitude short
// of where the stack gives out. `mergeMaxDepthCoversReaders` in the tests ties the two together, so
// a block that grows deeper than this fails there rather than silently losing values past the cap.
//
// Past the cap it REPLACES, which is what the merge did at every level before it learned to descend.
// Nothing that used to work changes shape; only the runaway stops.
const MERGE_MAX_DEPTH = 8;

function mergeBlock(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  depth = 1,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...before };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    out[key] =
      depth < MERGE_MAX_DEPTH && isPlainObject(prev) && isPlainObject(value)
        ? mergeBlock(prev, value, depth + 1)
        : value;
  }
  return out;
}

// The deepest path any behavior reader produces, so the test can assert the cap clears it.
export function behaviorSettingsMaxDepth(): number {
  let deepest = 0;
  const walk = (v: unknown, d: number): void => {
    if (!isPlainObject(v)) {
      if (d > deepest) deepest = d;
      return;
    }
    for (const child of Object.values(v)) walk(child, d + 1);
  };
  walk(readBehaviorSettings({}) as unknown as Record<string, unknown>, 0);
  return deepest;
}

export const MERGE_MAX_DEPTH_FOR_TESTS = MERGE_MAX_DEPTH;

// Merge a behavior patch into the existing raw settings bag, then RE-READ each touched block through
// its typed reader so the persisted value is always normalized + clamped (never the raw patch).
// Untouched keys in the bag (and untouched blocks) are preserved verbatim — the REST/UI merge
// contract. Returns the new settings bag to persist.
// THE BLOCKS WHOSE READER IS A FILTER, NOT A DEFAULTER — and the distinction is the whole reason
// they are handled apart (PR #404, round 1).
//
// Every other block reads into DEFAULTS: an unrecognized value becomes the default, so re-reading a
// bag and storing what came out loses nothing, because there was nothing the reader could not
// represent. These two DROP what they do not recognize — a key outside the native catalog, a
// condition of a kind added later, an entry an agent import copied in verbatim. Run them through the
// same normalized write-back and "normalize" means DELETE.
//
// Three ways that was measured to bite, all silent, all on a guard the operator believed was there:
// an invalid entry in the patch erased the VALID one it replaced; an update to `debounce` deleted a
// precondition it never mentioned; and there was no way to remove one at all, since an empty object
// deep-merged into the old value and changed nothing.
//
// So: merged BY KEY with whole-value replacement, `null` to remove, keys the patch does not mention
// left byte-identical — and never written back through the reader. The write boundary is what
// refuses a bad entry (assertSettingsToolPreconditions, run on the PATCH before this merge, like its
// three siblings in modules/mcp/write.ts), which is also why dropping one here would be the wrong
// place to enforce anything.
const TOOL_KEYED_BLOCKS: ReadonlySet<string> = new Set([
  "toolGuidance",
  "toolPreconditions",
]);

function mergeToolKeyedBlock(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  // NOTE: An ARRAY prior is no map at all, and enumerating it is worse than ignoring it: `Object.entries`
  // on an array yields its INDICES, so a stored array became keys "0" and "1" and the apply then
  // refused with `settings.toolPreconditions.0 is not a valid precondition` — a field name the
  // operator never wrote, and no way for this surface to write over the bad block at all. An array
  // was never valid configuration here (the reader ignores it whole), so there is nothing to
  // preserve and the patch repairs the block.
  const prior = Array.isArray(before) ? {} : before;
  // NULL-PROTOTYPE, for the reason the runtime map is: a tool name is operator text, and `__proto__`
  // assigned onto an ordinary object mutates the prototype instead of storing an entry.
  const out = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(prior)) out[name] = value;
  for (const [name, value] of Object.entries(patch)) {
    // NOTE: `null` is the removal, and it has to be: an absent key means "leave it alone" here, so
    // without a tombstone there is no way to delete a rule over this surface at all.
    if (value === null) delete out[name];
    else out[name] = value;
  }
  return out;
}

export function mergeBehaviorSettings(
  current: Record<string, unknown>,
  patch: BehaviorSettingsPatch,
): Record<string, unknown> {
  // Start from a shallow copy of the existing bag (preserves unknown/non-behavior keys).
  const next: Record<string, unknown> = { ...current };

  for (const key of BEHAVIOR_SETTINGS_KEYS) {
    const sub = patch[key];
    if (sub === undefined) continue;
    if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
      // A non-object block is ignored (the readers would coerce it to defaults anyway); skipping
      // here keeps the existing block intact rather than silently wiping it.
      continue;
    }
    const before =
      current[key] && typeof current[key] === "object"
        ? (current[key] as Record<string, unknown>)
        : {};
    next[key] = TOOL_KEYED_BLOCKS.has(key)
      ? mergeToolKeyedBlock(before, sub)
      : mergeBlock(before, sub);
  }

  // Re-read through the typed readers to clamp/validate, then write the normalized blocks back.
  //
  // FROM THE KEY LIST, not eighteen assignments beside it. This was a line per block, and the guard
  // over it (tests/modules/behavior-settings.test.ts) exists because `modelFallback` went in without
  // one — the fourth block in a single change to reach one registration point and not the next. It
  // happened again here: #402 added four blocks to the list above and the write-back kept the shape
  // it had, so `kanban` and `appointmentReminders` merged and were never stored normalized. The
  // guard caught it, which is the argument for deriving rather than for a more careful reviewer.
  //
  // The two exceptions are handled after the loop, and each is a real difference rather than an
  // omission: see their own comments below.
  const normalized = readBehaviorSettings(next) as unknown as Record<
    string,
    unknown
  >;
  const WRITTEN_BACK_SEPARATELY = new Set([
    "observability",
    "grounding",
    ...TOOL_KEYED_BLOCKS,
  ]);
  for (const key of BEHAVIOR_SETTINGS_KEYS) {
    if (WRITTEN_BACK_SEPARATELY.has(key)) continue;
    next[key] = normalized[key];
  }
  // Through the storable projection, not the read shape: `observability.fullDetail` is DERIVED, and
  // this line is what would persist it.
  next.observability = storableObservability(
    normalized.observability as ReturnType<typeof readObservabilityConfig>,
  );
  // grounding: only persist when a valid distance is set; otherwise leave whatever was there
  // (a null maxDistance means "no grounding filter" — represent it explicitly when the patch
  // touched grounding so the operator can clear it).
  if (patch.grounding !== undefined) {
    next.grounding = {
      maxDistance: (normalized.grounding as { maxDistance: number | null })
        .maxDistance,
    };
  }
  return next;
}
