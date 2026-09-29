// Which OpenAI endpoint a turn goes to, and what reasoning effort travels on it (pure policy). On
// /v1/chat/completions the only effort that coexists with function tools is "none", so any explicit
// effort goes to /v1/responses; "none" goes there too, because the endpoints spell the parameter
// differently and keeping it on completions would mean predicting @langchain/openai's own routing.
// "minimal" is absent (every model rejects it); per-model acceptance is left to the API, not an
// allowlist here. The endpoint/effort table is in docs/graph.md, "OpenAI reasoning effort".

export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// Matches a bare id ("gpt-5.6-luna", "gpt-6-luna"), a routed one ("openai/gpt-6-luna",
// OpenRouter) and a fine-tuned one ("ft:gpt-6-luna:acme::x1"), which inherits the base model's
// server-side default and so inherits the rejection too. A point release of gpt-6 ("gpt-6.1-luna")
// is the same family. "gpt-5.60", "gpt-5.6x", "gpt-60", "gpt-6x" and "not-gpt-6-luna" deliberately
// do not match.
const DEFAULT_EFFORT_REJECTS_TOOLS_RE =
  /^(?:ft:)?(?:[\w.-]+\/)?gpt-(?:5\.6(?:-|$)|6(?:[.-]|$))/i;

export interface OpenAITransportPlan {
  // The Responses endpoint instead of Chat Completions. Carries reasoning together with function
  // tools, which is the only combination the completions endpoint refuses.
  responses: boolean;
  // Effort to send on EVERY call this model makes.
  effort?: ReasoningEffort;
  // Effort to pin ONLY on the tool-bound model. Reserved for the case where nobody asked for an
  // effort and the provider's own default is what breaks: pinning it on the constructor would
  // switch reasoning off on the calls that never carried tools and never failed. This is the one
  // effort still spelled for completions, so the factory drops it when the adapter is not taking
  // the request there — which is a fact about a built instance, not a policy, and so is decided in
  // ./models rather than guessed here.
  toolEffort?: ReasoningEffort;
}

// `requested` is the operator's explicit choice on the agent's modelConfig; undefined means they
// never touched it, which must keep behaving exactly as it did before the knob existed.
export function planOpenAITransport(
  model: string,
  requested: ReasoningEffort | undefined,
): OpenAITransportPlan {
  const m = model.trim();
  if (requested === undefined) {
    return DEFAULT_EFFORT_REJECTS_TOOLS_RE.test(m)
      ? { responses: false, toolEffort: "none" }
      : { responses: false };
  }
  return { responses: true, effort: requested };
}
