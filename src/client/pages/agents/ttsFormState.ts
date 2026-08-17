import { isValidHttpUrl } from "@/client/lib/validation";
import {
  type NormalizeModelResolution,
  resolveNormalizeModel,
} from "@/modules/tts/normalize-model";

// The agent editor's TTS block, as a pair of pure functions: stored settings → form state → stored
// settings. It lives outside the page because the Behavior save REPLACES the whole `tts` block with
// what the form holds, so a field the form does not carry is not merely un-editable, it is DELETED on
// the next save. That happened to `normalizeBaseURL`, which the REST and MCP transports accept: the
// round-trip test over this pair is what makes the next one impossible to add silently.

export interface TtsFormState {
  mode: string;
  provider: string;
  model: string;
  voice: string;
  credentialRef: string;
  // No field in the form renders this one: none of the TTS providers is openai-compatible, so only
  // REST/MCP set it (a proxy in front of the vendor). It is carried anyway because the save replaces
  // the block, and a value the form drops is a value the next save deletes.
  baseURL: string;
  normalize: boolean;
  normalizeProvider: string;
  normalizeModel: string;
  normalizeCredentialRef: string;
  normalizeBaseURL: string;
  // Numeric knobs are strings in the form (an empty one means "leave it to the provider", which
  // Number("") would turn into 0).
  stability: string;
  similarityBoost: string;
  style: string;
  speed: string;
  speakerBoost: boolean | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): string {
  return typeof v === "number" ? String(v) : "";
}

function numOrNull(v: string): number | null {
  const n = Number(v.trim());
  return v.trim() && Number.isFinite(n) ? n : null;
}

export function readTtsFormState(
  block: unknown,
  normalizeDefault: boolean,
): TtsFormState {
  const tt = (block ?? {}) as Record<string, unknown>;
  return {
    mode: str(tt.mode) || "never",
    provider: str(tt.provider) || "openai",
    model: str(tt.model),
    voice: str(tt.voice),
    credentialRef: str(tt.credentialRef),
    baseURL: str(tt.baseURL),
    normalize:
      typeof tt.normalize === "boolean" ? tt.normalize : normalizeDefault,
    normalizeProvider: str(tt.normalizeProvider),
    normalizeModel: str(tt.normalizeModel),
    normalizeCredentialRef: str(tt.normalizeCredentialRef),
    normalizeBaseURL: str(tt.normalizeBaseURL),
    stability: num(tt.stability),
    similarityBoost: num(tt.similarityBoost),
    style: num(tt.style),
    speed: num(tt.speed),
    speakerBoost: typeof tt.speakerBoost === "boolean" ? tt.speakerBoost : null,
  };
}

export function ttsSettingsFrom(tts: TtsFormState): Record<string, unknown> {
  return {
    mode: tts.mode,
    provider: tts.provider,
    model: tts.model.trim(),
    voice: tts.voice.trim(),
    credentialRef: tts.credentialRef || null,
    baseURL: tts.baseURL.trim() || null,
    normalize: tts.normalize,
    normalizeProvider: tts.normalizeProvider || null,
    normalizeModel: tts.normalizeModel.trim() || null,
    normalizeCredentialRef: tts.normalizeCredentialRef || null,
    normalizeBaseURL: tts.normalizeBaseURL.trim() || null,
    // NOTE: blank clears the knob (null), so the operator can hand a field back to the provider
    // after having set it. readTtsConfig clamps whatever number survives.
    stability: numOrNull(tts.stability),
    similarityBoost: numOrNull(tts.similarityBoost),
    style: numOrNull(tts.style),
    speed: numOrNull(tts.speed),
    speakerBoost: tts.speakerBoost,
  };
}

// Switching the rewrite's provider invalidates everything that was picked FOR the old one: the model
// id (another vendor refuses it), the API key (same), and the base URL, which is the dangerous one
// because its field only renders for openai-compatible. Left behind, it keeps steering the new
// provider's client at an endpoint the operator can no longer see, and the rewrite fails or hangs.
export function ttsNormalizerProviderChanged(
  tts: TtsFormState,
  provider: string,
): TtsFormState {
  return {
    ...tts,
    normalizeProvider: provider,
    normalizeModel: "",
    normalizeCredentialRef: "",
    normalizeBaseURL: "",
  };
}

// The AGENT's provider changing is the rewrite's provider changing too, whenever the rewrite
// inherits it. Everything picked for the old vendor dies with it: a model id the new vendor refuses
// (every rewrite failing silently back to raw speech), and a key issued by the old vendor, which
// would otherwise be SENT to the new one. A rewrite that names its own provider is untouched, since
// nothing about it followed the agent in the first place.
export function ttsNormalizerAgentProviderChanged(
  tts: TtsFormState,
): TtsFormState {
  return tts.normalizeProvider === ""
    ? ttsNormalizerProviderChanged(tts, "")
    : tts;
}

// The editor's view of the SAME resolution the runtime will perform, so what the operator sees
// before saving and what actually runs cannot drift apart. Everything below projects
// `resolveNormalizeModel`; none of it re-derives the rule.
//
// The editor is stricter about one thing only: an endpoint has to be a valid http(s) URL here, so a
// half-typed one is refused before the save rather than at the first audio reply.
export interface AgentModelSource {
  provider: string;
  credentialRef: string;
  // The EFFECTIVE endpoint (the selected credential's, when it carries one, else the typed field).
  baseURL: string;
}

export function ttsNormalizerResolution(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): NormalizeModelResolution {
  return resolveNormalizeModel(
    tts,
    { provider: agent.provider, model: "", baseURL: agent.baseURL },
    { ownCredentialBaseURL: ownCredBaseUrl, isUsableBaseURL: isValidHttpUrl },
  );
}

// Whether the rewrite's API key field is REQUIRED. It is exactly "the resolution refuses to run for
// want of a credential": naming the agent's own provider inherits the key and demands nothing, an
// openai-compatible endpoint authenticates by its URL, and any other switch needs a key of its own.
export function ttsNormalizerNeedsOwnCredential(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): boolean {
  const r = ttsNormalizerResolution(tts, agent, ownCredBaseUrl);
  return !r.runnable && r.reason === "credential_required";
}

// What the model picker must authenticate with to list models: the credential the rewrite will
// ACTUALLY run on. On the one change this feature exists for ("same account, cheaper model") that is
// the agent's own, inherited on purpose, and a picker handed only the rewrite's empty fields showed
// "select a credential" with no models at all.
export function ttsNormalizerPickerSource(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): { credentialRef: string; baseURL: string } {
  const r = ttsNormalizerResolution(tts, agent, ownCredBaseUrl);
  if (!r.runnable) return { credentialRef: "", baseURL: "" };
  return {
    credentialRef:
      r.credential === "own"
        ? tts.normalizeCredentialRef
        : r.credential === "agent"
          ? agent.credentialRef
          : "",
    baseURL: r.baseURL ?? "",
  };
}

// An openai-compatible endpoint is nothing without its base URL: createChatModel refuses the
// configuration and the rewrite is skipped as `model_not_runnable` on every audio reply, silently.
// The agent's own model field is guarded the same way (GeneralTab's `modelBaseUrlInvalid`).
export function ttsNormalizerBaseUrlInvalid(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): boolean {
  // A rewrite that cannot run is not a misconfiguration to block the save on: with audio replies off
  // the whole block is hidden, so blocking Save here would freeze the Behavior tab with nothing on
  // screen to explain it, including the save that turns audio off in the first place.
  if (tts.mode === "never" || !tts.normalize) return false;
  const r = ttsNormalizerResolution(tts, agent, ownCredBaseUrl);
  return !r.runnable && r.reason === "endpoint_missing";
}
