// How a guardrail verdict is ASKED FOR and how it is READ. The analysis itself (which checks run,
// what travels in which call) lives in ./analyze; this file owns the answer's shape.
//
// A verdict arrives one of two ways. Where the provider implements constrained decoding the schema
// below travels with the call and the model cannot answer outside it; everywhere else the model is
// asked in the prompt for "ONLY a JSON object" and the answer is recovered from whatever text comes
// back. `acceptsConstrainedOutput` (./graph/model-config) decides which, and the split is about the
// ENDPOINT, never about how good the model is.
//
// Both paths end at `readVerdict`, and they share one rule that this feature has broken three times:
// a verdict that could not be read must never come out looking like a verdict that says "clean".
// Guardrails fail OPEN, so every ambiguity collapsed into CLEAN is a message delivered unscreened
// under a control the operator believes is running. `error` is what keeps the two apart.

// How a call asks for the verdict. Not a capability of the model: the same adapter serves an
// endpoint we know and one we do not, so this is decided from the provider and travels with the
// call. The two constrained values are the same shape in two DIALECTS, and the split is not
// cosmetic — measured live, asking Gemini in the json-schema dialect is refused outright.
export type VerdictMode = "prose" | "json-schema" | "openapi";

export interface GuardrailVerdict {
  violated: boolean;
  categories: string[];
  rationale: string;
  // A safe replacement reply the model proposed (used when the direction's action is "generated").
  suggestedReply: string | null;
  // Set when the analysis could not be performed (model error, timeout, unusable output). The
  // verdict is still non-violating — fail-open is the policy — but the caller must be able to tell
  // "screened and approved" from "never screened", which are the same value without this.
  error?: string;
}

export const CLEAN: GuardrailVerdict = {
  violated: false,
  categories: [],
  rationale: "",
  suggestedReply: null,
};

export const unanalyzed = (error: string): GuardrailVerdict => ({
  ...CLEAN,
  error,
});

// The verdict shape, as JSON Schema rather than as prose in the prompt.
//
// NOTE: a plain schema and NOT a zod type, which changes what happens on a deviation rather than
// how this reads. Measured against local servers standing in for each adapter: handed a schema, an
// answer that IS json but is not a verdict arrives as `parsed` unvalidated (`{"violado": true}`
// came through untouched), which is why `verdictFromObject` re-checks it here instead of trusting
// the decoder; handed a zod type, the OpenAI adapter routes the call through the SDK's own parser,
// which rejects the whole call instead.
//
// NOTE: `includeRaw` is what keeps the model's own text reachable when the schema produced nothing.
// How far that reaches depends on the adapter, and it was measured rather than assumed: on
// Anthropic a reply that answers in TEXT instead of calling the forced tool arrives as
// `parsed: null` with the text intact, and `readVerdict` recovers it; on OpenAI a reply that is not
// json fails inside the call itself, so there is nothing left to recover and the analysis reports
// the failure — the same "not screened" it would have reported before, one retry later.
//
// NOTE: strict mode (OpenAI) requires a closed object with every property listed as required, so
// `suggestedReply` is required AND nullable: the model must answer the field, and null is one of
// the answers. `categories` is deliberately NOT an enum — an operator's `customPolicy` has no key
// in the prompt, so a violation of it would have no legal value to report, and constraining the
// vocabulary would edit what a model that JUDGES is allowed to say.
export const VERDICT_SCHEMA = {
  title: "guardrail_verdict",
  type: "object",
  additionalProperties: false,
  required: ["violated", "categories", "rationale", "suggestedReply"],
  properties: {
    violated: { type: "boolean" },
    categories: { type: "array", items: { type: "string" } },
    rationale: { type: "string" },
    suggestedReply: { type: ["string", "null"] },
  },
  // NOTE: `satisfies` and not a type annotation: the literal types survive, so a test can read the
  // shape back, and the constraint below still fails the build if the strict-mode invariants are
  // dropped (a closed object, and a `required` list).
} as const satisfies {
  title: string;
  type: "object";
  additionalProperties: false;
  required: readonly string[];
  properties: Record<
    string,
    { type: string | readonly string[]; items?: unknown }
  >;
};

// The same verdict in the OpenAPI 3.0 subset, which is what Gemini's responseSchema speaks: `type`
// holds ONE value and nullability is a flag beside it. Measured live on gemini-3.5-flash and
// -flash-lite: asked with the type union above, the request comes back 400 ("Proto field is not
// repeating, cannot start list") and the analysis has to be remade in prose, so every screen costs
// two calls; asked like this, one call answers, with `suggestedReply` still allowed to be null.
//
// NOTE: derived from the schema above rather than written out, so the two cannot drift apart on the
// fields they share. What derivation cannot catch is a NEW nullable field, which would keep its
// type union here — tests/modules/guardrail-verdict.test.ts fails on exactly that.
export const VERDICT_SCHEMA_OPENAPI = {
  ...VERDICT_SCHEMA,
  properties: {
    ...VERDICT_SCHEMA.properties,
    suggestedReply: { type: "string", nullable: true },
  },
} as const;

// Every TOP-LEVEL balanced object in the response, in order. Nested objects are not returned (they
// belong to their parent), braces inside strings do not count, and \" does not close one.
function topLevelObjects(raw: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (c === "\\") {
      if (inString) escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0 && --depth === 0) {
      out.push(raw.slice(start, i + 1));
    }
  }
  return out;
}

// One object to a verdict, or null when the object does not answer the question. `violated` is the
// answer, so a value that is not a boolean is not a verdict: `{"violated": "true"}` is parseable,
// truthy in JS, and reads as clean to a human, which is three different wrong answers from one
// unvalidated field.
//
// Used by BOTH paths. The constrained answer is validated here too rather than trusted: strict
// decoding is a property of the endpoint, and this repository reaches endpoints that only claim to
// be the one they imitate.
export function verdictFromObject(
  obj: Record<string, unknown>,
): GuardrailVerdict | null {
  if (typeof obj.violated !== "boolean") return null;
  if (obj.violated === false) return CLEAN;
  const categories = Array.isArray(obj.categories)
    ? obj.categories.filter((c): c is string => typeof c === "string")
    : [];
  return {
    violated: true,
    categories,
    rationale: typeof obj.rationale === "string" ? obj.rationale : "",
    suggestedReply:
      typeof obj.suggestedReply === "string" && obj.suggestedReply.trim()
        ? obj.suggestedReply.trim()
        : null,
  };
}

// The response must contain EXACTLY ONE verdict, and anything else is "we did not get an answer".
// One rule, because three rounds of review found three ways to read a non-answer as an approval, and
// they were all the same mistake: for a moderation feature, ambiguity has to fail towards "unknown",
// never towards "clean". What it settles, in order of how they were found:
//
//   * a verdict followed by prose that carries braces ("the policy {toxicity} applies") — the prose
//     is not a parseable verdict, so it drops out and the real one is still found;
//   * `{}` or `{"violated": "true"}` — parseable and unusable, so neither of them is a candidate;
//   * a self-correction (`{"violated": true}` … `Correction: {"violated": false}`) — two candidates,
//     and picking either one is a guess about which the model meant.
//
// The alternative for the last case, taking the last object, is a guess in the other direction: the
// same shape would silently approve a real violation whenever the trailing object is the stale one.
function parseVerdict(raw: string): GuardrailVerdict {
  const candidates: GuardrailVerdict[] = [];
  for (const slice of topLevelObjects(raw)) {
    try {
      const verdict = verdictFromObject(
        JSON.parse(slice) as Record<string, unknown>,
      );
      if (verdict) candidates.push(verdict);
    } catch {
      // NOTE: Not a verdict; prose and half-written objects are expected here.
    }
  }
  if (candidates.length === 0)
    return unanalyzed("no usable verdict in response");
  if (candidates.length > 1) {
    return unanalyzed(`${candidates.length} conflicting verdicts in response`);
  }
  return candidates[0] as GuardrailVerdict;
}

// The single reader both paths end at. `parsed` is the schema's answer when there was one; `raw` is
// the text the model wrote, which is all there is on the prose path and is still worth reading on
// the constrained one — an answer the schema could not validate is not a reason to throw away what
// the model actually said, and reading it is what the prose path has always done.
export function readVerdict(
  parsed: Record<string, unknown> | null,
  raw: string,
): GuardrailVerdict {
  return (parsed ? verdictFromObject(parsed) : null) ?? parseVerdict(raw);
}
