import { requestContext } from "@/api/lib/i18n";

// WHAT A REQUEST'S METRICS READS SPENT, added up for its one log line (./metrics-request.ts). Each
// read (`runMetricsScoped`) reports here, and the tally rides in the request's async context.

export interface MetricsReads {
  reads: number;
  waitMs: number;
  runMs: number;
}

export function newMetricsReads(): MetricsReads {
  return { reads: 0, waitMs: 0, runMs: 0 };
}

// Called by every metrics read (`runMetricsScoped`) with what it spent. Outside a metrics request it
// reports to no one.
export function noteMetricsRead(waitMs: number, runMs: number): void {
  const tally = requestContext.getStore()?.metrics;
  if (!tally) return;
  tally.reads += 1;
  addTimes(tally, waitMs, runMs);
}

// Called by the session or key lookup in front of a metrics route, which runs on the same pool: its
// wait and run are the request's, though it is not one of the route's reads.
export function noteMetricsLookup(waitMs: number, runMs: number): void {
  const tally = requestContext.getStore()?.metrics;
  if (tally) addTimes(tally, waitMs, runMs);
}

function addTimes(tally: MetricsReads, waitMs: number, runMs: number): void {
  tally.waitMs += Math.max(0, Math.round(waitMs));
  tally.runMs += Math.max(0, Math.round(runMs));
}
