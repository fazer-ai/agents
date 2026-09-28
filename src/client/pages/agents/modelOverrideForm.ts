import { isValidHttpUrl } from "@/client/lib/validation";
import {
  type ModelOverride,
  type ModelOverrideResolution,
  resolveModelOverride,
} from "@/graph/model-override";

// The editor's view of a SECONDARY MODEL OVERRIDE: the four fields a feature carries when it may run
// on a model other than the agent's (the speech rewrite, the attendance summariser). Every function
// here PROJECTS `resolveModelOverride` rather than re-deriving it, so the operator sees before saving
// the decision the runtime will make. The one stricter check: an endpoint must be a valid http(s)
// URL here. Shared rather than copied per feature, so each feature gets every rule.

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

// Picking a model or a key FOR the secondary call pins the vendor it was picked FROM. Left inherited,
// a later change of the agent's provider (on another tab) would send the key and model to a vendor
// that never issued them; the resolver refuses that (`override_without_provider`). Clearing the
// field does NOT unpin: the operator may be mid-edit, and an explicit provider is never wrong.
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

// Whether the endpoint in play is one this provider will never send (a credential with a base URL
// on a keyed vendor, whose field does not render). `sectionOn` is REQUIRED: both checks block Save,
// and a switched-off section hides its fields, so answering "yes" there would freeze the tab with
// no way out. It is an argument, not read off the override, so every new override must answer it.
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
