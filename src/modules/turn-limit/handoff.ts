import logger from "@/api/lib/logger";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { assignPinnedTarget } from "@/modules/handoff/assign-pinned";
import type { HandoffConfig } from "@/modules/handoff/settings";

export class TurnLimitHandoffFailedError extends Error {
  constructor() {
    super("turn-limit hand-over did not reach Chatwoot");
    this.name = "TurnLimitHandoffFailedError";
  }
}

// The hand-over a tripped turn limit makes: the same two moves as `handoff_to_human` and the
// guardrail's transfer, status `open` first (it takes the conversation off the bot) and then the
// agent's own pinned target, best-effort. No new paused state: once the conversation is open, the
// ownership gate keeps the agent out until a person gives it back. Never throws.
export async function applyTurnLimitHandoff(params: {
  client: Pick<ChatwootClient, "toggleStatus" | "assignToAgent" | "assignTeam">;
  conversationId: number;
  instanceId: bigint;
  handoff: HandoffConfig;
  flow: FlowContext;
  stillWanted?: () => Promise<boolean>;
}): Promise<boolean> {
  const { client, conversationId, flow } = params;
  try {
    await client.toggleStatus(conversationId, "open");
  } catch (err) {
    logger.warn(
      { err, conversationId: String(conversationId) },
      "turn limit: could not open the conversation",
    );
    emitFlowEvent(flow, {
      stage: "handoff",
      status: "error",
      level: "warn",
      detail: { outcome: "turn_limit_handoff_failed" },
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  const assigned = await assignPinnedTarget({
    client,
    conversationId,
    instanceId: params.instanceId,
    handoff: params.handoff,
    stillWanted: params.stillWanted,
    logLabel: "turn limit handoff",
  });
  emitFlowEvent(flow, {
    stage: "handoff",
    status: "ok",
    detail: { outcome: "turn_limit_handoff", assigned },
  });
  return true;
}
