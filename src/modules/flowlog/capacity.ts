import { emitFlowEvent, type FlowContext } from "./service";

// A reply that waited for capacity: a due debounce flush with no free slot in its lane
// (../debounce/worker.ts), or a model call with no free permit in the process-wide semaphore
// (../../graph/model-limit.ts). Nothing is written until a wait passes
// `config.agent.capacityWaitAlertMs`, then once per wait, so a lane that drains quickly stays quiet
// and a sustained saturation coalesces into one alert with a count. `warn`, on the delayed
// conversation's tenant, source `inbox`; `waitedMs` is measured when the line is written, so it is
// at least the threshold and not the whole wait.
export type CapacityLimit = "debounce_lane" | "model_semaphore";

export function emitCapacityWait(
  flow: FlowContext,
  waitedOn: CapacityLimit,
  wait: { waitedMs: number; thresholdMs: number },
  extra: Record<string, string> = {},
): void {
  emitFlowEvent(flow, {
    stage: "capacity",
    level: "warn",
    status: "ok",
    durationMs: wait.waitedMs,
    detail: {
      waitedOn,
      waitedMs: wait.waitedMs,
      thresholdMs: wait.thresholdMs,
      ...extra,
    },
  });
}
