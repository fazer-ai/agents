import type { FollowUpConfig, FollowUpStep } from "./settings";

// Does the appointment pause apply to THIS step?
//
// One question, asked from three places that reach it by completely different routes, and the whole
// point of it being one function is that they cannot answer it differently:
//
//   - the SWEEP, deciding whether to enqueue at all, asks about `cfg.steps[0]` — the only step it
//     ever starts a sequence with;
//   - the HANDLER, holding a claimed job, asks about the step its payload names;
//   - the CONSOLE, rendering a conversation, asks about the step that is next to fire.
//
// `followUp.pauseWhileAppointment` is per AGENT, and it answers for a whole sequence a question two
// kinds of step answer oppositely (issue #103). A re-engagement nudge wants to be held while a
// booking stands; a payment-deadline step wants exactly the reverse — it only means anything WHILE
// the booking is unconfirmed, and it is the step that later frees the slot. So the agent-wide flag
// is the default and a single step may be exempted from it, which makes the deciding pair
// (agent, step) rather than (agent).
//
// Deliberately NOT a notion of "paid" or "confirmed": the platform does not know what those mean
// for any given operator, and the step that does is the one they wrote.
//
// An absent step means the pause applies. That is the fail-safe direction — a caller that cannot
// name a step has not shown an exemption — and it is what `cfg.steps[0]` yields for a config whose
// steps the reader could not parse at all.
export function appointmentPauseApplies(
  cfg: FollowUpConfig,
  step: FollowUpStep | undefined,
): boolean {
  return cfg.pauseWhileAppointment && step?.ignoreAppointmentPause !== true;
}
