import { readModelFallbackConfig } from "@/graph/fallback-settings";
import { readLimitsConfig } from "@/modules/agents/limits";
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
] as const;
export type BehaviorSettingsKey = (typeof BEHAVIOR_SETTINGS_KEYS)[number];

// Normalize the whole behavior block from a raw settings bag (defaults + clamps applied).
export function readBehaviorSettings(settings: unknown): BehaviorSettings {
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
    observability: readObservabilityConfig(settings),
    memory: readMemoryConfig(settings),
    modelFallback: readModelFallbackConfig(settings),
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
    next[key] = mergeBlock(before, sub);
  }

  // Re-read through the typed readers to clamp/validate, then write the normalized blocks back.
  const normalized = readBehaviorSettings(next);
  next.debounce = normalized.debounce;
  next.stt = normalized.stt;
  next.tts = normalized.tts;
  next.vision = normalized.vision;
  next.split = normalized.split;
  next.serviceWindow = normalized.serviceWindow;
  next.followUp = normalized.followUp;
  next.handoff = normalized.handoff;
  next.sendImage = normalized.sendImage;
  next.limits = normalized.limits;
  next.availability = normalized.availability;
  next.contactAuth = normalized.contactAuth;
  next.channelRedirect = normalized.channelRedirect;
  next.guardrails = normalized.guardrails;
  next.attributeContext = normalized.attributeContext;
  // Through the storable projection, not the read shape: `observability.fullDetail` is DERIVED, and
  // this line is what would persist it.
  next.observability = storableObservability(normalized.observability);
  next.memory = normalized.memory;
  next.modelFallback = normalized.modelFallback;
  // grounding: only persist when a valid distance is set; otherwise leave whatever was there
  // (a null maxDistance means "no grounding filter" — represent it explicitly when the patch
  // touched grounding so the operator can clear it).
  if (patch.grounding !== undefined) {
    next.grounding = { maxDistance: normalized.grounding.maxDistance };
  }
  return next;
}
