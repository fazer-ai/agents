import { readModelFallbackConfig } from "@/graph/fallback-settings";
import { readLimitsConfig } from "@/modules/agents/limits";
import { readResolveConversationConfig } from "@/modules/agents/resolve-labels";
import {
  readAllowedLabels,
  readOutsideAllowedLabels,
  readProtectedLabels,
  readToolGuidance,
} from "@/modules/agents/tool-guidance";
import { readToolPreconditions } from "@/modules/agents/tool-preconditions";
import { readAvailabilityConfig } from "@/modules/availability/away";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { readAttributeContextConfig } from "@/modules/chatwoot/attributes";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import { readCrossInboxCaseConfig } from "@/modules/cross-inbox-case/settings";
import { readDebounceConfig } from "@/modules/debounce/settings";
import {
  readObservabilityConfig,
  storableObservability,
} from "@/modules/flowlog/settings";
import { readFollowUpConfig } from "@/modules/followups/settings";
import { readGuardrailsConfig } from "@/modules/guardrails/settings";
import {
  readHandoffConfig,
  readTakeoverConfig,
} from "@/modules/handoff/settings";
import { readSendImageConfig } from "@/modules/images/settings";
import { readKanbanConfig } from "@/modules/kanban/settings";
import { readMemoryConfig } from "@/modules/memory/settings";
import { readMonitoringConfig } from "@/modules/observe/settings";
import { readServiceWindowConfig } from "@/modules/service-window/service";
import { readSignatureConfig } from "@/modules/signature/service";
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
  signature: ReturnType<typeof readSignatureConfig>;
  serviceWindow: ReturnType<typeof readServiceWindowConfig>;
  grounding: { maxDistance: number | null };
  followUp: ReturnType<typeof readFollowUpConfig>;
  handoff: ReturnType<typeof readHandoffConfig>;
  // NOTE: The second block whose default is ON (see modules/handoff/settings for why), and it is kept
  // apart from `handoff` above because the Tools tab REPLACES that one wholesale.
  takeover: ReturnType<typeof readTakeoverConfig>;
  sendImage: ReturnType<typeof readSendImageConfig>;
  // NOTE: The labels resolve_conversation writes itself, before the close.
  resolveConversation: ReturnType<typeof readResolveConversationConfig>;
  crossInboxCase: ReturnType<typeof readCrossInboxCaseConfig>;
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
  kanban: ReturnType<typeof readKanbanConfig>;
  toolGuidance: ReturnType<typeof readToolGuidance>;
  setLabels: {
    protected: ReturnType<typeof readProtectedLabels>;
    allowed: ReturnType<typeof readAllowedLabels>;
    outsideAllowed: ReturnType<typeof readOutsideAllowedLabels>;
  };
  toolPreconditions: ReturnType<typeof readToolPreconditions>;
  monitoring: ReturnType<typeof readMonitoringConfig>;
}

// The keys this surface owns inside the settings bag. Any other key (future/unknown) is preserved
// untouched on write — this is the merge contract the REST/UI path also honors.
export const BEHAVIOR_SETTINGS_KEYS = [
  "debounce",
  "stt",
  "tts",
  "vision",
  "split",
  "signature",
  "serviceWindow",
  "grounding",
  "followUp",
  "handoff",
  "takeover",
  "sendImage",
  "resolveConversation",
  "crossInboxCase",
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
  "setLabels",
  "toolPreconditions",
  "monitoring",
] as const;
export type BehaviorSettingsKey = (typeof BEHAVIOR_SETTINGS_KEYS)[number];

// Normalize the whole behavior block from a raw settings bag (defaults + clamps applied).
// `now` is threaded so every read uses the SAME instant: across a `fullDetailUntil` expiry, two reads
// of one bag would otherwise differ.
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
    signature: readSignatureConfig(settings),
    serviceWindow: readServiceWindowConfig(settings),
    grounding: readGrounding(settings),
    followUp: readFollowUpConfig(settings),
    handoff: readHandoffConfig(settings),
    takeover: readTakeoverConfig(settings),
    sendImage: readSendImageConfig(settings),
    resolveConversation: readResolveConversationConfig(settings),
    crossInboxCase: readCrossInboxCaseConfig(settings),
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
    setLabels: {
      protected: readProtectedLabels(settings),
      allowed: readAllowedLabels(settings),
      outsideAllowed: readOutsideAllowedLabels(settings),
    },
    toolPreconditions: readToolPreconditions(settings),
    monitoring: readMonitoringConfig(settings),
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
  signature?: Record<string, unknown>;
  serviceWindow?: Record<string, unknown>;
  grounding?: Record<string, unknown>;
  followUp?: Record<string, unknown>;
  handoff?: Record<string, unknown>;
  takeover?: Record<string, unknown>;
  sendImage?: Record<string, unknown>;
  resolveConversation?: Record<string, unknown>;
  crossInboxCase?: Record<string, unknown>;
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
  setLabels?: Record<string, unknown>;
  toolPreconditions?: Record<string, unknown>;
  monitoring?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// How deep the merge descends before it replaces. Bounded because both sides are caller-supplied and
// unbounded recursion would overflow the stack and leave the settings unwritable. Double the deepest
// path the readers produce (4); `mergeMaxDepthCoversReaders` in the tests keeps it above that.
const MERGE_MAX_DEPTH = 8;

// Fields inside a block that the merge replaces whole instead of descending into.
const ATOMIC_FIELDS: Record<string, readonly string[]> = {
  contactAuth: ["rule"],
};

// Merge a patch into a stored block key by key, at any depth: a sub-object replaced by a shallow
// spread would be re-read FILLED WITH DEFAULTS. Two objects merge; anything else, arrays included
// (a list patch means the new list), replaces.
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

// The blocks whose reader FILTERS rather than defaults: it drops what it does not recognize, so a
// normalized write-back would delete entries. Merged by key with whole-value replacement, `null` to
// remove, never written back through the reader; the write boundary refuses bad entries instead.
const TOOL_KEYED_BLOCKS: ReadonlySet<string> = new Set([
  "toolGuidance",
  "toolPreconditions",
]);

function mergeToolKeyedBlock(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  // An ARRAY prior is not a map (the reader ignores it whole), and enumerating it would yield
  // index keys; dropping it lets the patch repair the block.
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

// Merge a behavior patch into the raw settings bag, then RE-READ each block through its typed reader
// so what is persisted is normalized and clamped. Untouched keys and blocks are preserved verbatim.
export function mergeBehaviorSettings(
  current: Record<string, unknown>,
  patch: BehaviorSettingsPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };

  for (const key of BEHAVIOR_SETTINGS_KEYS) {
    const sub = patch[key];
    if (sub === undefined) continue;
    if (sub === null || typeof sub !== "object" || Array.isArray(sub)) {
      // NOTE: A non-object block is ignored (the readers would coerce it to defaults anyway); skipping
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
    // A value that is ONE decision (the contact gate's `kind`-tagged rule) is replaced, never
    // merged into, or the stored rule would keep fields of the old one.
    const atomic = ATOMIC_FIELDS[key];
    if (atomic) {
      for (const field of atomic) {
        if (Object.hasOwn(sub, field)) {
          (next[key] as Record<string, unknown>)[field] = (
            sub as Record<string, unknown>
          )[field];
        }
      }
    }
  }

  // Write the normalized blocks back, derived from the key list so a new block cannot miss it.
  // The exceptions are handled after the loop.
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
