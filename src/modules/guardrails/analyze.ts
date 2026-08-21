import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import logger from "@/api/lib/logger";
import { runModelCall } from "@/graph/model-limit";
import {
  buildGuardrailSystemPrompt,
  customerMessageForReview,
  fenceCustomerMessage,
  type GuardrailPromptParams,
} from "./prompts";

const ANALYZE_TIMEOUT_MS = 15_000;

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

const CLEAN: GuardrailVerdict = {
  violated: false,
  categories: [],
  rationale: "",
  suggestedReply: null,
};

function messageText(content: BaseMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) =>
        typeof c === "string"
          ? c
          : c && typeof c === "object" && "text" in c
            ? String((c as { text: unknown }).text)
            : "",
      )
      .join("");
  }
  return "";
}

const unanalyzed = (error: string): GuardrailVerdict => ({ ...CLEAN, error });

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
  const candidates: Record<string, unknown>[] = [];
  for (const slice of topLevelObjects(raw)) {
    try {
      const obj = JSON.parse(slice) as Record<string, unknown>;
      if (typeof obj.violated === "boolean") candidates.push(obj);
    } catch {
      // NOTE: Not a verdict; prose and half-written objects are expected here.
    }
  }
  if (candidates.length === 0)
    return unanalyzed("no usable verdict in response");
  if (candidates.length > 1) {
    return unanalyzed(`${candidates.length} conflicting verdicts in response`);
  }
  const obj = candidates[0] as Record<string, unknown>;
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

type AnalysisParams = GuardrailPromptParams & { text: string };

// answer_relevance is the only check whose input is the customer's own message, and putting that
// message in the same call as the other policies CONTAMINATES them. Measured live against
// gpt-5.4-mini, same reply and same checks, only the message differing: a reply naming nobody was
// flagged competitor_mention in 11 of 16 runs because the CUSTOMER had named a competitor, against
// 0 of 16 with the message absent. Prompt wording could not carry this: a sentence scoping the
// message to one check took another configuration from 6/16 to 3/16, and the variant that named the
// policies to ignore took it to 8/16 — telling a model not to consider something makes it consider
// it. So the separation is structural. The policies keep exactly the call they had before this
// feature existed, and answer_relevance gets its own, where there is nothing to contaminate.
// Exported for its own test. What travels in each half is the property this whole change turns on,
// and asserting it through the built prompt would pass for the wrong reason: `checks` already gates
// the competitor list, the agent's instructions and the customer's message, so every strip below
// looks redundant from the outside until the day one of those gates moves.
export function splitAnalyses(p: AnalysisParams): {
  policies: AnalysisParams | null;
  relevance: AnalysisParams | null;
} {
  // NOTE: Same predicate that decides whether the message travels at all: no message, no second call, and
  // the analysis is byte for byte the one that shipped before.
  if (customerMessageForReview(p) === null) {
    return { policies: p, relevance: null };
  }
  const otherChecks = { ...p.checks, answerRelevance: false };
  const judgesTheReply =
    Object.values(otherChecks).some(Boolean) || p.customPolicy.trim() !== "";
  return {
    policies: judgesTheReply
      ? { ...p, checks: otherChecks, customerMessage: undefined }
      : null,
    // NOTE: Everything that judges the reply is stripped from this one, the operator's own policy
    // included. Built by dropping keys rather than listing them, so a check added later starts off
    // here instead of silently riding along with the customer's words.
    relevance: {
      ...p,
      checks: Object.fromEntries(
        (Object.keys(p.checks) as (keyof typeof p.checks)[]).map((k) => [
          k,
          k === "answerRelevance",
        ]),
      ) as unknown as typeof p.checks,
      competitors: [],
      customPolicy: "",
      systemPrompt: undefined,
      // NOTE: This half never writes a replacement, whatever the action is, and the runtime falls back to
      // the configured template message. Two reasons, and the second is the one that settles it:
      //
      //   * the policies were stripped from this call so the customer's words cannot trip them, so
      //     a replacement written here would be written without the rules it has to obey. Handing
      //     them over as writing guidance was tried and MEASURED: 5 of 10 replacements still named
      //     a competitor the operator had banned, in the same breath as being told never to;
      //   * a relevance violation means the reply did not ANSWER, so there is nothing to rewrite
      //     and the model would have to invent the answer, with no tools, no knowledge base and no
      //     account data. In those same 10 runs, 3 stated a commercial fact it could not know
      //     ("Sim, trabalhamos com a Zenvia"). Toxicity rewrites what the agent said; relevance
      //     would be fabricating what the business does.
      generationPrompt: undefined,
    },
  };
}

// Strips the proposed replacement, so the runtime falls back to the configured template message.
// Two callers, and they are the two analyses with nothing to rewrite: a relevance violation (below)
// and the whole INPUT direction (see `analyzeGuardrail`). Dropping the generation guidance is not
// enough on its own for either: the response shape still asks for `suggestedReply`, and a model that
// writes one anyway would have it delivered.
//
// It must not write one. A relevance violation means the reply did not ANSWER, so there is nothing
// to rewrite and the model has to invent the answer, with no tools, no knowledge base and no
// account data. Measured against gpt-5.4-mini, 10 replacements for one such violation: 3 stated a
// commercial fact the model could not know ("Sim, trabalhamos com a Zenvia", to a customer asking
// whether we work with them), and 5 named a competitor the operator had banned while being told in
// the same prompt never to mention it. Toxicity rewrites what the agent said; relevance would be
// fabricating what the business does.
const withoutReplacement = (v: GuardrailVerdict): GuardrailVerdict => ({
  ...v,
  suggestedReply: null,
});

// Two analyses, one verdict. A violation on either side is a violation; an error on either side is
// reported, because "one half never ran" must not read as "screened and approved".
function mergeVerdicts(
  a: GuardrailVerdict,
  b: GuardrailVerdict,
): GuardrailVerdict {
  const errors = [a.error, b.error].filter((e): e is string => Boolean(e));
  const rationale = [a, b]
    .filter((v) => v.violated && v.rationale)
    .map((v) => v.rationale)
    .join("; ");
  return {
    violated: a.violated || b.violated,
    categories: [...new Set([...a.categories, ...b.categories])],
    rationale,
    suggestedReply: a.suggestedReply ?? b.suggestedReply,
    ...(errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

// Run the guardrails agent over `text`. Best-effort and FAIL-OPEN: any model/timeout/parse error
// returns a non-violating verdict, so a transient failure never blocks the conversation (the trip is
// logged; the operator monitors via the flowlog). Mirrors llmNormalizeForSpeech's shape.
export async function analyzeGuardrail(
  model: BaseChatModel,
  params: AnalysisParams,
): Promise<GuardrailVerdict> {
  const { policies, relevance } = splitAnalyses(params);
  if (relevance === null) {
    const verdict = await runAnalysis(model, policies as AnalysisParams);
    // NOTE: The INPUT direction never delivers a replacement. There is no assistant reply to repair
    // there — the analyzed text is the CUSTOMER's message — so "write a safe replacement" has no
    // referent and the model composes one from an empty desk. Measured live against eight models
    // from three vendors, and every failure below is one of them writing that message:
    //
    //   * whose turn it is. It answers in the CUSTOMER's own voice, and the bot posts that back TO
    //     the customer: claude-fable-5 16 of 16 ("Estou aguardando retorno há algum tempo e
    //     gostaria de saber quanto custa a avaliação"), gpt-5.4-mini 14 of 32, claude-haiku-4.5
    //     2 of 16. On the fixture that asks about a competitor, gpt-5.4-mini named the one the
    //     operator had banned 14 of 32.
    //   * what it cannot know. gemini-3.5-flash-lite sent the customer an unfilled template slot
    //     10 of 16: "O valor da avaliação é [inserir valor]".
    //   * who is writing. The customer's message reaches this model at user level, so it can simply
    //     ask for the reply it wants, and asking the model to compose one is what makes that
    //     request on-task. With one such message: gpt-4o-mini produced the dictated text 16 of 16,
    //     verbatim ("A avaliação custa R$ 99,00 e trabalhamos com a Zenvia" — a price no operator
    //     set, a competitor the operator had banned, on the company's own channel), gpt-5.4-nano
    //     15 of 16, gemini-3.5-flash-lite 3 of 16, and gpt-4.1-nano did something worse than
    //     compose: it returned a CLEAN verdict 16 of 16, so the injected message switched the
    //     guardrail off and went through to the agent.
    //
    // Which of those three an install gets is a property of the model the operator happened to
    // pick: gemini-3.5-flash tripped none of them, and still spoke for the business on a turn the
    // agent never ran. Constraining the writer by wording was measured too and held at 0 of 64 —
    // but what it then produces is one fixed sentence ("Não posso ajudar com mensagens ofensivas.
    // Se quiser, reformule…"), which is a template the operator can write once, without a model
    // call.
    return params.direction === "input" ? withoutReplacement(verdict) : verdict;
  }
  if (policies === null) {
    return withoutReplacement(await runAnalysis(model, relevance));
  }
  // NOTE: In parallel: the operator is paying for a turn a customer is waiting on.
  const [byPolicy, byRelevance] = await Promise.all([
    runAnalysis(model, policies),
    runAnalysis(model, relevance).then(withoutReplacement),
  ]);
  // NOTE: A rewrite from the policy half PRESERVES the substance of the reply and repairs its form, which
  // is the whole reason it is allowed to write one. When relevance also tripped, the substance is
  // what was wrong, so that rewrite is a polite version of a reply that still does not answer, and
  // it reads more like an answer than the original did. The template goes out instead.
  return mergeVerdicts(
    byRelevance.violated ? withoutReplacement(byPolicy) : byPolicy,
    byRelevance,
  );
}

async function runAnalysis(
  model: BaseChatModel,
  params: AnalysisParams,
): Promise<GuardrailVerdict> {
  const system = buildGuardrailSystemPrompt(params);
  // NOTE: The customer's message rides at USER level, fenced and named, never inside the system prompt:
  // there it would read as one more instruction from the operator, and the customer writes it. The
  // text under review keeps its bare shape, so a call with the check off is byte-identical to before.
  const customer = fenceCustomerMessage(params);
  const messages: BaseMessage[] = [new SystemMessage(system)];
  if (customer !== null) messages.push(new HumanMessage(customer));
  messages.push(new HumanMessage(params.text));
  try {
    const res = await runModelCall(() =>
      model.invoke(messages, {
        signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      }),
    );
    return parseVerdict(messageText(res.content).trim());
  } catch (err) {
    logger.warn(
      { err },
      "guardrails analysis failed (fail-open, message not blocked)",
    );
    return unanalyzed(err instanceof Error ? err.message : String(err));
  }
}
