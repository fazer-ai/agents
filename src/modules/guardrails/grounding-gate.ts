import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import type { LLMResult } from "@langchain/core/outputs";
import type { RevisionInfo, RevisionPlan } from "@/graph/graph";
import { contentToText } from "@/graph/message-text";
import { type ModelConfig, verdictAskMode } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";
import {
  buildLangfuseHandler,
  type LangfuseConfig,
} from "@/graph/observability";
import {
  extractTokenUsage,
  UsageCapture,
  type UsagePersist,
  usageAttribution,
} from "@/graph/usage";
import { scrubbedClip } from "@/lib/redact";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import type {
  GuardrailAnnounce,
  GuardrailDecision,
  GuardrailReport,
} from "./gate";
import {
  earlierSourceCalls,
  FACTUAL_GROUNDING_KEY,
  GROUNDING_REFERENCE_MAX,
  GROUNDING_SOURCE_WINDOW,
  GROUNDING_SOURCES_MAX,
  type GroundingClaim,
  groundingConversation,
  groundingMemory,
  groundingNow,
  groundingSourced,
  groundingToolCalls,
  reviewGrounding,
  reviseNote,
} from "./grounding";
import {
  type GroundingReference,
  NO_GROUNDING_REFERENCE,
} from "./grounding-reference";
import {
  type GroundingReviewerModel,
  type GuardrailsConfig,
  groundingHasSources,
} from "./settings";

// The factual-grounding check as the reactive turn and the playground run it. `review` is the graph's
// `reviewReply` hook: it decides whether the turn is reviewed at all, runs the reviewer, writes the
// flow line and the announcement, and answers with the revise note when the action is `revise`.
// `template` and `handoff` cannot act from inside the graph, so the decision waits in `pending` for
// the caller's output gate, which applies it like any output trip.

export interface GroundingGateParams {
  cfg: GuardrailsConfig;
  // The reviewer as `resolveGroundingReviewer` resolved it, key included, or why it cannot run; null
  // when the loader did not resolve one (the check was off when the config was read).
  reviewer: GroundingReviewerModel | null;
  // The documents of the reference bases, as the loader read them for this turn; null when none is
  // configured.
  reference?: GroundingReference | null;
  flow: FlowContext;
  // `observability.logToolValues`: claims and evidence are model text quoting the reply and the tool
  // results, so they reach the flow line only with it on; otherwise only their count does.
  logValues?: boolean;
  announce?: GuardrailAnnounce;
  // The instant the turn's prompt was rendered and the agent's timezone, the same clock the agent's
  // own date variables read, so the reviewer computes "today" and "tomorrow" as the agent did.
  clock: { now: Date; timezone: string };
  makeModel?: typeof createChatModel;
  // The turn's own end (a scheduler job's deadline). A turn that already ended is not reviewed, and
  // one that ends during the review stops waiting for a permit and for the reviewer.
  signal?: AbortSignal;
  persistUsage?: UsagePersist;
  langfuseCfg: LangfuseConfig | null;
}

export interface GroundingGate {
  // `reply` is the text that would go out: the final answer, or the one the runtime recovers.
  review: (turn: BaseMessage[], reply?: string) => Promise<string | null>;
  pending: () => GuardrailDecision | null;
  // The graph's `revisionPlan`: with `revise` and `reviseWithTools` on, the rewrite may consult the
  // sources, and its answer gets one more review; still flagged, the Output template goes out.
  revisionPlan: () => RevisionPlan | null;
  // The graph's `onReplyRevised`: an empty rewrite leaves the Output template as the decision, so
  // the refused draft is never what the customer reads.
  revised: (text: string) => void;
}

// Per claim and per evidence on the flow line, as the observed rationale is bounded.
const LOGGED_TEXT_MAX = 500;
const LOGGED_CLAIMS_MAX = 20;

// The reviewer's tokens, for the review's own line: the ledger row carries them too, but a reader of
// the log should not have to join two tables to price one review.
class ReviewTokens extends BaseCallbackHandler {
  name = "fazerai-grounding-tokens";
  override awaitHandlers = true;
  input = 0;
  cached = 0;
  output = 0;
  override async handleLLMEnd(output: LLMResult): Promise<void> {
    const u = extractTokenUsage(output);
    this.input += u.promptTokens;
    this.cached += u.cachedReadTokens;
    this.output += u.completionTokens;
  }
}

const claimsText = (claims: readonly GroundingClaim[]) =>
  claims.map((c) => `${c.claim} (fontes: ${c.evidence || "nada"})`).join("; ");

// Null when the check is off: the caller then passes no hook, and nothing about the turn changes.
export function buildGroundingGate(
  p: GroundingGateParams,
): GroundingGate | null {
  const gr = p.cfg;
  const fg = gr.factualGrounding;
  if (!gr.enabled || !fg.enabled || !groundingHasSources(fg)) return null;
  const reference = p.reference ?? NO_GROUNDING_REFERENCE;
  const reviewer: GroundingReviewerModel = p.reviewer ?? {
    runnable: false,
    reason: "not_resolved",
    provider: "",
    model: "",
  };
  let decision: GuardrailDecision | null = null;
  let model: BaseChatModel | null | undefined;
  let buildError: string | undefined;
  const resolveModel = (): BaseChatModel | null => {
    if (model !== undefined) return model;
    if (!reviewer.runnable) {
      model = null;
      buildError = reviewer.reason;
      return model;
    }
    try {
      model = (p.makeModel ?? createChatModel)({
        provider: reviewer.provider,
        model: reviewer.model,
        baseURL: reviewer.baseURL ?? undefined,
        apiKey: reviewer.apiKey,
        temperature: 0,
      });
    } catch (e) {
      model = null;
      buildError = e instanceof Error ? e.message : String(e);
    }
    return model;
  };
  const callbacks = (tokens: ReviewTokens) => {
    const usage = new UsageCapture({
      ...usageAttribution(p.flow),
      provider: reviewer.provider,
      model: reviewer.model,
      node: "guardrail_grounding",
      persist: p.persistUsage,
    });
    const trace = buildLangfuseHandler(p.langfuseCfg, {
      tenantId: p.flow.tenantId,
      threadId: p.flow.threadId ?? "",
      conversationId: p.flow.conversationId,
      agentId: p.flow.agentId,
      userId: p.langfuseCfg?.tenantSlug,
      turnId: p.flow.turnId,
      source: p.flow.source,
      updateRoot: false,
    });
    return trace ? [usage, tokens, trace] : [usage, tokens];
  };
  const base = { direction: "output" as const, check: FACTUAL_GROUNDING_KEY };
  // `hold` acts only on a check that acts: an observed one never stops a reply.
  const holds = gr.onFailure === "hold" && fg.action !== "observe";

  const couldNotReview = async (
    outcome:
      | "credential_not_found"
      | "model_unavailable"
      | "analysis_failed"
      | "sources_too_large"
      | "reference_too_large",
    detail: Record<string, unknown>,
    errorMessage?: string,
  ): Promise<null> => {
    emitFlowEvent(p.flow, {
      stage: "guardrail",
      status: "error",
      level: "warn",
      detail: {
        ...base,
        outcome,
        ...detail,
        unchecked: !holds,
        ...(holds ? { held: true } : {}),
      },
      errorMessage,
    });
    const cause =
      outcome === "sources_too_large" || outcome === "reference_too_large"
        ? "analysis_failed"
        : outcome;
    if (holds) {
      decision = {
        kind: "handed-off",
        reply: gr.output.handoffMessage || null,
      };
      await p.announce?.({
        ...base,
        outcome: "handed-off",
        held: true,
        cause,
      });
    } else {
      await p.announce?.({ ...base, outcome: "unavailable", cause });
    }
    return null;
  };

  // Runs the reviewer on the reply that would go out, or writes why it could not. `pass` marks the
  // second review of a rewrite on its failure line.
  const judge = async (
    turn: BaseMessage[],
    candidate: string | undefined,
    pass?: "revision",
  ): Promise<{
    verdict: Awaited<ReturnType<typeof reviewGrounding>>;
    timed: Record<string, unknown>;
    reply: string;
  } | null> => {
    if (p.signal?.aborted) return null;
    // The whole thread the agent reads, earlier attendances included.
    const history = turn.slice(0, -1);
    // Earlier first, so the block reads in the order the calls were made. 0 reads only the turn.
    const earlier = earlierSourceCalls(
      history,
      fg.sourceTools,
      fg.contextMessages > 0
        ? Math.max(fg.contextMessages, GROUNDING_SOURCE_WINDOW)
        : 0,
    );
    const calls = [...earlier, ...groundingToolCalls(turn, fg.sourceTools)];
    // Reviewed with or without a source: a reply that states an in-scope fact having consulted
    // nothing is the case that costs most when it goes out unchecked. With none, the reviewer is told
    // so and judges every in-scope fact as unsupported.
    const sources = calls.filter((c) => c.source);
    const last = turn[turn.length - 1];
    const reply =
      candidate?.trim() || (last ? contentToText(last.content).trim() : "");
    if (!reply) return null;
    const sourceNames = [...new Set(sources.map((c) => c.name))];
    const resultChars = calls.reduce((n, c) => n + c.result.length, 0);
    const sized = {
      sourced: groundingSourced(calls, reference.docs),
      sources: sourceNames,
      resultChars,
      earlierSources: earlier.length,
      referenceDocs: reference.count,
      referenceChars: reference.chars,
      ...(pass ? { pass } : {}),
    };
    if (reference.chars > GROUNDING_REFERENCE_MAX)
      return couldNotReview("reference_too_large", sized);
    if (resultChars > GROUNDING_SOURCES_MAX)
      return couldNotReview("sources_too_large", sized);
    const m = resolveModel();
    if (!m)
      return couldNotReview(
        !reviewer.runnable && reviewer.reason === "credential_not_found"
          ? "credential_not_found"
          : "model_unavailable",
        sized,
        buildError,
      );
    const conversation = groundingConversation(history, fg.contextMessages);
    const memory = fg.contextMessages > 0 ? groundingMemory(history) : null;
    const started = Date.now();
    const tokens = new ReviewTokens();
    const verdict = await reviewGrounding(
      m,
      {
        now: groundingNow(p.clock.now, p.clock.timezone),
        timezone: p.clock.timezone,
        memory,
        conversation,
        calls,
        reply,
        reference: reference.docs,
      },
      verdictAskMode(reviewer.provider as ModelConfig["provider"]),
      callbacks(tokens),
      p.signal,
    );
    // Ended during the review: nothing of this turn goes out, so nothing is decided or logged.
    if (p.signal?.aborted) return null;
    const timed = {
      ...sized,
      latencyMs: Date.now() - started,
      inputTokens: tokens.input,
      cachedInputTokens: tokens.cached,
      outputTokens: tokens.output,
    };
    if (verdict.error) {
      await couldNotReview("analysis_failed", timed, verdict.error);
      return null;
    }
    return { verdict, timed, reply };
  };

  const review = async (
    turn: BaseMessage[],
    candidate?: string,
  ): Promise<string | null> => {
    const judged = await judge(turn, candidate);
    if (!judged) return null;
    const { verdict, timed, reply } = judged;
    if (!verdict.violated) {
      // One line per review, clean ones too, so the rate and the cost of the check are readable from
      // the log in any mode. `info` and no `action`: a clean review is not a trip, the same contract as
      // the external check's `allow` line.
      emitFlowEvent(p.flow, {
        stage: "guardrail",
        status: "ok",
        level: "info",
        detail: { ...base, verdict: "clean", claimCount: 0, ...timed },
      });
      await p.announce?.({ ...base, outcome: "clean" });
      return null;
    }
    const claims = verdict.claims;
    const rationale = claimsText(claims) || verdict.rationale;
    emitFlowEvent(p.flow, {
      stage: "guardrail",
      status: "ok",
      level: "warn",
      detail: {
        ...base,
        verdict: "violated",
        action: fg.action,
        categories: [FACTUAL_GROUNDING_KEY],
        ...timed,
        claimCount: claims.length,
        ...loggedClaims(claims),
      },
    });
    const report: GuardrailReport = {
      ...base,
      outcome: "observed",
      categories: [FACTUAL_GROUNDING_KEY],
      rationale,
      claims,
    };
    if (fg.action === "observe") {
      await p.announce?.({ ...report, action: "observe" });
      return null;
    }
    if (fg.action === "revise") {
      await p.announce?.({ ...report, outcome: "revised", action: "revise" });
      return reviseNote(reply, claims);
    }
    if (fg.action === "handoff") {
      decision = {
        kind: "handed-off",
        reply: gr.output.handoffMessage || null,
      };
      await p.announce?.({
        ...report,
        outcome: "handed-off",
        action: "handoff",
        refused: reply,
      });
      return null;
    }
    decision = { kind: "replaced", reply: gr.output.templateMessage };
    await p.announce?.({ ...report, outcome: "replaced", action: "template" });
    return null;
  };

  const loggedClaims = (claims: readonly GroundingClaim[]) =>
    p.logValues
      ? {
          claims: claims.slice(0, LOGGED_CLAIMS_MAX).map((c) => ({
            claim: scrubbedClip(c.claim, LOGGED_TEXT_MAX),
            type: c.type,
            evidence: scrubbedClip(c.evidence, LOGGED_TEXT_MAX),
          })),
        }
      : {};

  // The second review, once, on what the rewrite wrote with its calls in the turn. Its line is the
  // rewrite's record: the calls it made and refused, its own tokens, and this verdict. No categories:
  // the first review already counted the trip.
  const reviewRevision = async (
    turn: BaseMessage[],
    reply: string,
    info: RevisionInfo,
  ): Promise<void> => {
    if (p.signal?.aborted) return;
    const rewrite = {
      ...base,
      toolCalls: info.toolCalls,
      tools: info.tools,
      refused: info.refused,
      revisionInputTokens: info.inputTokens,
      revisionOutputTokens: info.outputTokens,
    };
    if (!reply.trim()) {
      emitFlowEvent(p.flow, {
        stage: "guardrail",
        status: "ok",
        level: "warn",
        detail: {
          ...rewrite,
          outcome: "revision",
          verdict: "empty",
          claimCount: 0,
        },
      });
      return;
    }
    const judged = await judge(turn, reply, "revision");
    if (!judged) return;
    const { verdict, timed } = judged;
    const claims = verdict.violated ? verdict.claims : [];
    emitFlowEvent(p.flow, {
      stage: "guardrail",
      status: "ok",
      level: verdict.violated ? "warn" : "info",
      detail: {
        ...rewrite,
        ...timed,
        outcome: "revision",
        verdict: verdict.violated ? "violated" : "clean",
        claimCount: claims.length,
        ...(verdict.violated ? { action: "template" } : {}),
        ...loggedClaims(claims),
      },
    });
    if (!verdict.violated) return;
    decision = { kind: "replaced", reply: gr.output.templateMessage };
    await p.announce?.({
      ...base,
      outcome: "replaced",
      action: "template",
      categories: [FACTUAL_GROUNDING_KEY],
      rationale: claimsText(claims) || verdict.rationale,
      claims,
    });
  };

  const revisionPlan = (): RevisionPlan | null =>
    fg.action === "revise" && fg.reviseWithTools
      ? {
          sourceTools: fg.sourceTools,
          maxToolCalls: fg.reviseMaxToolCalls,
          review: reviewRevision,
        }
      : null;

  const revised = (text: string): void => {
    if (text.trim()) return;
    decision = { kind: "replaced", reply: gr.output.templateMessage };
    emitFlowEvent(p.flow, {
      stage: "guardrail",
      status: "ok",
      level: "warn",
      detail: { ...base, action: "template", outcome: "revision_empty" },
    });
  };

  return { review, pending: () => decision, revisionPlan, revised };
}
