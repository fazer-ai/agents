// WHERE A PROACTIVE TURN CAME FROM, written on its flow line so the console does not infer it from
// `source`, which would badge an inbound integration or the channel-redirect follow-up as an
// inactivity follow-up.
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
  // NOTE: every other source is an inbound integration's catalog type (ASAAS, GENERIC, …): an
  // external system spoke, whatever its framing.
  return "event";
}

export function isNudgeOrigin(v: unknown): v is NudgeOrigin {
  return (NUDGE_ORIGINS as readonly unknown[]).includes(v);
}
