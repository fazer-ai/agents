import logger from "@/api/lib/logger";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import {
  type HandoffConfig,
  pinnedHandoffTarget,
} from "@/modules/handoff/settings";

// THE TRANSFER A GUARDRAIL MAKES (issue #704). The `handoff` action takes a reply the judge refused
// and gives the case to a person instead of a canned refusal, which matters most where the refused
// reply was the only one the customer gets that day (an e-mail inbox).
//
// The same two moves `handoff_to_human` makes, in the same order: the status first, because
// `open` is what takes the conversation off the bot and onto the human queue, and the assignment
// after it, best-effort, because a routing miss does not put the conversation back. The target is
// the agent's own handoff setting, never a second one that could disagree with it: a pinned agent
// or team is assigned, and every other mode leaves it to Chatwoot's routing (there is no model here
// to pick a name).
//
// Returns whether the conversation left `pending`. The caller decides what that means for the text
// it was about to send; this never throws.
export async function applyGuardrailHandoff(params: {
  client: Pick<
    ChatwootClient,
    "toggleStatus" | "assignToAgent" | "assignTeam" | "sendPrivateNote"
  >;
  conversationId: number;
  instanceId: bigint;
  handoff: HandoffConfig;
  direction: "input" | "output";
  flow: FlowContext;
  // The caller's withdrawal fence, asked between the status and the assignment: a `/reset` or an
  // agent switched off while the status change is in flight must not be followed by a routing
  // write. The status already landed and stays; what this stops is the second write.
  stillWanted?: () => Promise<boolean>;
}): Promise<boolean> {
  const { client, conversationId, direction, flow } = params;
  try {
    await client.toggleStatus(conversationId, "open");
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conversationId) },
      "guardrail handoff: could not open the conversation",
    );
    emitFlowEvent(flow, {
      stage: "handoff",
      status: "error",
      level: "warn",
      detail: { outcome: "guardrail_handoff_failed", direction },
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    // The screening's note already said the case was asked to go to the team; this is the half the
    // person reading it needs next. Best-effort like the note it corrects.
    await client
      .sendPrivateNote(
        conversationId,
        "Guardrail: não consegui passar a conversa para a equipe. Ela continua com o agente, e nada foi enviado ao cliente.",
      )
      .catch(() => {});
    return false;
  }
  const target = pinnedHandoffTarget(params.handoff, params.instanceId);
  let assigned: "agent" | "team" | "routing" | "failed" | "withdrawn" =
    "routing";
  if (target && params.stillWanted && !(await params.stillWanted())) {
    assigned = "withdrawn";
  } else if (target) {
    try {
      if (target.kind === "agent")
        await client.assignToAgent(conversationId, target.id);
      else await client.assignTeam(conversationId, target.id);
      assigned = target.kind;
    } catch (err) {
      assigned = "failed";
      logger.warn(
        { err, conversationId: String(conversationId) },
        "guardrail handoff: opened, but the pinned target could not be assigned",
      );
    }
  }
  emitFlowEvent(flow, {
    stage: "handoff",
    status: "ok",
    detail: { outcome: "guardrail_handoff", direction, assigned },
  });
  return true;
}
