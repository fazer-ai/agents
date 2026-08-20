import { readLimitsConfig } from "@/modules/agents/limits";
import { readAvailabilityConfig } from "@/modules/availability/away";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { readAttributeContextConfig } from "@/modules/chatwoot/attributes";
import { readDebounceConfig } from "@/modules/debounce/settings";
import { readObservabilityConfig } from "@/modules/flowlog/settings";
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
  channelRedirect: ReturnType<typeof readChannelRedirectConfig>;
  guardrails: ReturnType<typeof readGuardrailsConfig>;
  // NOTE: Which Chatwoot custom attributes (per scope) are injected into the system prompt.
  attributeContext: ReturnType<typeof readAttributeContextConfig>;
  observability: ReturnType<typeof readObservabilityConfig>;
  // NOTE: The one block in this bag whose default is ON (see modules/memory/settings), so a bag with
  // no `memory` key projects `enabled: true` rather than the usual "absent means off".
  memory: ReturnType<typeof readMemoryConfig>;
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
  "channelRedirect",
  "guardrails",
  "attributeContext",
  "observability",
  "memory",
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
    channelRedirect: readChannelRedirectConfig(settings),
    guardrails: readGuardrailsConfig(settings),
    attributeContext: readAttributeContextConfig(settings),
    observability: readObservabilityConfig(settings),
    memory: readMemoryConfig(settings),
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
  channelRedirect?: Record<string, unknown>;
  guardrails?: Record<string, unknown>;
  attributeContext?: Record<string, unknown>;
  observability?: Record<string, unknown>;
  memory?: Record<string, unknown>;
}

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
    next[key] = { ...before, ...sub };
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
  next.channelRedirect = normalized.channelRedirect;
  next.guardrails = normalized.guardrails;
  next.attributeContext = normalized.attributeContext;
  next.observability = normalized.observability;
  next.memory = normalized.memory;
  // grounding: only persist when a valid distance is set; otherwise leave whatever was there
  // (a null maxDistance means "no grounding filter" — represent it explicitly when the patch
  // touched grounding so the operator can clear it).
  if (patch.grounding !== undefined) {
    next.grounding = { maxDistance: normalized.grounding.maxDistance };
  }
  return next;
}
