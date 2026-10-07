// Classification providers for the `decisions` engine (docs/decisions.md). Each one turns shared text
// plus typed questions into typed answers, normalized here to one shape so the rules never know which
// API answered. Adding a provider = one function + one registry entry, as in vision/providers.ts.
//
// TEXT ONLY, on both, on purpose: the observer already renders transcriptions and image descriptions
// into the text it reads, and sending images to one provider and not the other would make the two
// incomparable on the same agent. The key never lands in the URL or the logs, and neither does a
// response body: what a provider failure may say is the closed vocabulary of lib/provider-failure.ts.

import type { DecisionProvider, DecisionQuestion } from "./config";

export type DecisionAnswer =
  | { type: "yes_no"; probability: number }
  | {
      type: "choice";
      choice: string;
      confidence: number | null;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number | null;
      probabilities: Record<string, number>;
    }
  | { type: "refusal" };

export interface DecisionRequest {
  input: string;
  questions: DecisionQuestion[];
  model: string;
  apiKey: string;
  baseURL: string | null;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}

export interface DecisionResult {
  // Keyed by question name. A question the provider did not answer is absent, never invented.
  answers: Record<string, DecisionAnswer>;
  // The model the provider says answered: TypeSafe resolves an alias (`jev-latest`) to a version
  // (`jev-1.13.0`); OpenAI echoes the id. Null when the body names none.
  modelVersion: string | null;
  // Billed input; both providers charge nothing for output (pricing/price.ts).
  inputTokens: number;
}

export interface DecisionProviderImpl {
  defaultBaseURL: string;
  decide(req: DecisionRequest): Promise<DecisionResult>;
}

// A failure the provider answered with a status. The body is never read into it: it may echo the
// conversation, and `providerFailure` reads only the numeric status (lib/provider-failure.ts).
export class DecisionProviderError extends Error {
  constructor(
    readonly provider: DecisionProvider,
    readonly status: number,
  ) {
    super(`decisions ${provider} failed with ${status}`);
    this.name = "DecisionProviderError";
  }
}

// A 200 whose body is not the documented shape. No status to report, so it reads "provider error".
export class DecisionResponseError extends Error {
  constructor(readonly provider: DecisionProvider) {
    super(`decisions ${provider} answered an unreadable body`);
    this.name = "DecisionResponseError";
  }
}

function unit(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(Math.max(v, 0), 1)
    : null;
}

function tokens(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path}`;
}

async function post(
  provider: DecisionProvider,
  url: string,
  req: DecisionRequest,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await req.fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!res.ok) {
    // Drained and dropped: the body may carry the conversation back.
    await res.body?.cancel().catch(() => {});
    throw new DecisionProviderError(provider, res.status);
  }
  const json = (await res.json().catch(() => null)) as unknown;
  if (!json || typeof json !== "object") {
    throw new DecisionResponseError(provider);
  }
  return json as Record<string, unknown>;
}

// OpenAI Decisions: POST /v1/decisions, `input` plus a `questions` ARRAY, answers as an array
// carrying each question's `name` (developers.openai.com/api/docs/guides/decisions). Input-only:
// $0.10 per 1M for `gpt-6-luna`, the table's own input rate for that id.
const openai: DecisionProviderImpl = {
  defaultBaseURL: "https://api.openai.com/v1",
  async decide(req) {
    const questions = req.questions.map((q) => {
      if (q.type === "choice") {
        return {
          name: q.name,
          type: "choice",
          instructions: q.instructions,
          choices: q.options.map((o) => ({
            value: o.value,
            description: o.description,
          })),
        };
      }
      if (q.type === "score") {
        return {
          name: q.name,
          type: "score",
          instructions: q.instructions,
          levels: q.levels.map((l) => ({
            label: l.value,
            description: l.description,
          })),
        };
      }
      return { name: q.name, type: "predicate", instructions: q.instructions };
    });
    const json = await post(
      "openai",
      endpoint(req.baseURL ?? openai.defaultBaseURL, "/decisions"),
      req,
      { model: req.model, input: req.input, questions },
    );
    if (!Array.isArray(json.answers)) throw new DecisionResponseError("openai");
    const byName = new Map(req.questions.map((q) => [q.name, q]));
    const answers: Record<string, DecisionAnswer> = {};
    for (const raw of json.answers as Record<string, unknown>[]) {
      const q = byName.get(String(raw?.name));
      if (!q) continue;
      const a = readOpenAIAnswer(q, raw);
      if (a) answers[q.name] = a;
    }
    const usage = (json.usage ?? {}) as Record<string, unknown>;
    return {
      answers,
      modelVersion: typeof json.model === "string" ? json.model : null,
      inputTokens: tokens(usage.input_tokens),
    };
  },
};

function readOpenAIAnswer(
  q: DecisionQuestion,
  raw: Record<string, unknown>,
): DecisionAnswer | null {
  if (raw.type === "refusal") return { type: "refusal" };
  // Probabilities come as an array: a choice's entries carry the option `value`; a score's carry the
  // level index as `value` and the level's `label`. Keyed here by what our config calls the option or
  // level (`value`), so both providers key an answer the same way.
  const probs = (): Record<string, number> => {
    const out: Record<string, number> = {};
    if (Array.isArray(raw.probabilities)) {
      for (const p of raw.probabilities as Record<string, unknown>[]) {
        const key =
          q.type === "score"
            ? typeof p?.label === "string"
              ? p.label
              : typeof p?.value === "number"
                ? q.levels[p.value]?.value
                : undefined
            : p?.value;
        const v = unit(p?.probability);
        if (typeof key === "string" && v !== null) out[key] = v;
      }
    }
    return out;
  };
  if (q.type === "yes_no" && raw.type === "predicate") {
    const p = unit(raw.probability);
    return p === null ? null : { type: "yes_no", probability: p };
  }
  if (q.type === "choice" && raw.type === "choice") {
    return typeof raw.choice === "string"
      ? {
          type: "choice",
          choice: raw.choice,
          confidence: unit(raw.confidence),
          probabilities: probs(),
        }
      : null;
  }
  if (q.type === "score" && raw.type === "score") {
    return typeof raw.score === "number" && Number.isFinite(raw.score)
      ? {
          type: "score",
          score: raw.score,
          confidence: unit(raw.confidence),
          probabilities: probs(),
        }
      : null;
  }
  return null;
}

// TypeSafe Jev, the official API only: POST /v1/systemone, `state` plus a `questions` MAP keyed by
// name, types `noul` (yes/no), `choice` (criteria: option -> description) and `score` (criteria:
// ordered descriptions), answers keyed by the same names (docs.typesafe.ai/api). The response
// reports `output_tokens`, but only input is billed; the rate lives with the others
// (pricing/price.ts, `PUBLISHED_RATES`), so the caller records input tokens only.

const typesafe: DecisionProviderImpl = {
  defaultBaseURL: "https://api.typesafe.ai/v1",
  async decide(req) {
    const questions: Record<string, unknown> = {};
    for (const q of req.questions) {
      if (q.type === "choice") {
        questions[q.name] = {
          type: "choice",
          instructions: q.instructions,
          criteria: Object.fromEntries(
            q.options.map((o) => [o.value, o.description || null]),
          ),
        };
      } else if (q.type === "score") {
        questions[q.name] = {
          type: "score",
          instructions: q.instructions,
          criteria: q.levels.map((l) =>
            l.description ? `${l.value}: ${l.description}` : l.value,
          ),
        };
      } else {
        questions[q.name] = { type: "noul", instructions: q.instructions };
      }
    }
    const json = await post(
      "typesafe",
      endpoint(req.baseURL ?? typesafe.defaultBaseURL, "/systemone"),
      req,
      { model: req.model, state: req.input, questions },
    );
    const raw = json.answers;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new DecisionResponseError("typesafe");
    }
    const answers: Record<string, DecisionAnswer> = {};
    for (const q of req.questions) {
      const a = readTypeSafeAnswer(
        q,
        (raw as Record<string, Record<string, unknown>>)[q.name],
      );
      if (a) answers[q.name] = a;
    }
    const usage = (json.usage ?? {}) as Record<string, unknown>;
    return {
      answers,
      modelVersion: typeof json.model === "string" ? json.model : null,
      inputTokens: tokens(usage.input_tokens),
    };
  },
};

function readTypeSafeAnswer(
  q: DecisionQuestion,
  raw: Record<string, unknown> | undefined,
): DecisionAnswer | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.type === "refusal") return { type: "refusal" };
  const probs = (keys?: string[]): Record<string, number> => {
    const out: Record<string, number> = {};
    const p = raw.probabilities;
    if (p && typeof p === "object" && !Array.isArray(p)) {
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        const n = unit(v);
        // A score's probabilities are keyed by level index ("0", "1"...): mapped to the level's value
        // so both providers key a score the same way.
        const key = keys?.[Number(k)] ?? k;
        if (n !== null) out[key] = n;
      }
    }
    return out;
  };
  if (q.type === "yes_no" && raw.type === "noul") {
    const p = unit(raw.noul);
    return p === null ? null : { type: "yes_no", probability: p };
  }
  if (q.type === "choice" && raw.type === "choice") {
    return typeof raw.choice === "string"
      ? {
          type: "choice",
          choice: raw.choice,
          confidence: unit(raw.confidence),
          probabilities: probs(),
        }
      : null;
  }
  if (q.type === "score" && raw.type === "score") {
    return typeof raw.score === "number" && Number.isFinite(raw.score)
      ? {
          type: "score",
          score: raw.score,
          confidence: unit(raw.confidence),
          probabilities: probs(q.levels.map((l) => l.value)),
        }
      : null;
  }
  return null;
}

export const DECISION_PROVIDER_REGISTRY: Record<
  DecisionProvider,
  DecisionProviderImpl
> = { openai, typesafe };
