import { TTS_PROVIDERS } from "@/client/lib/providerDefaults";
import { isValidHttpUrl } from "@/client/lib/validation";
import {
  type NormalizeModelResolution,
  resolveNormalizeModel,
} from "@/modules/tts/normalize-model";
import {
  clampVoiceSetting,
  readVoiceSettings,
  TTS_DEFAULTS,
  TTS_MODES,
  type TtsMode,
} from "@/modules/tts/settings-shared";

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

export function readTtsFormState(block: unknown): TtsFormState {
  const tt = (block ?? {}) as Record<string, unknown>;
  // The delivery knobs are hydrated through the RUNTIME's reader, not off the raw bag: REST and
  // import store whatever they are handed, and synthesis clamps it on the way out. Reading the raw
  // number would put a 9 on screen for a voice that speaks at 4, with nothing admitting the
  // difference, and it would stay there, since nothing rewrites the bag until the tab is saved.
  const voice = readVoiceSettings(tt);
  // Mode and provider are ALLOWLISTED, exactly as the runtime reader allowlists them. A bag can
  // carry anything (REST and import store what they are handed, and "Mirror" is one keystroke from
  // "mirror"): the runtime falls back to "never" and to openai, while a raw value here puts an
  // empty `<select>` on screen above a fully-rendered audio section for an agent that will never
  // send audio, and saves the same string straight back.
  const mode = str(tt.mode);
  const provider = str(tt.provider);
  return {
    mode: mode && TTS_MODES.includes(mode as TtsMode) ? mode : "never",
    provider:
      provider && (TTS_PROVIDERS as readonly string[]).includes(provider)
        ? provider
        : "openai",
    model: str(tt.model),
    voice: str(tt.voice),
    credentialRef: str(tt.credentialRef),
    baseURL: str(tt.baseURL),
    normalize:
      typeof tt.normalize === "boolean" ? tt.normalize : TTS_DEFAULTS.normalize,
    normalizeProvider: str(tt.normalizeProvider),
    normalizeModel: str(tt.normalizeModel),
    normalizeCredentialRef: str(tt.normalizeCredentialRef),
    normalizeBaseURL: str(tt.normalizeBaseURL),
    stability: num(voice.stability),
    similarityBoost: num(voice.similarityBoost),
    style: num(voice.style),
    speed: num(voice.speed),
    speakerBoost: voice.speakerBoost ?? null,
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
    // after having set it. The clamp is the READER's, applied here too because the save persists
    // what the form holds, and what the form holds is whatever was TYPED: without this the bag
    // would carry a number synthesis never uses, out to every other reader of it (MCP, export).
    stability: clampVoiceSetting("stability", numOrNull(tts.stability)),
    similarityBoost: clampVoiceSetting(
      "similarityBoost",
      numOrNull(tts.similarityBoost),
    ),
    style: clampVoiceSetting("style", numOrNull(tts.style)),
    speed: clampVoiceSetting("speed", numOrNull(tts.speed)),
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

// Picking a model or a key FOR the rewrite pins the vendor it was picked FROM. Left inherited, the
// pair comes apart the next time the agent's provider changes — on the General tab, which does not
// even save together with this one — and the key follows it to a vendor that never issued it while
// the model id is asked of one that has never heard of it. The resolver refuses that configuration
// (`override_without_provider`); this is what keeps the editor from ever producing it, at no cost to
// the operator, who picked from a list the provider itself answered.
//
// Clearing the field does NOT unpin the provider: the operator may be mid-edit, and an explicit
// provider is never the wrong answer — it is only ever more specific than the blank one.
export function ttsNormalizerOverridePicked(
  tts: TtsFormState,
  field: "normalizeModel" | "normalizeCredentialRef",
  value: string,
  agentProvider: string,
): TtsFormState {
  return {
    ...tts,
    [field]: value,
    normalizeProvider:
      value && tts.normalizeProvider === ""
        ? agentProvider
        : tts.normalizeProvider,
  };
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

// Whether the endpoint in play is one this provider will never send. The operator can reach it in
// two clicks — pick a credential that carries a base URL while the rewrite sits on a keyed vendor —
// and the field that would explain it does not even render for that provider. So the field renders
// whenever there IS an endpoint in play, and says which of the two things is wrong.
export function ttsNormalizerBaseUrlUnsupported(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): boolean {
  if (tts.mode === "never" || !tts.normalize) return false;
  const r = ttsNormalizerResolution(tts, agent, ownCredBaseUrl);
  return !r.runnable && r.reason === "endpoint_unsupported";
}

// No endpoint the rewrite can be sent to: an openai-compatible one with no address at all, or an
// address it brought itself that is not a dialable URL. Either way createChatModel refuses the
// configuration, or the request never leaves, and the rewrite is skipped as `model_not_runnable` on
// every audio reply, silently. The agent's own model field is guarded the same way (GeneralTab's
// `modelBaseUrlInvalid`).
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
  return !r.runnable && r.reason === "endpoint_unusable";
}
