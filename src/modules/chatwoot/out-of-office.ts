// Whether CHATWOOT ITSELF answers out of hours on an inbox. This is the auto-reply configured inside
// Chatwoot, on the inbox — a different message, on a different schedule, from the agent's own away
// message (modules/availability/away.ts), and neither product can see the other's.
//
// The rule is Chatwoot's, mirrored here from the fork's source so a version bump has one place to be
// re-checked against: `MessageTemplates::HookExecutionService#should_send_out_of_office_message?`
// gates on `inbox.out_of_office? && inbox.out_of_office_message.present?`, and
// `OutOfOffisable#out_of_office?` is `working_hours_enabled? && working_hours.today.closed_now?`.
//
// Only two of those three are configuration. `closed_now?` is the WHEN and needs the clock; the other
// two are the WHETHER, and they are the half an operator can be told about before a customer sees the
// collision. So a true here means "this inbox sends its own out-of-hours reply", never "it is sending
// one right now".
//
// `present?` is Rails' — nil and whitespace-only are both blank — which is why the trim is not
// decoration: a message field holding a single space is configured in the console and dead in Chatwoot.
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
