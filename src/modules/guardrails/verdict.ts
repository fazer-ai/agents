// How a guardrail verdict is ASKED FOR and how it is READ; the analysis itself lives in ./analyze.
// Where the provider implements constrained decoding the schema travels with the call; elsewhere the
// prompt asks for "ONLY a JSON object" and the answer is recovered from the text.
// `acceptsConstrainedOutput` decides by ENDPOINT, never by model quality. Both paths end at
// `readVerdict`, whose rule is that an unreadable verdict never looks "clean": guardrails fail OPEN, so
// ambiguity collapsed into CLEAN is a message delivered unscreened. `error` keeps the two apart.

// How a call asks for the verdict. Not a capability of the model: the same adapter serves an endpoint
// we know and one we do not, so this is decided from the provider and travels with the call. The two
// constrained values are one shape in two DIALECTS: Gemini refuses the json-schema dialect outright.
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

// The verdict shape, as JSON Schema rather than as prose in the prompt. A plain schema, NOT a zod
// type: with a schema, json that is not a verdict arrives as `parsed` unvalidated (so
// `verdictFromObject` re-checks it), while a zod type makes the OpenAI adapter reject the whole call.
// `includeRaw` keeps the model's text reachable when the schema produced nothing (Anthropic answering
// in text instead of the forced tool; on OpenAI non-json fails inside the call). Strict mode needs a
// closed object with every property required, so `suggestedReply` is required AND nullable.
// `categories` is NOT an enum: a `customPolicy` violation has no key, and constraining the vocabulary
// would edit what a model that JUDGES may say.
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

// The same verdict in the OpenAPI 3.0 subset Gemini's responseSchema speaks: `type` holds ONE value
// and nullability is a flag. Asked with the type union above, Gemini answers 400 and every screen
// would cost a second prose call. Derived from the schema above so shared fields cannot drift; a NEW
// nullable field would keep its union here, which tests/modules/guardrail-verdict.test.ts catches.
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

// The response must contain EXACTLY ONE verdict; anything else is "we did not get an answer", since
// for moderation ambiguity fails towards "unknown", never "clean". Prose with braces after a verdict
// drops out (not parseable); `{}` or `{"violated": "true"}` are not candidates; a self-correction gives
// two candidates, and taking the last one would silently approve a violation when it is the stale one.
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
