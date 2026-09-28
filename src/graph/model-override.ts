import {
  MODEL_PROVIDERS,
  type ModelConfig,
  PROVIDERS_HONORING_BASE_URL,
} from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";

// Which model a secondary call runs on (the speech rewrite before TTS, the summariser), on WHOSE key,
// at WHICH endpoint, and whether it may run at all: one function, because every wrong answer is the
// same failure, one vendor's secret arriving at another. Each call is an OVERRIDE of the agent's own
// model, so an empty bag behaves as before. Shared, not copied: every leak path has one shape, half
// the destination stored with the key and half read from something that moves. An UNKNOWN provider
// runs nothing (falling back while keeping the credential would send it to the wrong vendor). The
// SAME provider on the agent's key inherits unset fields one by one. A DIFFERENT provider inherits
// nothing: the agent's model, endpoint and key all belong to the old vendor.

// The agent's own model, which an unset override field falls back to.
export interface OverrideAgentModel {
  provider: string;
  model: string;
  // NOTE: null and undefined both mean "unset" here: the settings readers store null, ModelConfig
  // carries undefined, and this sits between the two.
  baseURL: string | null | undefined;
}

// The four overrides, as either transport spells them: a settings reader (nullable) and an editor
// form (blank strings) are both assignable to this.
export interface ModelOverride {
  provider?: string | null;
  model?: string | null;
  credentialRef?: string | null;
  baseURL?: string | null;
}

// `own`: a credential configured for the call, always allowed, inheriting nothing about where it is
// sent (its own endpoint, or its vendor's, never the agent's). `agent`: the agent's key, allowed ONLY
// while the destination (vendor and host) is unchanged. `none`: no key travels, reachable only for
// `openai-compatible`, which authenticates through its base URL (a local server has no key), so a
// local model needs no dummy vault entry.
export type ModelOverrideCredential = "own" | "agent" | "none";

export type ModelOverrideNotRunnableReason =
  // A provider name we do not support. Never falls back, never carries the credential.
  | "provider_unknown"
  // A model id or a credential picked for the call while its provider was left inherited. Both were
  // chosen FOR whatever the agent's provider happened to be at the time, and nothing records which
  // one that was, so the next change to the agent's provider re-points them at a vendor that never
  // issued the key and does not answer to the model id.
  | "override_without_provider"
  // The call points somewhere the agent's key does not belong (another vendor, or another host),
  // with no key of its own and no way to authenticate without one.
  | "credential_required"
  // No endpoint the call can actually be sent to: absent where the provider has no address of its
  // own, or present and undialable. Same outcome either way, so the same refusal.
  | "endpoint_unusable"
  // An endpoint configured for a provider whose adapter drops it. Passing it anyway is not a no-op:
  // the call leaves for the vendor's public endpoint carrying the key AND the text, which is the
  // opposite of what asking for a proxy meant.
  | "endpoint_unsupported";

export interface ModelOverrideResolution {
  provider: string;
  model: string;
  baseURL: string | null;
  // False when the saved configuration must not be built at all. What the caller does then is its
  // own: the speech rewrite is skipped and the audio goes out from the raw text, the summariser
  // fails its job rather than writing memory it cannot stand behind. Neither may fall back to the
  // agent's model: that is the leak this resolution exists to prevent.
  runnable: boolean;
  reason?: ModelOverrideNotRunnableReason;
  credential: ModelOverrideCredential;
}

function str(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Two spellings of one endpoint are one destination: compared raw, `https://host/v1/` beside
// `https://host/v1` would count as another host, dropping the key on openai-compatible and refusing
// a keyed vendor as `credential_required`. Canonical URL form (case-insensitive scheme and host,
// default port dropped) without trailing slashes. Deliberately NOT origin-only: a gateway can key its
// paths (`/tenant-a/v1` vs `/tenant-b/v1`), and sending one path's key to another is the same leak
// with a smaller radius.
function sameEndpoint(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  const canonical = (raw: string): string => {
    try {
      const u = new URL(raw);
      u.pathname = u.pathname.replace(/\/+$/, "");
      return u.href;
    } catch {
      return raw;
    }
  };
  return canonical(a) === canonical(b);
}

const NOT_RUNNABLE = (
  provider: string,
  reason: ModelOverrideNotRunnableReason,
): ModelOverrideResolution => ({
  provider,
  model: "",
  baseURL: null,
  runnable: false,
  reason,
  credential: "none",
});

export interface ResolveModelOverrideOptions {
  // The base URL stored ON the call's own credential, which outranks the typed field the same way
  // it does everywhere else in the tree. The runtime reads it from the vault; the editor gets it
  // from the credential picker.
  ownCredentialBaseURL?: string | null;
  // What counts as a usable endpoint. The runtime only cares that something is there (an endpoint it
  // cannot parse is the provider's problem to report); the editor passes a stricter http(s) check so
  // it can refuse the save before the fact. Same rule, two strictnesses, one implementation.
  isUsableBaseURL?: (raw: string) => boolean;
}

export function resolveModelOverride(
  override: ModelOverride,
  agent: OverrideAgentModel,
  opts: ResolveModelOverrideOptions = {},
): ModelOverrideResolution {
  const usable = opts.isUsableBaseURL ?? ((raw: string) => raw.trim() !== "");
  const raw = str(override.provider);
  if (raw !== null && !(MODEL_PROVIDERS as readonly string[]).includes(raw)) {
    return NOT_RUNNABLE(raw, "provider_unknown");
  }
  const provider = raw ?? agent.provider;
  const switched = provider !== agent.provider;
  const own = str(override.credentialRef) !== null;

  // NOTE: anything picked for a secondary call was picked FOR a vendor and has to name it. The
  // agent's provider is a moving target (the editor's tabs do not save together), so changing it
  // alone would leave a key and a model id pointed at a vendor that never issued them. Naming the
  // provider pins them together in the settings bag; only a call overriding NOTHING may leave it blank.
  if ((own || str(override.model) !== null) && raw === null) {
    return NOT_RUNNABLE(provider, "override_without_provider");
  }

  const agentBaseURL = str(agent.baseURL);
  const ownBaseURL = str(opts.ownCredentialBaseURL) ?? str(override.baseURL);
  const inheritsAgent = !switched && !own;
  const baseURL = inheritsAgent ? (ownBaseURL ?? agentBaseURL) : ownBaseURL;
  const hasEndpoint = baseURL !== null && usable(baseURL);

  // NOTE: for openai-compatible the endpoint IS the address, and the credential can be nothing more.
  // "Usable" is the CALLER's, and the editor's is stricter than the runtime's, so an endpoint the call
  // brought ITSELF that no client can dial is refused whatever the provider (openrouter accepts one).
  // An INHERITED one is not judged: the call lands wherever the agent's own model lands.
  if (
    !hasEndpoint &&
    (provider === "openai-compatible" || ownBaseURL !== null)
  ) {
    return NOT_RUNNABLE(provider, "endpoint_unusable");
  }

  // NOTE: an endpoint the provider cannot carry is worse than none: the adapter drops it silently and
  // the request goes to the vendor's own host. Refusing costs one secondary call. Only the call's OWN
  // endpoint is judged: an inherited one lands wherever the agent's model lands, and refusing it would
  // take the feature from every install whose agent carries an endpoint its provider never used.
  if (
    ownBaseURL !== null &&
    !(PROVIDERS_HONORING_BASE_URL as readonly string[]).includes(provider)
  ) {
    return NOT_RUNNABLE(provider, "endpoint_unsupported");
  }

  // NOTE: the agent's key is reusable at the same DESTINATION, vendor AND host: an overridden endpoint
  // on the agent's own provider is somewhere the key was never issued for (reachable from the editor,
  // which shows the endpoint for openai-compatible with the key optional). A proxy on purpose is
  // supported by naming the credential and the endpoint it is for.
  const sameDestination = !switched && sameEndpoint(baseURL, agentBaseURL);

  let credential: ModelOverrideCredential;
  if (own) {
    credential = "own";
  } else if (sameDestination) {
    credential = "agent";
  } else if (provider === "openai-compatible") {
    // NOTE: guaranteed an endpoint by the check above, and that endpoint is the whole credential:
    // nothing secret travels, so an unrelated host receives nothing of the agent's.
    credential = "none";
  } else {
    return NOT_RUNNABLE(provider, "credential_required");
  }

  return {
    provider,
    model:
      str(override.model) ??
      (switched
        ? (PROVIDER_DEFAULT_MODEL[provider as ModelConfig["provider"]] ?? "")
        : agent.model),
    baseURL,
    runnable: true,
    credential,
  };
}
