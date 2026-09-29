// Whether Chatwoot itself auto-replies out of hours on an inbox (configured in Chatwoot, distinct
// from the agent's away message in modules/availability/away.ts). Mirrors
// `HookExecutionService#should_send_out_of_office_message?`: `working_hours_enabled?`, a present
// `out_of_office_message`, and `closed_now?`. Only the first two are configuration, so true means
// "this inbox sends its own out-of-hours reply", never "it is sending one now". The trim matches
// Rails' `present?`: a whitespace-only message is set in the console and dead in Chatwoot.
export function chatwootAutoRepliesOutOfHours(inbox: {
  workingHoursEnabled: boolean;
  outOfOfficeMessage: string | null;
}): boolean {
  return (
    inbox.workingHoursEnabled &&
    inbox.outOfOfficeMessage !== null &&
    inbox.outOfOfficeMessage.trim() !== ""
  );
}
