import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
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
  judgesAnything,
} from "./prompts";
import {
  type GuardrailVerdict,
  readVerdict,
  unanalyzed,
  VERDICT_SCHEMA,
  VERDICT_SCHEMA_OPENAPI,
  type VerdictMode,
} from "./verdict";

const ANALYZE_TIMEOUT_MS = 15_000;

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

type AnalysisParams = GuardrailPromptParams & { text: string };

// answer_relevance is the only check whose input is the customer's own message, and that message in
// the same call CONTAMINATES the other policies (a customer naming a competitor gets the reply flagged
// competitor_mention). Wording cannot fix it: telling a model to ignore something makes it consider
// it. So relevance gets its own call and the policies keep theirs without the message. Exported for
// its own test, since `checks` already gates most fields and every strip below looks redundant from
// the built prompt until one of those gates moves.
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
  // Same question the gate asks before screening at all, from the same definition: whether a prompt
  // built from these checks would list anything. Two copies of it would differ the day a check
  // becomes direction-specific, and the copy that forgot would send an empty policy list.
  const judgesTheReply = judgesAnything({ ...p, checks: otherChecks });
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
      // NOTE: this half never writes a replacement; the runtime falls back to the configured template.
      // The policies were stripped from this call, so a replacement would ignore them, and a relevance
      // violation means the reply did not ANSWER, so the model would have to invent a commercial fact.
      generationPrompt: undefined,
    },
  };
}

// Strips the proposed replacement, so the runtime falls back to the configured template message. For
// the two analyses with nothing to rewrite: a relevance violation and the whole INPUT direction.
// Dropping the generation guidance alone is not enough: the response shape still asks for
// `suggestedReply`, and one written anyway would be delivered. A relevance replacement would have to
// invent the answer with no tools or data, fabricating what the business does.
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
  // How the verdict is asked for. Decided from the PROVIDER by the caller
  // (`acceptsConstrainedOutput`), and passed rather than inferred here: the same adapter serves an
  // endpoint we own and one we know nothing about, so the instance cannot answer this.
  mode: VerdictMode,
  // The turn's usage sink: a guardrail analysis is a billed model call, and without this it is spent
  // money with no row.
  callbacks?: BaseCallbackHandler[],
): Promise<GuardrailVerdict> {
  const { policies, relevance } = splitAnalyses(params);
  if (relevance === null) {
    const verdict = await runAnalysis(
      model,
      policies as AnalysisParams,
      mode,
      callbacks,
    );
    // NOTE: the INPUT direction never delivers a replacement: the analyzed text is the CUSTOMER's, so
    // there is no reply to repair. Asked to compose one, models answer in the customer's own voice,
    // send unfilled template slots, or produce text the customer's message dictated (a prompt
    // injection on the business's channel), depending on which model the operator picked. A writer
    // constrained by wording only yields a fixed sentence, which the operator's template already is.
    return params.direction === "input" ? withoutReplacement(verdict) : verdict;
  }
  if (policies === null) {
    return withoutReplacement(
      await runAnalysis(model, relevance, mode, callbacks),
    );
  }
  // In parallel: the operator is paying for a turn a customer is waiting on.
  const [byPolicy, byRelevance] = await Promise.all([
    runAnalysis(model, policies, mode, callbacks),
    runAnalysis(model, relevance, mode, callbacks).then(withoutReplacement),
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

// A 400 means "this request, as written, is not one this model takes" — a permanent answer, unlike
// a rate limit or a timeout, which is why only this status earns a second call. Read off the error
// rather than predicted from the model id: every attempt in this repository to predict a vendor's
// parameter rules from the id has aged badly, and a wrong prediction here is a guardrail that stops
// screening rather than a wrong parameter.
function isRequestRefused(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 400
  );
}

// One call, in whichever shape this endpoint accepts. Returns the schema's answer when there was
// one, and ALWAYS the model's own text: a constrained answer that failed validation still leaves
// the text readable, and dropping it would turn a recoverable reply into "never screened".
//
// The provider list says which ENDPOINT implements constrained decoding; it cannot say that every
// model an operator may type into the guardrail's model field does. When the request comes back
// refused, the analysis is retried in prose, so the worst case is one extra call rather than a screen
// that quietly stops running.
async function invokeForVerdict(
  model: BaseChatModel,
  mode: VerdictMode,
  messages: BaseMessage[],
  signal: AbortSignal,
  callbacks?: BaseCallbackHandler[],
): Promise<{ parsed: Record<string, unknown> | null; raw: string }> {
  const asProse = async () => {
    const res = await model.invoke(messages, {
      signal,
      callbacks,
    });
    return { parsed: null, raw: messageText(res.content).trim() };
  };
  if (mode === "prose") return asProse();
  // Same verdict, in the dialect this endpoint speaks. See ./verdict and graph/model-config: asking
  // in the wrong one is not a soft failure, it is a refusal on every screen.
  const schema = mode === "openapi" ? VERDICT_SCHEMA_OPENAPI : VERDICT_SCHEMA;
  try {
    const res = (await model
      .withStructuredOutput(schema, {
        name: schema.title,
        // NOTE: `strict` is what turns the schema from a request into a constraint on OpenAI; the
        // other adapter on the list ignores the flag (Anthropic forces the tool call), and both
        // were checked to accept the option rather than throw.
        strict: true,
        // NOTE: keeps the model's own text reachable when the schema produced nothing, which is what
        // lets `readVerdict` recover a verdict an adapter's parser could not build. See verdict.ts
        // for how far that reaches on each adapter.
        includeRaw: true,
      })
      .invoke(messages, {
        signal,
        callbacks,
      })) as {
      raw: BaseMessage;
      parsed: Record<string, unknown> | null;
    };
    return {
      parsed: res.parsed ?? null,
      raw: messageText(res.raw.content).trim(),
    };
  } catch (err) {
    if (!isRequestRefused(err)) throw err;
    logger.warn(
      { err },
      "guardrails: model refused the constrained verdict, retrying in prose",
    );
    return asProse();
  }
}

async function runAnalysis(
  model: BaseChatModel,
  params: AnalysisParams,
  mode: VerdictMode,
  callbacks?: BaseCallbackHandler[],
): Promise<GuardrailVerdict> {
  const system = buildGuardrailSystemPrompt(params);
  // The customer's message rides at USER level, fenced and named, never inside the system prompt:
  // there it would read as one more instruction from the operator, and the customer writes it. The
  // text under review keeps its bare shape, so a call with the check off is unchanged by the fence.
  const customer = fenceCustomerMessage(params);
  const messages: BaseMessage[] = [new SystemMessage(system)];
  if (customer !== null) messages.push(new HumanMessage(customer));
  messages.push(new HumanMessage(params.text));
  try {
    // ONE deadline for the verdict, the refused-then-prose retry included: the signal alone is
    // dropped by the Google adapter, and a classifier on the customer's path must not hang.
    const { parsed, raw } = await runModelCall(
      (signal) => invokeForVerdict(model, mode, messages, signal, callbacks),
      { deadlineMs: ANALYZE_TIMEOUT_MS },
    );
    return readVerdict(parsed, raw);
  } catch (err) {
    logger.warn(
      { err },
      "guardrails analysis failed (fail-open, message not blocked)",
    );
    return unanalyzed(err instanceof Error ? err.message : String(err));
  }
}
