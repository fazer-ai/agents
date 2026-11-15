// The events an alert channel can leave out beside its stages and level: what happened, where the stage
// only says in which step. Dependency-free like ./stages.ts, so the console and the schema layer can
// read it without the emit machinery. Which lines are of which event is ./alerts.ts `alertEventsOf`.
//
// Only what the stage list cannot already tell apart is an event. A dead letter, a guardrail trip, a
// channel error and a capacity wait are stages of their own, so they are filtered there; a provider
// failure is an event because it happens on every stage that calls a model. A retried empty response
// is no event: its line is `info` and never alerts, and the turn it fails is a provider failure. A line
// that is none of these events is never left out by this list.
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
