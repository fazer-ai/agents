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
  // switch reasoning off on the calls that never carried tools and never failed. The adapter may
  // still send the call to /v1/responses on its own, so ./models writes it in the spelling of the
  // endpoint the built instance picks, which is a fact about that instance and not a policy here.
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

// The lowest effort a model accepts, read off its refusal of the tool pin. Measured on 2026-10-07:
// gpt-6-astra and gpt-6.1-sol refuse "none" on both endpoints (400, code "unsupported_value", param
// `reasoning_effort` or `reasoning.effort`) and name what they take ("Supported values are: 'low',
// 'medium', 'high', and 'xhigh'."), while gpt-6-luna and gpt-6-sol take it. So which models refuse it is
// the API's answer, not a list kept here: the refusal says the floor. Null for anything else (another
// status, another code, a refusal of the parameter itself, a list naming no effort we know), which is
// left to fail as it did.
export function toolEffortFloorOf(err: unknown): ReasoningEffort | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as {
    status?: unknown;
    code?: unknown;
    param?: unknown;
    message?: unknown;
  };
  if (e.status !== 400 || e.code !== "unsupported_value") return null;
  if (e.param !== "reasoning_effort" && e.param !== "reasoning.effort") {
    return null;
  }
  const listed = /Supported values are:([^\n]*)/i.exec(String(e.message ?? ""));
  if (!listed?.[1]) return null;
  const named = new Set(
    [...listed[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]),
  );
  return (
    REASONING_EFFORTS.find(
      (effort) => effort !== "none" && named.has(effort),
    ) ?? null
  );
}
