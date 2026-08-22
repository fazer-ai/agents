import { isValidHttpUrl } from "@/client/lib/validation";
import {
  type ModelOverride,
  type ModelOverrideResolution,
  resolveModelOverride,
} from "@/graph/model-override";

// The editor's view of a SECONDARY MODEL OVERRIDE — the four fields a feature carries when it may
// run on a model other than the agent's (the speech rewrite, the attendance summariser).
//
// Every function here PROJECTS `resolveModelOverride`; none re-derives the rule. That is the whole
// point: the operator has to see, before saving, the same decision the runtime will make, and the
// two drifting apart is how a configuration that looks fine in the editor turns into a feature that
// silently never runs.
//
// The editor is stricter about exactly one thing: an endpoint has to be a valid http(s) URL here, so
// a half-typed one is refused before the save rather than at the first call.
//
// Shared rather than copied per feature. The rules these functions project were found by review, one
// incident at a time, and the second copy would rediscover them the same way.

export interface AgentModelSource {
  provider: string;
  credentialRef: string;
  baseURL: string;
}

export function overrideResolution(
  override: ModelOverride,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): ModelOverrideResolution {
  return resolveModelOverride(
    override,
    { provider: agent.provider, model: "", baseURL: agent.baseURL },
    { ownCredentialBaseURL: ownCredBaseUrl, isUsableBaseURL: isValidHttpUrl },
  );
}

// Changing the provider clears the three fields that were picked FOR the old one. A model id and a
// key belong to the vendor they came from, and carrying them across is how a key ends up pointed at
// a vendor that never issued it.
export function overrideProviderChanged<T extends ModelOverride>(
  override: T,
  provider: string,
): T {
  return {
    ...override,
    provider,
    model: "",
    credentialRef: "",
    baseURL: "",
  };
}

// Picking a model or a key FOR the secondary call pins the vendor it was picked FROM. Left
// inherited, the pair comes apart the next time the agent's provider changes — on another tab, which
// does not even save together with this one — and the key follows it to a vendor that never issued
// it while the model id is asked of one that has never heard of it. The resolver refuses that
// configuration (`override_without_provider`); this is what keeps the editor from ever producing it,
// at no cost to the operator, who picked from a list the provider itself answered.
//
// Clearing the field does NOT unpin the provider: the operator may be mid-edit, and an explicit
// provider is never the wrong answer — it is only ever more specific than the blank one.
export function overridePicked<T extends ModelOverride>(
  override: T,
  field: "model" | "credentialRef",
  value: string,
  agentProvider: string,
): T {
  return {
    ...override,
    [field]: value,
    provider:
      value && !override.provider ? agentProvider : (override.provider ?? ""),
  };
}

// Whether the API-key field is REQUIRED. It is exactly "the resolution refuses to run for want of a
// credential": naming the agent's own provider inherits the key and demands nothing, an
// openai-compatible endpoint authenticates by its URL, and any other switch needs a key of its own.
export function overrideNeedsOwnCredential(
  override: ModelOverride,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): boolean {
  const r = overrideResolution(override, agent, ownCredBaseUrl);
  return !r.runnable && r.reason === "credential_required";
}

// What the model picker must authenticate with to list models: the credential the call will ACTUALLY
// run on. On the one change this exists for ("same account, cheaper model") that is the agent's own,
// inherited on purpose, and a picker handed only the override's empty fields shows "select a
// credential" with no models at all.
export function overridePickerSource(
  override: ModelOverride,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
): { credentialRef: string; baseURL: string } {
  const r = overrideResolution(override, agent, ownCredBaseUrl);
  if (!r.runnable) return { credentialRef: "", baseURL: "" };
  return {
    credentialRef:
      r.credential === "own"
        ? (override.credentialRef ?? "")
        : r.credential === "agent"
          ? agent.credentialRef
          : "",
    baseURL: r.baseURL ?? "",
  };
}

// Whether the endpoint in play is one this provider will never send. The operator can reach it in
// two clicks — pick a credential that carries a base URL while the call sits on a keyed vendor — and
// the field that would explain it does not even render for that provider.
//
// `sectionOn` is REQUIRED, and it is the whole reason these two are not plain projections like the
// rest of this file: both block the tab's Save, and each of these overrides lives inside a section
// the operator can switch OFF, which HIDES its fields. Answering "yes" for a section that is off
// freezes the Behavior tab with nothing on screen to explain it — including the save that turns the
// section off, so the operator cannot even undo their way out. Asking for it rather than reading it
// from the override is deliberate: the switch is not part of the model configuration, and the
// compiler is the only thing that will put the question to the next feature that adds an override.
export function overrideBaseUrlUnsupported(
  override: ModelOverride,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
  sectionOn: boolean,
): boolean {
  if (!sectionOn) return false;
  const r = overrideResolution(override, agent, ownCredBaseUrl);
  return !r.runnable && r.reason === "endpoint_unsupported";
}

// No endpoint the call can be sent to: an openai-compatible one with no address at all, or an address
// it brought itself that is not a dialable URL. Either way createChatModel refuses the configuration,
// or the request never leaves. `sectionOn` as above.
export function overrideBaseUrlInvalid(
  override: ModelOverride,
  agent: AgentModelSource,
  ownCredBaseUrl: string | null,
  sectionOn: boolean,
): boolean {
  if (!sectionOn) return false;
  const r = overrideResolution(override, agent, ownCredBaseUrl);
  return !r.runnable && r.reason === "endpoint_unusable";
}
