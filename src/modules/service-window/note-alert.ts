import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import type { ProactiveKind } from "./kinds";

// Why a proactive send outside the window became a note instead of a template: none was configured
// for its occasion, or one was and a value rendered empty (a contact with no name, say).
export type WindowNoteReason = "no_template" | "blank_value";

// The operator-facing sentence of a `service_window` line. Fixed text: the note itself is the
// customer's conversation, and what it said is not a diagnosis.
export function windowNoteMessage(
  kind: ProactiveKind | null,
  reason: WindowNoteReason,
): string {
  const what = kind ? `A proactive ${kind}` : "A proactive message";
  return reason === "no_template"
    ? `${what} outside the WhatsApp 24h window became a private note: no template is configured for it. Choose one in the agent's Behavior tab, under Proactive messages.`
    : `${what} outside the WhatsApp 24h window became a private note: a value of its template came out empty. Give that value a fallback in the agent's Behavior tab, under Proactive messages.`;
}

// The warn line a window note leaves, one per note; the alert it raises is one per agent per day
// (`causeKeyOf`).
export function emitWindowNote(
  flow: FlowContext,
  args: {
    agentId: bigint;
    kind: ProactiveKind | null;
    reason: WindowNoteReason;
  },
): void {
  emitFlowEvent(flow, {
    stage: "service_window",
    level: "warn",
    status: "skipped",
    errorMessage: windowNoteMessage(args.kind, args.reason),
    detail: {
      agent: String(args.agentId),
      reason: args.reason,
      ...(args.kind ? { kind: args.kind } : {}),
    },
  });
}
