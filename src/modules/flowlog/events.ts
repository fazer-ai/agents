// The events an alert channel can leave out beside its stages and level: what happened, where the stage
// only says in which step. Dependency-free like ./stages.ts, so the console and the schema layer read
// it without the emit machinery; which lines are of which event is ./alerts.ts `alertEventsOf`.
//
// Only what the stage list cannot tell apart, and only what has warn or error lines, is an event: a
// dead letter or a guardrail trip is a stage, and a retried empty response is an `info` line. A line
// that is none of these events is never left out by this list. The full rule is in docs/logs.md.
export const ALERT_EVENTS = [
  "tool_limit",
  "model_fallback",
  "provider_failure",
  "no_reply",
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

export function isAlertEvent(e: string): e is AlertEvent {
  return (ALERT_EVENTS as readonly string[]).includes(e);
}
