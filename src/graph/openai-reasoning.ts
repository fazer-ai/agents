// Which OpenAI endpoint a turn goes to, and what reasoning effort travels on it. Pure policy, kept
// out of the client factory because the whole thing is a table of measured API behaviour rather
// than wiring.
//
// Measured against the live API on 2026-08-15, one function tool attached, four models across two
// generations (`gpt-5.6-luna`, `gpt-5.6-sol`, `gpt-5.4-mini`, `gpt-5.5`):
//
// | endpoint             | effort sent      | result                                              |
// | -------------------- | ---------------- | --------------------------------------------------- |
// | /v1/chat/completions | absent           | 400 on the gpt-5.6 family, 200 on everything older   |
// | /v1/chat/completions | "none"           | 200 everywhere                                       |
// | /v1/chat/completions | low..max         | 400 EVERYWHERE, including gpt-5.4-mini and gpt-5.5   |
// | /v1/responses        | absent, none..max| 200 everywhere                                       |
//
// The rejection reads "Function tools with reasoning_effort are not supported for <model> in
// /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to
// 'none'." So the ceiling is the ENDPOINT's, not the family's: on completions the only effort that
// coexists with function tools is "none", and the gpt-5.6 family is special only in that its
// server-side default is not "none" (which is what issue #66 hit). Any effort above "none" is
// therefore a transport decision, and that is the single rule this module encodes.
//
// "none" takes the same endpoint as every other explicit choice, even though completions accepts it
// (measured 200 there, with and without tools). The two endpoints spell the parameter differently
// and neither takes the other's spelling ("Unknown parameter: 'reasoning'" on completions,
// "Unsupported parameter: 'reasoning_effort'. In the Responses API, this parameter has moved to
// 'reasoning.effort'" on responses), while @langchain/openai routes some models to /v1/responses on
// its own regardless of what we ask (_modelPrefersResponsesAPI: gpt-5.2-pro, gpt-5.4-pro,
// gpt-5.5-pro, and any id containing "codex"). Keeping "none" on completions would therefore mean
// PREDICTING the adapter's routing in order to pick the spelling, i.e. maintaining a copy of its
// model list. Sending every explicit choice to one endpoint removes the prediction.
//
// "minimal" is deliberately absent from the vocabulary: every model measured rejects it
// ("Unsupported value: 'minimal' is not supported with the '<model>' model"). "max" is present
// because the API's own error message advertises it on the gpt-5.6 family and it answered 200
// there, even though the installed openai SDK's `ReasoningEffort` type does not list it. Which
// efforts a given model accepts is the API's business, not ours: gpt-5.4-mini rejects "max" with a
// message naming the model and the values it does take, and inventing our own per-model allowlist
// here would be a table to maintain forever (the lesson from issue #64's tool-schema sanitizer).

export const REASONING_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

// NOTE: matches a bare id ("gpt-5.6-luna"), a routed one ("openai/gpt-5.6-luna", OpenRouter) and a
// fine-tuned one ("ft:gpt-5.6-luna:acme::x1"), which inherits the base model's server-side default
// and so inherits the rejection too. "gpt-5.60", "gpt-5.6x" and "not-gpt-5.6-luna" deliberately do
// not match.
const DEFAULT_EFFORT_REJECTS_TOOLS_RE =
  /^(?:ft:)?(?:[\w.-]+\/)?gpt-5\.6(?:-|$)/i;

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
