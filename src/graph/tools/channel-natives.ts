// What each channel does with each native tool. Every map `satisfies NativeHandlers`, a mapped type
// over `NativeToolName`: a native added to the catalog fails the build of every channel until it
// decides, and a name that is not a native is refused. Support is decided when the toolset is
// ASSEMBLED: an unsupported native is never offered, because refusing at call time costs a model
// round and the model narrates the attempt ("I tried to transfer you").
import { NATIVE_TOOL_NAMES, type NativeToolName } from "./catalog";

export type NativeSupport =
  // The implementation in ./native.ts, which today acts on the Chatwoot conversation.
  | "real"
  // Same name, description and schema; a call returns a synthetic success and does nothing.
  | "simulated"
  // Carried out from an origin that is not a Chatwoot conversation, with what the channel hands the
  // tool for it (`ToolCtx.crossInboxCase.detached`); not offered without it. Only
  // `open_case_in_inbox` has that shape.
  | "detached"
  | { unsupported: string };

export type NativeHandlers = { readonly [K in NativeToolName]: NativeSupport };

export function unsupported(reason: string): { unsupported: string } {
  return { unsupported: reason };
}

export function isUnsupported(
  support: NativeSupport,
): support is { unsupported: string } {
  return typeof support === "object";
}

export function nativesWhere(
  handlers: NativeHandlers,
  test: (support: NativeSupport) => boolean,
): NativeToolName[] {
  return NATIVE_TOOL_NAMES.filter((name) => test(handlers[name]));
}

// A customer conversation in a Chatwoot inbox: the reactive turn and the proactive nudge.
export const INBOX_NATIVES = {
  handoff_to_human: "real",
  private_note: "real",
  set_custom_attribute: "real",
  set_labels: "real",
  resolve_conversation: "real",
  kanban_move_card: "real",
  update_kanban_task: "real",
  set_voice_preference: "real",
  update_contact: "real",
  react_to_message: "real",
  send_image: "real",
  open_case_in_inbox: "real",
  skip_reply: "real",
  calculator: "real",
  get_current_time: "real",
} as const satisfies NativeHandlers;

const OBSERVED = "an observed turn reaches no customer";

// An observation (muted client): the ordinary toolset minus what only makes sense in front of the
// customer. A private note stays: it is the one thing an observer writes where a person reads it.
export const OBSERVER_NATIVES = {
  ...INBOX_NATIVES,
  react_to_message: unsupported(OBSERVED),
  send_image: unsupported(OBSERVED),
  // NOTE: its opening message reaches the customer in the destination inbox.
  open_case_in_inbox: unsupported(OBSERVED),
} as const satisfies NativeHandlers;

// The console playground: the operator watches the agent DECIDE, so every conversation tool keeps
// its name and description and does nothing. Calculator and clock have no effect to simulate.
// `skip_reply` stays real because its return value IS the tool: it tells the model to produce no
// message, and the generic simulated line would make the playground answer where production is silent.
export const PLAYGROUND_NATIVES = {
  handoff_to_human: "simulated",
  private_note: "simulated",
  set_custom_attribute: "simulated",
  set_labels: "simulated",
  resolve_conversation: "simulated",
  kanban_move_card: "simulated",
  update_kanban_task: "simulated",
  set_voice_preference: "simulated",
  update_contact: "simulated",
  react_to_message: "simulated",
  send_image: "simulated",
  open_case_in_inbox: "simulated",
  skip_reply: "real",
  calculator: "real",
  get_current_time: "real",
} as const satisfies NativeHandlers;

const NO_HUMAN = "the client channel has no human attendance";
const NO_CRM = "the client channel has no CRM";
const NO_CUSTOMER_MESSAGE =
  "the client channel answers its host, not a messaging app";

// An agent embedded in a host application (modules/client-channel). There is no Chatwoot
// conversation behind it, so nothing that acts on one is offered; a case in the team's inbox is.
export const CLIENT_CHANNEL_NATIVES = {
  handoff_to_human: unsupported(NO_HUMAN),
  private_note: unsupported(NO_HUMAN),
  resolve_conversation: unsupported(NO_HUMAN),
  set_custom_attribute: unsupported(NO_CRM),
  set_labels: unsupported(NO_CRM),
  kanban_move_card: unsupported(NO_CRM),
  update_kanban_task: unsupported(NO_CRM),
  update_contact: unsupported(NO_CRM),
  // NOTE: the escalation this channel has: the case goes to the team's inbox, with the contact the
  // host stated (modules/client-channel/case.ts).
  open_case_in_inbox: "detached",
  set_voice_preference: unsupported(NO_CUSTOMER_MESSAGE),
  react_to_message: unsupported(NO_CUSTOMER_MESSAGE),
  send_image: unsupported(NO_CUSTOMER_MESSAGE),
  skip_reply: unsupported("the host is waiting for an answer to its request"),
  calculator: "real",
  get_current_time: "real",
} as const satisfies NativeHandlers;

// What an observed turn is not offered: the natives that act in front of the customer. The agent
// editor reads it to say which grants an observer ignores.
export const CUSTOMER_DELIVERY_NATIVE_TOOL_NAMES: readonly NativeToolName[] =
  nativesWhere(OBSERVER_NATIVES, isUnsupported);

// What the playground answers with a synthetic success, for the labels on its trace and transcript.
export const PLAYGROUND_SIMULATED_NATIVE_TOOL_NAMES: readonly NativeToolName[] =
  nativesWhere(PLAYGROUND_NATIVES, (s) => s === "simulated");
