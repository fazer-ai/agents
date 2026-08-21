import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { verdictAskMode } from "@/graph/model-config";
import { createChatModel } from "@/graph/models";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { analyzeGuardrail } from "./analyze";
import { loggableCategories } from "./log-categories";
import type { GuardrailsConfig } from "./settings";

// The moderation gate both runtimes call. It was a closure inside runLoadedTurn until the proactive
// path needed it too (issue #160): a follow-up is a message the customer never asked for, and it was
// the only customer-facing text in the product that nothing screened. Copying the closure would have
// made the two paths drift on the day one of them changed, which is why this is a unit and not a
// second copy.
//
// Returns null when nothing tripped, { reply: string } to send in place of the subject, or
// { reply: null } to suppress the send entirely (the "silent" action). Fail-open: an analysis that
// could not run answers null (see analyzeGuardrail) and is recorded, never blocks.
export type GuardrailGate = (
  direction: "input" | "output",
  subject: string,
) => Promise<{ reply: string | null } | null>;

export interface GuardrailGateParams {
  cfg: GuardrailsConfig;
  // The guardrails agent's OWN resolved credential (never the agent's).
  apiKey: string;
  credentialBaseUrl?: string | null;
  client: ChatwootClient;
  conversationId: number;
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
}

export function buildGuardrailGate(p: GuardrailGateParams): GuardrailGate {
  const gr = p.cfg;
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
  };

  return async (direction, subject) => {
    const dir = gr[direction];
    if (!gr.enabled || !p.apiKey || !dir.enabled) return null;
    const model = resolveModel(direction);
    if (!model) return null;
    const judgesRelevance = direction === "output" && !!p.customerMessage;
    const verdict = await analyzeGuardrail(
      model,
      {
        direction,
        text: subject,
        checks: judgesRelevance
          ? dir.checks
          : { ...dir.checks, answerRelevance: false },
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
    if (!verdict.violated) return null;
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
      // private note two lines below carries both in full, on the conversation the text came from.
      detail: {
        direction,
        action: effectiveAction,
        ...loggableCategories(verdict.categories),
      },
    });
    await p.client
      .sendPrivateNote(
        p.conversationId,
        `Guardrail (${direction}): ${verdict.categories.join(", ") || "policy"} — ${effectiveAction}. ${verdict.rationale}`,
      )
      .catch(() => {});
    if (dir.action === "silent") return { reply: null };
    return { reply: replacement ?? dir.templateMessage };
  };
}
