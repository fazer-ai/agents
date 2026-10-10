import { expect, spyOn } from "bun:test";
import type { GraphBuildDeps } from "@/graph/prepare";
import * as prepare from "@/graph/prepare";
import type { FlowEvent } from "@/modules/flowlog/service";
import * as flowlog from "@/modules/flowlog/service";

// The fallback's four lines (retry, took the turn, failed too, unavailable) are written by handlers
// each entrypoint hands to `buildModelAndGraph`, and every handler has the PRIMARY's labels in scope.
// So each event below carries labels no entrypoint is configured with: a line filed under any other
// model, or none, shows.
const RETRY = {
  attempt: 1,
  provider: "retry-provider",
  model: "retry-model",
  error: new Error("empty response"),
};
const TOOK = {
  provider: "took-provider",
  model: "took-model",
  reason: "primary said 503",
  failure: "primary-failure-class",
};
const FAILED = {
  provider: "failed-provider",
  model: "failed-model",
  reason: "fallback said 401",
  failure: "fallback-failure-class",
};
const UNAVAILABLE = {
  provider: "unavailable-provider",
  model: "unavailable-model",
  reason: "credential deleted",
};

// Runs an entrypoint and answers the deps of every graph it built, with the real build underneath.
export async function graphDepsOf(
  run: () => Promise<unknown>,
): Promise<GraphBuildDeps[]> {
  const build = spyOn(prepare, "buildModelAndGraph");
  try {
    await run();
    return build.mock.calls.map((c) => c[2] ?? {});
  } finally {
    build.mockRestore();
  }
}

// The line each handler writes for its event, captured instead of written.
export function fallbackLines(deps: GraphBuildDeps) {
  const emit = spyOn(flowlog, "emitFlowEvent").mockImplementation(() => {});
  const lineOf = (fire: () => void): FlowEvent | undefined => {
    emit.mockClear();
    fire();
    return emit.mock.calls.at(-1)?.[1];
  };
  try {
    return {
      retry: lineOf(() => deps.onModelRetry?.(RETRY)),
      took: lineOf(() => deps.onModelFallback?.(TOOK)),
      failed: lineOf(() => deps.onModelFallbackFailed?.(FAILED)),
      unavailable: lineOf(() => deps.onModelFallbackUnavailable?.(UNAVAILABLE)),
    };
  } finally {
    emit.mockRestore();
  }
}

// What every entrypoint owes: each line names the model its event is about; the took-the-turn line
// carries the primary's failure class; the fallback-failed line carries its own class and reason
// and does not alert (the stage's own error line is the one alarm); the two lines about a turn still
// running stay at a level that reaches an operator.
export function expectFallbackLines(deps: GraphBuildDeps): void {
  const lines = fallbackLines(deps);
  const labels = (l: FlowEvent | undefined) => [l?.provider, l?.model];
  expect(labels(lines.retry)).toEqual([RETRY.provider, RETRY.model]);
  expect(labels(lines.took)).toEqual([TOOK.provider, TOOK.model]);
  expect(labels(lines.failed)).toEqual([FAILED.provider, FAILED.model]);
  expect(labels(lines.unavailable)).toEqual([
    UNAVAILABLE.provider,
    UNAVAILABLE.model,
  ]);
  expect(lines.took?.level).toBe("warn");
  expect(lines.took?.detail).toMatchObject({ primaryFailure: TOOK.failure });
  expect(lines.failed?.status).toBe("error");
  expect(["warn", "error"]).not.toContain(lines.failed?.level);
  expect(lines.failed?.detail).toMatchObject({ failure: FAILED.failure });
  expect(lines.failed?.errorMessage).toBe(FAILED.reason);
  expect(lines.unavailable?.level).toBe("warn");
}
