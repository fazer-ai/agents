import logger from "@/api/lib/logger";
import { type MetricsReads, newMetricsReads } from "@/api/lib/metrics-reads";
import { BREAKDOWN_DIMENSIONS } from "@/modules/analytics/breakdown";
import { OUTCOME_BREAKDOWNS } from "@/modules/analytics/trends";

// ONE LINE PER METRICS REQUEST (docs/dashboard.md, "How the console loads"): the route, how long a
// window it asked for, which filters it set, how long its reads waited for a connection of the metrics
// pool and how long they ran, and the status it answered. Never an instant, an id or a zone: the
// window is a length, and a filter is whether it was set.

const PREFIX = "/api/v1/metrics";
const DAY_MS = 86_400_000;
const FILTERS = {
  agent: "agentId",
  inbox: "inboxId",
  source: "source",
  audience: "audience",
} as const;
// Closed vocabularies that change what a read costs, logged by value and only when the value is one
// of them: a route that ignores the parameter accepts any text in it.
const SHAPES: Record<string, readonly string[]> = {
  dimension: BREAKDOWN_DIMENSIONS,
  breakdown: OUTCOME_BREAKDOWNS,
};

const tallies = new WeakMap<
  Request,
  { tally: MetricsReads; arrivedAt: number }
>();

// The tally a metrics request's reads add to, kept beside the request so the line can be written once
// the response is out, where the request's async context is no longer guaranteed.
export function trackMetricsRequest(
  request: Request,
  arrivedAt: number,
): MetricsReads | undefined {
  if (!new URL(request.url).pathname.startsWith(PREFIX)) return undefined;
  const tally = newMetricsReads();
  tallies.set(request, { tally, arrivedAt });
  return tally;
}

function instant(value: string | null): number | null {
  if (value === null) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

// The window's length in days, to the hundredth: null for an all-time view or a start that does not
// parse. A window still running ends at the request's arrival, as its reads do.
export function windowDays(
  params: URLSearchParams,
  arrivedAt: number,
): number | null {
  const since = instant(params.get("since"));
  if (since === null) return null;
  const until = instant(params.get("until")) ?? arrivedAt;
  const hundredths = Math.round(((until - since) * 100) / DAY_MS);
  return hundredths / 100;
}

export function logMetricsRequest(
  request: Request,
  route: string | null,
  status: number | string | undefined,
): void {
  const tracked = tallies.get(request);
  if (!tracked) return;
  const { tally, arrivedAt } = tracked;
  const params = new URL(request.url).searchParams;
  const line: Record<string, unknown> = {
    route: route ?? PREFIX,
    status,
    reads: tally.reads,
    waitMs: tally.waitMs,
    runMs: tally.runMs,
    totalMs: Date.now() - arrivedAt,
  };
  // A request that read nothing (refused before its handler) says nothing about what it asked for.
  if (tally.reads > 0) {
    line.windowDays = windowDays(params, arrivedAt);
    for (const [name, param] of Object.entries(FILTERS))
      line[name] = params.get(param) !== null;
    for (const [shape, allowed] of Object.entries(SHAPES)) {
      const value = params.get(shape);
      if (value !== null && allowed.includes(value)) line[shape] = value;
    }
  }
  logger.info(line, "metrics request");
}
