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

// Whether the rewrite's API key field is REQUIRED, mirroring what `resolveNormalizeModel` will do
// with the saved settings: a provider the agent does not use inherits nothing, so without a key of
// its own the rewrite is refused outright (the agent's key belongs to the other vendor and is never
// transmitted there) and every audio reply goes out unrewritten, silently. Naming the agent's OWN
// provider is how a separate key on the same vendor gets attached, and that is optional.
//
// Blank means "inherit", which is never a switch. The editor is the only place this is visible
// before the fact, so a field that fails to demand the key is a defect, not a nicety.
export function ttsNormalizerNeedsOwnCredential(
  normalizeProvider: string,
  agentProvider: string,
): boolean {
  const named = normalizeProvider.trim();
  return named !== "" && named !== agentProvider;
}

// The agent's own model, as the editor holds it. `baseURL` is the EFFECTIVE one (the selected
// credential's, when it carries one, else the typed field), which is what the runtime ends up using.
export interface AgentModelSource {
  provider: string;
  credentialRef: string;
  baseURL: string;
}

// Which credential and endpoint the rewrite actually runs on, mirroring `resolveNormalizeModel`
// field by field. The model picker lists models by CALLING the provider, so handing it only the
// rewrite's own fields left it with nothing to authenticate with on the one change this feature
// exists for ("same account, cheaper model"): the operator names the agent's provider, leaves the
// key inherited, and the model list came back empty with "select a credential".
//
// A DIFFERENT provider inherits nothing, for the same reason the resolver refuses it: everything the
// agent holds belongs to the other vendor.
export function ttsNormalizerEffectiveSource(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): { credentialRef: string; baseURL: string } {
  const switched = ttsNormalizerNeedsOwnCredential(
    tts.normalizeProvider,
    agent.provider,
  );
  const ownBaseUrl = ownCredBaseUrl ?? tts.normalizeBaseURL.trim();
  if (switched) {
    return {
      credentialRef: tts.normalizeCredentialRef,
      baseURL: ownBaseUrl,
    };
  }
  return {
    credentialRef: tts.normalizeCredentialRef || agent.credentialRef,
    baseURL: ownBaseUrl || agent.baseURL,
  };
}

// An openai-compatible endpoint is nothing without its base URL: `createChatModel` rejects the
// configuration, the build throws, and the rewrite is skipped as `model_not_runnable` on every audio
// reply, silently. The agent's own model field is guarded the same way (GeneralTab's
// `modelBaseUrlInvalid`), and this is the same guard for the rewrite's — including the inherited
// case, where the endpoint comes from the agent and is already guaranteed by that other check.
export function ttsNormalizerBaseUrlInvalid(
  tts: TtsFormState,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
  isValidUrl: (raw: string) => boolean,
): boolean {
  if (!tts.normalize) return false;
  if (tts.normalizeProvider.trim() !== "openai-compatible") return false;
  const { baseURL } = ttsNormalizerEffectiveSource(tts, agent, ownCredBaseUrl);
  return !isValidUrl(baseURL);
}
