// WHERE A PROACTIVE TURN CAME FROM, written on its flow line so a reader does not have to infer it
// from `source` (issue #846). The console used to: every source that was not an appointment reminder
// was badged "Follow-up", so an operator's system speaking through an inbound integration read as an
// inactivity follow-up, and so did the channel-redirect follow-up.
//
// A module of its own so the conversation read (../modules/conversations/service.ts) can check the
// value without importing the nudge runtime.
export const NUDGE_ORIGINS = [
  "followup",
  "reminder",
  "redirect",
  "event",
] as const;
export type NudgeOrigin = (typeof NUDGE_ORIGINS)[number];

export function nudgeOrigin(nudge: { source: string }): NudgeOrigin {
  if (nudge.source === "appointment_reminder") return "reminder";
  if (nudge.source === "channel-redirect") return "redirect";
  if (nudge.source === "followup") return "followup";
  // Every other source is an inbound integration's catalog type (ASAAS, GENERIC, …): an external
  // system spoke, whatever its framing.
  return "event";
}

export function isNudgeOrigin(v: unknown): v is NudgeOrigin {
  return (NUDGE_ORIGINS as readonly unknown[]).includes(v);
}
