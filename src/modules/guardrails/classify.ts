import logger from "@/api/lib/logger";
import { providerFailure } from "@/lib/provider-failure";
import type { DecisionQuestion } from "@/modules/decisions/config";
import {
  DECISION_PROVIDER_REGISTRY,
  type DecisionResult,
} from "@/modules/decisions/providers";
import { activeChecks, checkKey, customerMessageForReview } from "./prompts";
import type {
  GuardrailChecks,
  GuardrailDecisionsConfig,
  GuardrailThresholdKey,
} from "./settings";

// The guardrail screening on a classification API of the decisions engine (Jev on TypeSafe, OpenAI
// Decisions) instead of the chat verdict in ./analyze. Each enabled check, and the operator's policy,
// is one yes/no question whose "yes" is the violation; a check trips when its probability reaches its
// threshold. No rationale and no replacement reply: the provider answers numbers, which is also what
// the log may keep. The operator's policy travels as written, so the settings screen asks for it as a
// yes/no question: a statement to check against reads as a violation on clean replies.

const CLASSIFY_TIMEOUT_MS = 15_000;

// The policy's key in the trace, the log and the operator note. The checks keep the keys the chat
// verdict uses (prompts.ts), so a trip reads the same whoever judged it.
export const CUSTOM_POLICY_KEY = "custom_policy";

export interface GuardrailScore {
  category: string;
  // Null when the provider did not answer this question (or refused it): never read as clean or
  // violated, and reported as an analysis that did not complete.
  probability: number | null;
  threshold: number;
}

export interface ClassifierVerdict {
  violated: boolean;
  categories: string[];
  scores: GuardrailScore[];
  // Set when a call could not run or a question went unanswered. Fail-open, as the chat verdict:
  // whatever did answer still counts.
  error?: string;
  // One entry per call that came back, for the ledger.
  calls: { inputTokens: number; durationMs: number }[];
}

export interface ClassifyParams {
  direction: "input" | "output";
  text: string;
  checks: GuardrailChecks;
  competitors: string[];
  customPolicy: string;
  systemPrompt?: string;
  customerMessage?: string;
}

const subjectOf = (direction: "input" | "output") =>
  direction === "input" ? "the customer message" : "the assistant reply";

const QUESTION: Record<
  keyof GuardrailChecks,
  (s: string, p: ClassifyParams) => string
> = {
  toxicity: (s) =>
    `Does ${s} contain harassment, hate speech, insults, or abusive/threatening language?`,
  unsafeContent: (s) =>
    `Does ${s} contain sexual content, graphic violence, instructions for illegal or dangerous acts, or self-harm?`,
  competitorMentions: (s, p) =>
    `Does ${s} mention, recommend or promote any of these competitors: ${p.competitors.join(", ")}?`,
  promptAdherence: (s) =>
    `Does ${s} go outside the scope, persona or policy set by the agent's instructions (off-topic, contradicts them, or leaks internal details)?`,
  answerRelevance: (s) =>
    `Does ${s} fail to answer what the customer actually asked: address a different question, leave the customer's question unanswered, or decline something the assistant is there to handle? Declining a request that is outside the assistant's scope or policy, and saying so, is an answer. A reply that gives more than was asked, or continues an exchange already under way, is still an answer.`,
};

interface Ask {
  input: string;
  questions: (DecisionQuestion & { threshold: number })[];
}

// The questions this screening asks, split the way ./analyze splits the chat verdict: the relevance
// question is the only one that reads the customer's message, and that message in the same input
// pulls the other checks toward it (a customer naming a competitor flags the reply). So relevance
// travels in a call of its own, in parallel.
export function guardrailAsks(
  p: ClassifyParams,
  thresholds: Record<GuardrailThresholdKey, number>,
): Ask[] {
  const s = subjectOf(p.direction);
  const relevanceMessage = customerMessageForReview({
    direction: p.direction,
    checks: p.checks,
    competitors: p.competitors,
    customPolicy: p.customPolicy,
    customerMessage: p.customerMessage,
  });
  const policyQs: Ask["questions"] = [];
  let relevanceQ: Ask["questions"][number] | null = null;
  for (const k of activeChecks(p)) {
    // No names, nothing to match: the chat verdict lists the policy anyway, but a question naming no
    // competitor asks the provider to guess what "a competitor" is.
    if (k === "competitorMentions" && p.competitors.length === 0) continue;
    const q = {
      name: checkKey(k),
      type: "yes_no" as const,
      instructions: QUESTION[k](s, p),
      threshold: thresholds[k],
    };
    if (k === "answerRelevance") {
      if (relevanceMessage !== null) relevanceQ = q;
    } else policyQs.push(q);
  }
  const policy = p.customPolicy.trim();
  if (policy) {
    policyQs.push({
      name: CUSTOM_POLICY_KEY,
      type: "yes_no",
      instructions: policy,
      threshold: thresholds.customPolicy,
    });
  }
  const instructions = p.systemPrompt?.trim();
  const reply = `Assistant reply (the text to judge):\n${p.text}`;
  const asks: Ask[] = [];
  if (policyQs.length > 0) {
    asks.push({
      input:
        p.direction === "input"
          ? `Customer message:\n${p.text}`
          : p.checks.promptAdherence && instructions
            ? `The agent's instructions:\n"""\n${instructions}\n"""\n\n${reply}`
            : reply,
      questions: policyQs,
    });
  }
  if (relevanceQ) {
    asks.push({
      input: [
        ...(instructions
          ? [
              `The agent's instructions, only to tell what the assistant is there to handle:\n"""\n${instructions}\n"""`,
            ]
          : []),
        `Customer message:\n${relevanceMessage}`,
        reply,
      ].join("\n\n"),
      questions: [relevanceQ],
    });
  }
  return asks;
}

export async function classifyGuardrail(
  cfg: GuardrailDecisionsConfig,
  p: ClassifyParams,
  apiKey: string,
  baseURL: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<ClassifierVerdict> {
  const asks = guardrailAsks(p, cfg.thresholds);
  const provider = DECISION_PROVIDER_REGISTRY[cfg.provider];
  const results = await Promise.all(
    asks.map(async (ask) => {
      const started = Date.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), CLASSIFY_TIMEOUT_MS);
      try {
        const r: DecisionResult = await provider.decide({
          input: ask.input,
          questions: ask.questions.map(({ threshold, ...q }) => q),
          model: cfg.model,
          apiKey,
          baseURL,
          fetchImpl,
          signal: ctl.signal,
        });
        return {
          ok: true as const,
          ask,
          r,
          durationMs: Date.now() - started,
        };
      } catch (err) {
        // The closed vocabulary only: a provider body can echo the text under review.
        const why = providerFailure(err, ctl.signal.aborted);
        logger.warn(
          { provider: cfg.provider, failure: why },
          "guardrails classification failed (fail-open, message not blocked)",
        );
        return { ok: false as const, ask, error: why };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const scores: GuardrailScore[] = [];
  const errors: string[] = [];
  const calls: ClassifierVerdict["calls"] = [];
  for (const res of results) {
    if (!res.ok) {
      errors.push(res.error);
      for (const q of res.ask.questions)
        scores.push({
          category: q.name,
          probability: null,
          threshold: q.threshold,
        });
      continue;
    }
    calls.push({ inputTokens: res.r.inputTokens, durationMs: res.durationMs });
    for (const q of res.ask.questions) {
      const a = res.r.answers[q.name];
      const probability = a?.type === "yes_no" ? a.probability : null;
      if (probability === null) errors.push(`no answer for ${q.name}`);
      scores.push({ category: q.name, probability, threshold: q.threshold });
    }
  }
  const categories = scores
    .filter((s) => s.probability !== null && s.probability >= s.threshold)
    .map((s) => s.category);
  return {
    violated: categories.length > 0,
    categories,
    scores,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
    calls,
  };
}
