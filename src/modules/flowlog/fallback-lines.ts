import { emitFlowEvent, type FlowContext } from "./service";
import type { FlowStage } from "./stages";

// The lines a model call writes about its fallback, one shape on every path that calls a model (the
// reply, the nudge, the playground's turn and follow-up, the observer). The alerts read these fields
// by name (flowlog/alerts.ts: `causeKeyOf`, `rateSubjectOf`), so a path that wrote its own variant
// would drop out of them without an error.

interface Labels {
  provider: string;
  model: string;
}

// The fallback answered. `ok`, because the turn succeeded, and `warn`, because it is the operator's
// one signal that the primary is not taking their traffic. Labelled with the fallback; the primary's
// failure rides as `primaryFailure` beside `fallbackFrom`, which is what counts it toward the
// PRIMARY's rate and cause.
export function emitFallbackAnswered(
  flow: FlowContext,
  stage: FlowStage,
  from: string,
  info: Labels & { reason: string; failure: string },
): void {
  emitFlowEvent(flow, {
    stage,
    level: "warn",
    status: "ok",
    provider: info.provider,
    model: info.model,
    detail: {
      fallbackFrom: from,
      fallbackReason: info.reason,
      primaryFailure: info.failure,
    },
  });
}

// The fallback failed too. Attribution, not a second alarm: the stage around the call emits its own
// error when the turn throws, and alert coalescing keys on (channel, stage, level), so these are `info`
// with `status: "error"`. The fallback's line says which model died. When a failing primary had handed
// it the turn, the primary's failure gets a line of its own under the primary's labels: nothing
// answered, so there is no `fallbackFrom` line to carry it, and without one the primary's 429 would
// count toward no rate and no cause.
export function emitFallbackFailed(
  flow: FlowContext,
  stage: FlowStage,
  info: Labels & {
    reason: string;
    failure: string;
    primary?: Labels & { reason: string; failure: string };
  },
): void {
  if (info.primary) {
    emitFlowEvent(flow, {
      stage,
      level: "info",
      status: "error",
      provider: info.primary.provider,
      model: info.primary.model,
      detail: { failure: info.primary.failure, handedToFallback: true },
      errorMessage: info.primary.reason,
    });
  }
  emitFlowEvent(flow, {
    stage,
    level: "info",
    status: "error",
    provider: info.provider,
    model: info.model,
    detail: { fallbackFailed: info.reason, failure: info.failure },
    errorMessage: info.reason,
  });
}
