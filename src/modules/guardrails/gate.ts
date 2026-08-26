import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { verdictAskMode } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";
import {
  UsageCapture,
  type UsagePersist,
  usageAttribution,
} from "@/graph/usage";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { analyzeGuardrail } from "./analyze";
import { loggableCategories } from "./log-categories";
import { judgesAnything } from "./prompts";
import type { GuardrailAction, GuardrailsConfig } from "./settings";

// The moderation gate both runtimes call. It was a closure inside runLoadedTurn until the proactive
// path needed it too (issue #160): a follow-up is a message the customer never asked for, and it was
// the only customer-facing text in the product that nothing screened. Copying the closure would have
// made the two paths drift on the day one of them changed, which is why this is a unit and not a
// second copy.
//
// What one screening DID, as a single value. It used to be a nullable reply, and callers then grew
// side channels for the two questions that value cannot answer — a flag for "was anything written
// down", set through a callback. Three consecutive review rounds found a caller reading one of the
// three for another's question, so they became one union with the three answers in it.
export type GuardrailDecision =
  // Nothing was screened: guardrails off, this direction switched off, or nothing left to ask. No
  // model call, no delay, nothing written.
  | { kind: "not-run" }
  // Screened and approved. A model call happened; nothing was written down.
  | { kind: "clean" }
  // Could NOT be screened. Fail-open, so the subject still goes out — but a warn was written, and a
  // warn pages. `modelRan` separates the two ways in, because they cost different amounts of TIME:
  // an analysis that errored had already spent a round trip to the provider, while a credential
  // that never resolved and a model that would not build never left this process. A caller whose
  // earlier reads go stale while the judge thinks asks that question, not the kind.
  | { kind: "unavailable"; modelRan: boolean }
  // Tripped: send this instead of the subject. The operator note was written.
  | { kind: "replaced"; reply: string }
  // Tripped with the `silent` action: send nothing. The operator note was written.
  | { kind: "suppressed" };

// The text to send in place of `subject`, or null to send nothing.
export function screenedText(
  d: GuardrailDecision,
  subject: string,
): string | null {
  if (d.kind === "suppressed") return null;
  return d.kind === "replaced" ? d.reply : subject;
}

// The policy acted on this text: it replaced it or removed it. The caller's OWN artefacts of the
// same turn (a queued image and its caption) fall with it.
export function guardrailTripped(d: GuardrailDecision): boolean {
  return d.kind === "replaced" || d.kind === "suppressed";
}

// Something an operator reads was written: the private note a trip leaves, or the warn an
// unavailable screening emits. A caller that can still abandon the turn has to know, because
// abandoning it means running it again, and running it again writes this again.
export function guardrailLeftAMark(d: GuardrailDecision): boolean {
  return guardrailTripped(d) || d.kind === "unavailable";
}

// A model call was attempted, so whatever the caller read before this is now as old as that call.
// Two of the answers are reached without one: nothing was screened, and the screening could not be
// set up at all. Neither spends the seconds this exists to detect.
export function guardrailRan(d: GuardrailDecision): boolean {
  if (d.kind === "not-run") return false;
  if (d.kind === "unavailable") return d.modelRan;
  return true;
}

export type GuardrailGate = (
  direction: "input" | "output",
  subject: string,
) => Promise<GuardrailDecision>;

// What one screening DID, in the words an operator reads. Distinct from `GuardrailDecision`, which
// is what the CALLER must do next: the decision deliberately carries no `rationale`, because a
// caller that branched on it would be branching on model-written prose.
export interface GuardrailReport {
  direction: "input" | "output";
  outcome: Exclude<GuardrailDecision["kind"], "not-run">;
  // As CARRIED OUT, and only on a trip. See the note on `effectiveAction` below.
  action?: GuardrailAction;
  // Model-written, and only on a trip.
  categories?: string[];
  rationale?: string;
}

// Where a screening gets announced to a human. The gate decides WHEN (one place, below); this
// decides WHERE, because the two runtimes have different places: a conversation the operator can
// open, and a transcript in a surface that is not a conversation at all (issue #136). Errors are
// the sink's to swallow — an announcement that fails must not fail the turn it describes.
export type GuardrailAnnounce = (r: GuardrailReport) => void | Promise<void>;

// The inbox announcement, shared by the reactive and proactive paths so the two cannot drift. Only
// a trip is posted: a private note per clean screening would bury the conversation in notes about
// nothing having happened, and `unavailable` already pages through the warn the gate emits.
export function chatwootNoteSink(
  client: Pick<ChatwootClient, "sendPrivateNote">,
  conversationId: number,
): GuardrailAnnounce {
  return async (r) => {
    if (r.outcome !== "replaced" && r.outcome !== "suppressed") return;
    await client
      .sendPrivateNote(
        conversationId,
        `Guardrail (${r.direction}): ${r.categories?.join(", ") || "policy"} — ${r.action}. ${r.rationale ?? ""}`,
      )
      .catch(() => {});
  };
}

export interface GuardrailGateParams {
  cfg: GuardrailsConfig;
  // The guardrails agent's OWN resolved credential (never the agent's).
  apiKey: string;
  credentialBaseUrl?: string | null;
  // Absent means nothing is announced anywhere. The gate still emits its flow lines.
  announce?: GuardrailAnnounce;
  flow: FlowContext;
  // The agent's resolved system prompt, for the promptAdherence check on the output direction.
  systemPrompt?: string;
  // The customer's own message, for the answer_relevance check on the output direction. ABSENT on
  // proactive turns, and that absence is load-bearing rather than incidental: a follow-up answers
  // no question, so the check has nothing to judge. `splitAnalyses` already skips the relevance CALL
  // with no message, but the policy would still be listed in the other call's prompt, where a model
  // asked to score relevance against silence has only wrong answers available. So the gate drops the
  // check itself, structurally, the same way the input direction drops the replacement.
  customerMessage?: string;
  makeModel?: typeof createChatModel;
  // Overrides the ledger sink. Tests inject; production takes the default, which writes the row.
  persistUsage?: UsagePersist;
}

export function buildGuardrailGate(p: GuardrailGateParams): GuardrailGate {
  const gr = p.cfg;
  // The analysis runs on the guardrails agent's OWN model, so the row has to name THAT model and
  // not the agent's: a shared name would attribute this spend to the customer turn beside it. The
  // rest of the attribution comes from the flow context, which is the only thing this gate holds
  // that knows which conversation it is screening.
  const usage = () =>
    new UsageCapture({
      ...usageAttribution(p.flow),
      model: gr.model,
      node: "guardrail",
      persist: p.persistUsage,
    });
  // Built on FIRST CALL, not here, and never twice: a gate is constructed for every turn and every
  // follow-up, while a direction that is switched off never reaches the model. `createChatModel`
  // throws synchronously on a configuration it cannot satisfy (an `openai-compatible` provider with
  // no base URL reaches it as one), so building eagerly made that configuration fail turns whose
  // moderation was off — and on the proactive path the throw landed in the caller's catch, which
  // reports the follow-up as delivered. `undefined` is "not attempted yet"; `null` is "attempted
  // and unavailable", which is the same fail-open answer an analysis that could not run gives.
  let model: BaseChatModel | null | undefined;
  const resolveModel = (
    direction: "input" | "output",
  ): BaseChatModel | null => {
    if (model !== undefined) return model;
    // A key that never resolved is a gate configured to run that cannot, which is the same answer
    // as a model that refuses to build and belongs on the same side of the fence. It used to sit up
    // in the early guard next to "the operator switched this off", so one condition answered two
    // questions and the operator's own reading of a deleted vault entry was "no guardrail ran" —
    // the one case of the three the issue names that stayed invisible.
    if (!p.apiKey) {
      model = null;
      emitFlowEvent(p.flow, {
        stage: "guardrail",
        status: "error",
        level: "warn",
        // `credential_not_found` is the fleet's name for this, used by the speech normalizer,
        // vision, STT, TTS and memory compaction. A seventh spelling of one condition is a filter
        // that quietly misses a sixth of the fleet.
        detail: { direction, outcome: "credential_not_found" },
      });
      return model;
    }
    try {
      model = (p.makeModel ?? createChatModel)({
        provider: gr.provider,
        model: gr.model,
        baseURL: p.credentialBaseUrl ?? gr.baseURL ?? undefined,
        apiKey: p.apiKey,
        temperature: 0,
      });
    } catch (e) {
      model = null;
      emitFlowEvent(p.flow, {
        stage: "guardrail",
        status: "error",
        level: "warn",
        detail: { direction, outcome: "model_unavailable" },
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
    return model;
    // NOTE: The warn above is what makes this "unavailable" and not "not-run" to the caller: a
    // configuration this gate cannot use is indistinguishable from a working one until it is tried,
    // and by then the operator has been told.
  };

  // The screening itself. It returns the report alongside the decision so the ANNOUNCEMENT has a
  // single call site (below), instead of one per outcome: an outcome added later would otherwise
  // reach the operator on whichever paths someone remembered.
  const screen = async (
    direction: "input" | "output",
    subject: string,
  ): Promise<{ d: GuardrailDecision; r: GuardrailReport | null }> => {
    const dir = gr[direction];
    // Only what the operator SWITCHED OFF reads as not-run. Whether the gate can actually run is a
    // different question, answered by `resolveModel`.
    if (!gr.enabled || !dir.enabled) return { d: { kind: "not-run" }, r: null };
    const judgesRelevance = direction === "output" && !!p.customerMessage;
    const checks = judgesRelevance
      ? dir.checks
      : { ...dir.checks, answerRelevance: false };
    // Nothing left to ask about, so nothing is asked: the line above can empty the list on its own
    // (an agent whose only output check is `answer_relevance`, screening a proactive message that
    // answers no question), and so can a direction that never carries the check the operator
    // enabled. An empty prompt is not a cheap screening — the model answers it anyway, and a
    // `violated: true` with no policy behind it would replace or suppress a message that broke no
    // rule, having cost a model call and, on the proactive path, an ownership probe to do it.
    if (!judgesAnything({ direction, checks, customPolicy: gr.customPolicy })) {
      return { d: { kind: "not-run" }, r: null };
    }
    const model = resolveModel(direction);
    if (!model)
      return {
        d: { kind: "unavailable", modelRan: false },
        r: { direction, outcome: "unavailable" },
      };
    const verdict = await analyzeGuardrail(
      model,
      {
        direction,
        text: subject,
        checks,
        competitors: gr.competitors,
        customPolicy: gr.customPolicy,
        systemPrompt: direction === "output" ? p.systemPrompt : undefined,
        // Passed as-is: `customerMessageForReview` refuses to let it travel unless the direction is
        // output AND the relevance check is on, and the line above is what decides the second half.
        // Repeating the condition here was tested by removing it, and nothing failed — one decision
        // written twice, two lines apart, where only one of the two can ever be reached first.
        customerMessage: p.customerMessage,
        generationPrompt:
          dir.action === "generated" ? dir.generationPrompt : undefined,
      },
      // Constrained where the endpoint implements it, in the dialect it speaks, and asked for in
      // the prompt everywhere else. The provider decides, not the model id: the same adapter serves
      // OpenAI itself and whatever an operator points `openai-compatible` at (issue #131). Reaching
      // it through the gate is what puts the proactive path on the same footing as the reactive one.
      verdictAskMode(gr.provider),
      [usage()],
    );
    // A guardrail that could not run reads exactly like one that ran and approved, so without this
    // line an expired credential is silent moderation for as long as nobody notices. The turn is
    // NOT blocked (fail-open stays), only recorded.
    if (verdict.error) {
      emitFlowEvent(p.flow, {
        stage: "guardrail",
        status: "error",
        level: "warn",
        detail: { direction, outcome: "analysis_failed" },
        errorMessage: verdict.error,
      });
    }
    if (!verdict.violated) {
      // The call went out and came back, however it came back, so both answers here are downstream
      // of a round trip the caller's earlier reads did not survive.
      const d: GuardrailDecision = verdict.error
        ? { kind: "unavailable", modelRan: true }
        : { kind: "clean" };
      return { d, r: { direction, outcome: d.kind } };
    }
    // NOTE: The turn trail and the operator note report what the guardrail DID, not what it was
    // configured to do. `generated` with no replacement in hand sends the template — when the model
    // returns none, and on the input direction every time (see ./analyze.ts) — and an operator
    // reading "generated" on a line where the template went out is reading the config back, not the
    // event.
    const replacement =
      dir.action === "generated" ? verdict.suggestedReply : null;
    const effectiveAction =
      dir.action === "generated" && replacement === null
        ? "template"
        : dir.action;
    emitFlowEvent(p.flow, {
      stage: "guardrail",
      status: "ok",
      level: "warn",
      // NOTE: `categories` and `rationale` are both model-written, so neither can be copied into
      // this row as it stands: `rationale` explains what in the message violated the policy, so it
      // quotes the message, and `categories` is asked for as policy keys but arrives as whatever
      // the model wrote. What goes in is the part with a known vocabulary, plus a COUNT of what did
      // not match it, which is how "it violated something we cannot name here" stays visible. The
      // announcement below carries both in full, wherever the caller puts it.
      detail: {
        direction,
        action: effectiveAction,
        ...loggableCategories(verdict.categories),
      },
    });
    const r: GuardrailReport = {
      direction,
      outcome: dir.action === "silent" ? "suppressed" : "replaced",
      action: effectiveAction,
      categories: verdict.categories,
      rationale: verdict.rationale,
    };
    if (dir.action === "silent") return { d: { kind: "suppressed" }, r };
    return {
      d: { kind: "replaced", reply: replacement ?? dir.templateMessage },
      r,
    };
  };

  return async (direction, subject) => {
    const { d, r } = await screen(direction, subject);
    // The one announcement point. `not-run` is the only outcome with no report, and it is the only
    // one where nothing happened for anyone to read.
    if (r) await p.announce?.(r);
    return d;
  };
}
