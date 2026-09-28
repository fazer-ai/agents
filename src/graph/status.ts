import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import {
  type AgentActivityStage,
  broadcastAgentActivity,
} from "@/api/features/realtime/realtime.service";
import { SKIP_REPLY_TOOL } from "@/graph/silence";

// Surfaces coarse, real-time agent progress ("thinking", "tool" + name) to the operator as a
// transient typing indicator on the per-tenant realtime channel. Metadata only, never message
// content. No-op without a mirror row id (nothing for the UI to key on). Broadcasts never throw, as
// a callback handler must not, and are fire-and-forget, unlike UsageCapture.

export interface StatusTarget {
  tenantId: bigint;
  conversationDbId: bigint | null;
  // Whether the TURN has already put something in front of the customer. Rides only on the
  // `skip_reply` step, the indicator that asserts a silence, which the operator reads right after a
  // transfer lands. Absent means unanswered: the UI keeps its default label rather than guess.
  turnDelivered?: () => boolean;
}

export class AgentStatusReporter extends BaseCallbackHandler {
  name = "fazerai-agent-status";

  private readonly tenantId: bigint;
  private readonly conversationDbId: bigint | null;
  private readonly turnDelivered?: () => boolean;

  constructor(target: StatusTarget) {
    super();
    this.tenantId = target.tenantId;
    this.conversationDbId = target.conversationDbId;
    this.turnDelivered = target.turnDelivered;
  }

  private emit(
    phase: "started" | "step" | "finished",
    stage: AgentActivityStage | null,
    tool: string | null = null,
    extra?: { balloons?: number | null; delivered?: boolean },
  ): void {
    if (this.conversationDbId == null) return;
    broadcastAgentActivity(this.tenantId, {
      conversationId: this.conversationDbId.toString(),
      phase,
      stage,
      tool,
      balloons: extra?.balloons ?? null,
      // NOTE: omitted rather than null: a client that sees the key reads it as an answer, and
      // `false` everywhere would have every step asserting nothing was delivered.
      ...(extra && "delivered" in extra ? { delivered: extra.delivered } : {}),
    });
  }

  // Envelope, emitted by the runtime AROUND the invoke (not callbacks): the
  // operator gets instant feedback before the first token, and a guaranteed
  // clear when the turn ends (posted, empty, taken-over, or thrown). `balloons`
  // (split reply count) lets the UI hold a "delivering" indicator until the
  // paced balloons land over the webhook→mirror roundtrip (which lags finish).
  started(): void {
    this.emit("started", "thinking");
  }

  finished(balloons?: number | null): void {
    this.emit("finished", null, null, { balloons });
  }

  // The model began generating — the initial decision, or a continuation after a
  // tool returned → back to "thinking".
  override handleChatModelStart(): void {
    this.emit("step", "thinking");
  }

  // Fallback for non-chat LLMs (chat models fire handleChatModelStart instead).
  override handleLLMStart(): void {
    this.emit("step", "thinking");
  }

  // A tool started executing → "tool" with its name. For tool runs LangChain
  // sets `runName` to the tool's registered name (the serialized `tool` is
  // usually a not-implemented stub, so its id is the class — not useful); fall
  // back to a generic indicator when it is absent.
  override handleToolStart(
    _tool: Serialized,
    _input: string,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    const tool = runName && runName.length > 0 ? runName : null;
    const ask = tool === SKIP_REPLY_TOOL ? this.turnDelivered : undefined;
    this.emit("step", "tool", tool, ask ? { delivered: ask() } : undefined);
  }
}
