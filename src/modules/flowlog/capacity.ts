import { emitFlowEvent, type FlowContext } from "./service";

// A REPLY THAT WAITED FOR CAPACITY, AND THE ONE LINE THAT SAYS SO (issue #812).
//
// Two places make a customer's reply wait for the instance rather than for the model, and the
// customer feels both the same way: a due debounce flush with no free slot in its lane
// (../debounce/worker.ts), and a model call with no free permit in the process-wide semaphore
// (../../graph/model-limit.ts). Before this line both were silent: replies got slower and nothing
// said why.
//
// DELAY, NOT OCCUPANCY. A full lane that drains in seconds is healthy, so nothing is written until a
// wait passes `config.agent.capacityWaitAlertMs`, and then once per wait, while it is still waiting.
// Every reply queued behind the same saturation crosses the threshold at about the same moment, and
// the alert worker coalesces lines of one (channel, stage, level) inside its window, so a sustained
// saturation reaches the operator as one alert with a count.
//
// `warn`, on the delayed conversation's own tenant, source `inbox` (the only source that pages).
// Counts and one closed word only: `waitedOn` is read by the alert body, and `waitedMs` is measured
// when the line is written, so it is at least the threshold and not the whole wait.
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
