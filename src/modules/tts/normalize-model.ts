import {
  MODEL_PROVIDERS,
  type ModelConfig,
  PROVIDERS_HONORING_BASE_URL,
} from "@/graph/model-config";
import { PROVIDER_DEFAULT_MODEL } from "@/graph/model-defaults";

// WHICH model rewrites the reply for speech, on WHOSE key, at WHICH endpoint, and whether that
// configuration may run at all. One function answers all four, because they are one question: every
// wrong answer here is the same failure, a secret belonging to one vendor arriving at another.
//
// Review found five separate paths into it, and they all had one shape: HALF of the destination
// stored next to the key, the other half read from something that moves — the agent's provider, the
// agent's endpoint, a provider name nobody validated. A key is only ever as pinned as its least
// pinned half, so a dedicated credential names its vendor AND brings its own endpoint, and the
// agent's key travels only while the destination is unchanged in both halves.
//
// Those five were also symptoms of the resolution being spread across the runtime, the editor and
// the health check, each re-deriving it. It now lives here, and the editor projects THIS rather than
// re-implementing it.
//
// The shape of the rule:
//
//   * UNKNOWN provider (a name REST or MCP stored that is not a provider we support): nothing runs.
//     Falling back to the agent's provider while keeping the dedicated credential would send that
//     key to a vendor it does not belong to, which is how a typo becomes a leak.
//   * SAME provider, ON THE AGENT'S KEY: each unset field falls back to the agent's, field by
//     field. This is the case the feature exists for ("same account, cheaper model"), and it is what
//     keeps an install that touches nothing behaving as before.
//   * DIFFERENT provider: nothing is inherited, because everything the agent holds belongs to the
//     old vendor. The model would be an id the new one refuses, the endpoint would send the NEW key
//     to the OLD gateway, and the KEY would hand one vendor's secret to another.
//   * DIFFERENT endpoint on the SAME provider: the vendor matches but the host does not, and the
//     agent's key was not issued for that host either. It is the same leak with a smaller radius.
//
// And the credential, which is the part that decides whether a switched provider runs at all:
//
//   * `own`   — a credential was configured for the rewrite. Always allowed, and inherits NOTHING
//               about where it is sent: it names the vendor it belongs to, and it carries its own
//               endpoint (or falls back to that vendor's, never to the agent's).
//   * `agent` — the agent's own key, allowed ONLY while the DESTINATION is unchanged: same vendor
//               and same host.
//   * `none`  — no key travels at all. Reachable only for `openai-compatible`, which authenticates
//               through its base URL (a local llama.cpp-style server has no key). Without this the
//               only way to run a local rewrite would be to invent a dummy vault entry.

export interface NormalizeModelSource {
  provider: string;
  model: string;
  // NOTE: null and undefined both mean "unset" here: the settings readers store null, ModelConfig
  // carries undefined, and this sits between the two.
  baseURL: string | null | undefined;
}

// The four overrides, as either transport spells them: `TtsConfig` (nullable, from the settings
// reader) and the editor's `TtsFormState` (blank strings) are both assignable to this.
export interface NormalizeOverrides {
  normalizeProvider?: string | null;
  normalizeModel?: string | null;
  normalizeCredentialRef?: string | null;
  normalizeBaseURL?: string | null;
}

export type NormalizeCredentialSource = "own" | "agent" | "none";

export type NormalizeNotRunnableReason =
  // A provider name we do not support. Never falls back, never carries the credential.
  | "provider_unknown"
  // A model id or a credential picked for the rewrite while its provider was left inherited. Both
  // were chosen FOR whatever the agent's provider happened to be at the time, and nothing records
  // which one that was, so the next change to the agent's provider re-points them at a vendor that
  // never issued the key and does not answer to the model id.
  | "override_without_provider"
  // The rewrite points somewhere the agent's key does not belong (another vendor, or another host),
  // with no key of its own and no way to authenticate without one.
  | "credential_required"
  // No endpoint the rewrite can actually be sent to: absent where the provider has no address of
  // its own, or present and undialable. Same outcome either way, so the same refusal.
  | "endpoint_unusable"
  // An endpoint configured for a provider whose adapter drops it. Passing it anyway is not a no-op:
  // the call leaves for the vendor's public endpoint carrying the key AND the customer's text, which
  // is the opposite of what asking for a proxy meant.
  | "endpoint_unsupported";

export interface NormalizeModelResolution {
  provider: string;
  model: string;
  baseURL: string | null;
  // False when the saved configuration must not be built at all. The caller skips the rewrite (the
  // audio still goes out, from the raw text) and records the reason.
  runnable: boolean;
  reason?: NormalizeNotRunnableReason;
  credential: NormalizeCredentialSource;
}

function str(v: string | null | undefined): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

// Two spellings of one endpoint are one destination. The comparison that decides whether the
// agent's key may travel used to be the raw string, so `https://host/v1/` next to the agent's
// `https://host/v1` counted as another host: on openai-compatible the key was dropped and every
// rewrite failed to authenticate, on a keyed vendor the configuration was refused as
// `credential_required`. Canonical form (as the URL parser sees it: case-insensitive scheme and
// host, default port dropped) with the trailing slashes off the path. Deliberately NOT origin-only:
// a gateway can key its paths (`/tenant-a/v1` vs `/tenant-b/v1`), and sending one path's key to
// another is the leak with the smaller radius the rule above describes.
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
  reason: NormalizeNotRunnableReason,
): NormalizeModelResolution => ({
  provider,
  model: "",
  baseURL: null,
  runnable: false,
  reason,
  credential: "none",
});

export interface ResolveNormalizeOptions {
  // The base URL stored ON the rewrite's own credential, which outranks the typed field the same way
  // it does everywhere else in the tree. The runtime reads it from the vault; the editor gets it
  // from the credential picker.
  ownCredentialBaseURL?: string | null;
  // What counts as a usable endpoint. The runtime only cares that something is there (an endpoint it
  // cannot parse is the provider's problem to report); the editor passes a stricter http(s) check so
  // it can refuse the save before the fact. Same rule, two strictnesses, one implementation.
  isUsableBaseURL?: (raw: string) => boolean;
}

export function resolveNormalizeModel(
  tts: NormalizeOverrides,
  agent: NormalizeModelSource,
  opts: ResolveNormalizeOptions = {},
): NormalizeModelResolution {
  const usable = opts.isUsableBaseURL ?? ((raw: string) => raw.trim() !== "");
  const raw = str(tts.normalizeProvider);
  if (raw !== null && !(MODEL_PROVIDERS as readonly string[]).includes(raw)) {
    return NOT_RUNNABLE(raw, "provider_unknown");
  }
  const provider = raw ?? agent.provider;
  const switched = provider !== agent.provider;
  const own = str(tts.normalizeCredentialRef) !== null;

  // Anything picked for the rewrite was picked FOR a vendor, and has to say which one, because
  // nothing else does. The agent's provider is not that answer: it is a moving target, and the tabs
  // of the editor do not even save together, so changing it on the General tab alone leaves these
  // fields behind — a key now pointed at a vendor that never issued it, a model id now asked of one
  // that has never heard of it. Naming the provider (even the agent's own, which the editor fills in
  // the moment either field is set) is what pins them together in the settings bag, where they
  // survive as a pair. Only a rewrite that overrides NOTHING may leave it blank, and that one has
  // nothing to go stale.
  if ((own || str(tts.normalizeModel) !== null) && raw === null) {
    return NOT_RUNNABLE(provider, "override_without_provider");
  }

  const agentBaseURL = str(agent.baseURL);
  const ownBaseURL =
    str(opts.ownCredentialBaseURL) ?? str(tts.normalizeBaseURL);
  // The agent's endpoint is inherited by a rewrite that rides the agent WHOLE — its vendor and its
  // key — and by no other. A dedicated key that borrows the host has the same shape as a dedicated
  // key that borrowed the vendor: half of the destination is stored, the other half belongs to a
  // field the operator edits on another tab, and the day it moves the key follows it to a host that
  // never issued it. Naming the vendor pins one half; this pins the other.
  const inheritsAgent = !switched && !own;
  const baseURL = inheritsAgent ? (ownBaseURL ?? agentBaseURL) : ownBaseURL;
  const hasEndpoint = baseURL !== null && usable(baseURL);

  // An endpoint is not a courtesy for openai-compatible: it IS the address, and the credential can
  // be nothing more than that address. Both checks below hang off it.
  //
  // What "usable" means is the CALLER's, and the editor's is stricter than the runtime's, so a
  // configuration only the editor can refuse is one only the editor will ever judge. That makes the
  // second half load-bearing: an endpoint the rewrite brought ITSELF and that no client can dial is
  // no endpoint at all, whatever provider it was typed for, and openrouter is a provider that
  // accepts one. An INHERITED one is not judged, for the same reason endpoint_unsupported does not
  // judge it: the rewrite lands wherever the agent's own model lands.
  if (
    !hasEndpoint &&
    (provider === "openai-compatible" || ownBaseURL !== null)
  ) {
    return NOT_RUNNABLE(provider, "endpoint_unusable");
  }

  // And an endpoint the provider cannot carry is worse than no endpoint: the adapter drops it in
  // silence and the request goes to the vendor's own host instead of the one the operator named.
  // Refusing costs a rewrite; running costs a proxy that was chosen for a reason.
  //
  // Only the rewrite's OWN endpoint is judged here. An INHERITED one is not a promise this feature
  // made: the rewrite lands wherever the agent's own model lands, dropped field and all, which is
  // the one thing this whole resolution exists to guarantee. Refusing there would take the rewrite
  // away from every install whose agent carries an endpoint its provider never used.
  if (
    ownBaseURL !== null &&
    !(PROVIDERS_HONORING_BASE_URL as readonly string[]).includes(provider)
  ) {
    return NOT_RUNNABLE(provider, "endpoint_unsupported");
  }

  // What makes the agent's key reusable is not "the same vendor", it is the same DESTINATION: the
  // vendor AND the host. An overridden endpoint on the agent's own provider is still somewhere the
  // agent's key was never issued for, and sending it there is the same leak as sending it to another
  // vendor. (Reachable from the editor, which shows the endpoint field for openai-compatible while
  // leaving the key optional.) Pointing the rewrite at a proxy on purpose is still supported, and it
  // is spelled out rather than inherited: name the credential and the endpoint it is for.
  const sameDestination = !switched && sameEndpoint(baseURL, agentBaseURL);

  let credential: NormalizeCredentialSource;
  if (own) {
    credential = "own";
  } else if (sameDestination) {
    credential = "agent";
  } else if (provider === "openai-compatible") {
    // Guaranteed to have an endpoint by the check above, and that endpoint is the whole credential:
    // nothing secret travels, so an unrelated host receives nothing of the agent's.
    credential = "none";
  } else {
    return NOT_RUNNABLE(provider, "credential_required");
  }

  return {
    provider,
    model:
      str(tts.normalizeModel) ??
      (switched
        ? (PROVIDER_DEFAULT_MODEL[provider as ModelConfig["provider"]] ?? "")
        : agent.model),
    baseURL,
    runnable: true,
    credential,
  };
}
