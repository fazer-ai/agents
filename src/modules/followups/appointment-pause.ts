import type { FollowUpConfig, FollowUpStep } from "./settings";

// Does the appointment pause apply to THIS step? One function so its three askers agree: the SWEEP
// (about `cfg.steps[0]`), the HANDLER (the step its payload names) and the CONSOLE (the next step).
// The agent-wide `pauseWhileAppointment` is the default and a single step may be exempted, since a
// payment-deadline step matters exactly WHILE a booking stands. No notion of "paid" or "confirmed".
// An absent step means the pause applies: a caller that cannot name a step has shown no exemption.
export function appointmentPauseApplies(
  cfg: FollowUpConfig,
  step: FollowUpStep | undefined,
): boolean {
  return cfg.pauseWhileAppointment && step?.ignoreAppointmentPause !== true;
}
