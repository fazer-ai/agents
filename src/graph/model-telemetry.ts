import type { GraphBuildDeps } from "@/graph/prepare";
import { emitCapacityWait } from "@/modules/flowlog/capacity";
import {
  emitFallbackAnswered,
  emitFallbackFailed,
} from "@/modules/flowlog/fallback-lines";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";

// What a production turn puts on its trail about the model itself: a forced answer, a wait for a
// model permit, a retried empty response, the fallback taking (or failing) the turn, calls a killed
// turn left unanswered taken out of the thread, and history trimmed to the ceiling. One set for every
// channel customers reach (the inbox turn and the client channel), so an outage of the primary pages
// the same way whichever door the traffic came in by.
export function modelTelemetry(
  flow: FlowContext,
  primaryProvider: string,
): Pick<
  GraphBuildDeps,
  | "onToolLimit"
  | "onModelPermitWait"
  | "onModelRetry"
  | "onModelFallback"
  | "onModelFallbackFailed"
  | "onModelFallbackUnavailable"
  | "onDanglingToolCalls"
  | "onHistoryTrim"
> {
  return {
    // Hard tool-call limit reached: a warn so the operator sees the agent was forced to answer.
    onToolLimit: ({ maxToolCalls, toolCalls }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: maxToolCalls, toolCalls },
      }),
    // A wait past the capacity threshold for a model permit: the instance, not the model, is
    // what the customer is waiting on.
    onModelPermitWait: (wait) =>
      emitCapacityWait(flow, "model_semaphore", wait),
    // A turn recovered from an empty provider response must not read like a clean one in the
    // Logs, or the fault's rate is invisible.
    onModelRetry: ({ attempt, provider, model }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "ok",
        // The retry can happen on either model; the labels ride on the event, so there is no
        // default here to get wrong.
        provider,
        model,
        // Written before the retry runs, so it is `info` with `willRetry`: a retry that also
        // comes back empty fails the turn, and that failure is the line that alerts.
        detail: { retriedEmptyResponse: attempt, willRetry: true },
      }),
    // A fallback that answers is a successful turn, so this warn is the operator's one signal
    // that the primary provider is not taking their traffic.
    onModelFallback: (info) =>
      emitFallbackAnswered(flow, "generate", primaryProvider, info),
    // The fallback failed too. Attribution, not a second alarm: the wrapping `generate` stage
    // already emits the error (labelled with the primary), and alert coalescing keys on (channel,
    // stage, level), so a second error would page twice. `info` names which model died; `status`
    // stays "error".
    onModelFallbackFailed: (info) => emitFallbackFailed(flow, "generate", info),
    // A configured fallback that cannot be built, reported once per turn build rather than on
    // a failure, when it would be too late to warn.
    onModelFallbackUnavailable: ({ provider, model, reason }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        provider,
        model,
        detail: { fallbackUnavailable: reason },
      }),
    // Info, not warn: the turn that left the calls unanswered already failed where it was
    // killed, and this one answers. The line is what ties a "No tool output found" in the provider's
    // logs to the turn that cleared it.
    onDanglingToolCalls: ({ calls }) =>
      emitFlowEvent(flow, {
        stage: "memory",
        level: "info",
        status: "ok",
        detail: { reason: "repaired_dangling_tool_call", calls },
      }),
    // Info, not warn: a working history ceiling trims on nearly every turn of a long thread and
    // warn pages. Counts only, never a fragment of what was dropped.
    onHistoryTrim: ({ kept, dropped, tokens }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "ok",
        detail: {
          historyKept: kept,
          historyDropped: dropped,
          historyTokens: tokens,
        },
      }),
  };
}
