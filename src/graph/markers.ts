import {
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";

// The system markers that ride INSIDE messages of the graph memory thread, in a near-leaf module
// (messages only, no Prisma, no tenancy) because the code deciding where an attendance begins and
// ends (src/modules/memory/cut.ts) is a pure function over messages and must stay one. Markers are
// messages, not SystemMessages: the agent node drops every system message before the model call
// (src/graph/graph.ts), since some providers reject a second one. Recognized by METADATA and written
// only here: the text rides in the content for the model, but a customer can type a tag (the repo is
// public), and a message taken for the memory head is REPLACED by the rendered head without ever
// being summarized. Metadata cannot be typed into a chat.

const MARKER_KWARG = "fazerMarker";
type SystemMarker =
  | "divider"
  | "memory_head"
  | "nudge"
  | "human_agent"
  | "human_handback"
  | "called_off";

function hasMarker(message: BaseMessage, marker: SystemMarker): boolean {
  return message.additional_kwargs?.[MARKER_KWARG] === marker;
}

// Which attendance a message belongs to, stamped on the message itself; this is what the cut reads,
// not the divider. A divider is one message someone must decide to write, place right and keep (an
// earlier-started invoke erases it on save, and the marker row advances independently of it), and a
// boundary the cut cannot find silently merges two attendances into one summary. A stamp is written
// with its message, and an invoke restoring an older channel restores the stamps too. Assistant
// replies are NOT stamped (the graph builds them), which is why the cut asks where the CURRENT
// attendance starts. Inert on the wire: the OpenAI, Google and Anthropic adapters read only known
// keys from additional_kwargs.
const CONVERSATION_KWARG = "fazerConversationId";

export function conversationStamp(
  conversationId: number,
): Record<string, unknown> {
  return { [CONVERSATION_KWARG]: conversationId };
}

export function stampedConversationId(message: BaseMessage): number | null {
  const raw = message.additional_kwargs?.[CONVERSATION_KWARG];
  return typeof raw === "number" ? raw : null;
}

// When a message was sent, stamped on it as the instant Chatwoot recorded. The model sees it rendered
// at call time (./history-dates.ts), never in `content`, where the summarizer and playground would
// quote it as the customer's words. Absent is not "now": a message whose instant we never had (an
// older message, a system event, an assistant reply) carries no date and is shown without one.
const SENT_AT_KWARG = "fazerSentAt";

export function sentAtStamp(
  at: Date | null | undefined,
): Record<string, unknown> {
  return at instanceof Date && Number.isFinite(at.getTime())
    ? { [SENT_AT_KWARG]: at.toISOString() }
    : {};
}

export function stampedSentAt(message: BaseMessage): Date | null {
  const raw = message.additional_kwargs?.[SENT_AT_KWARG];
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isFinite(at.getTime()) ? at : null;
}

// When the customer's burst behind a coalesced turn STARTED: its oldest member. The sent-at stamp is
// the newest, which is what the age variable reads; where an attendance begins is the other end.
// Absent on a turn of one message, where the two are the same instant.
const BURST_START_KWARG = "fazerBurstStartedAt";

export function burstStartStamp(
  at: Date | null | undefined,
): Record<string, unknown> {
  return at instanceof Date && Number.isFinite(at.getTime())
    ? { [BURST_START_KWARG]: at.toISOString() }
    : {};
}

export function stampedBurstStart(message: BaseMessage): Date | null {
  const raw = message.additional_kwargs?.[BURST_START_KWARG];
  if (typeof raw !== "string") return null;
  const at = new Date(raw);
  return Number.isFinite(at.getTime()) ? at : null;
}

// Which attendance the thread is on: the last stamped message's, not "any message stamped with X". A
// conversation can be REOPENED after another ran on this thread (an operator picking an old one back
// up, a human agent replying in it), so an earlier stamp says nothing about where the thread is now.
export function lastStampedConversationId(
  messages: BaseMessage[],
): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m === undefined) continue;
    const stamp = stampedConversationId(m);
    if (stamp !== null) return stamp;
  }
  return null;
}

// Folded into the first human turn of a NEW conversation when the contact-inbox thread already
// carries memory from a prior one. Written by both the reactive turn (src/graph/runtime.ts) and the
// silent-message ingestion (src/graph/ingest.ts): the first as its own message, the second prepended
// to the customer's text, which is why the factory takes the trailing text.
export const CONVERSATION_DIVIDER =
  "(Contexto do sistema: início de uma nova conversa com este mesmo contato. As mensagens anteriores são de atendimentos passados; não presuma que o assunto continua, trate isto como um novo atendimento.)";

// The compacted memory of already-closed attendances, rendered from attendance_summaries and kept as
// the FIRST message of the thread. Recognizing it matters as much as writing it: the head is rebuilt
// from the rows on every compaction, so it must never be fed back to the summarizer, or a summary
// would be re-summarized forever.
export const MEMORY_HEAD_OPEN = "<atendimentos-anteriores>";
export const MEMORY_HEAD_CLOSE = "</atendimentos-anteriores>";

// The divider is PROMPT CONTENT: it tells the model a new attendance started. It is not what the cut
// reads (see conversationStamp above), so losing one costs a hint in one prompt, never a boundary.
export function conversationDividerMessage(
  conversationId: number,
  trailingText?: string,
  id?: string,
  sentAt?: Date | null,
): HumanMessage {
  return new HumanMessage({
    ...(id ? { id } : {}),
    content: trailingText
      ? `${CONVERSATION_DIVIDER}\n\n${trailingText}`
      : CONVERSATION_DIVIDER,
    additional_kwargs: {
      [MARKER_KWARG]: "divider" satisfies SystemMarker,
      ...conversationStamp(conversationId),
      // NOTE: only when it carries the customer's words: a bare divider is ours, and was never sent.
      ...(trailingText ? sentAtStamp(sentAt) : {}),
    },
  });
}

// Whether the attendance this head replaced ended owing a hand-back. Compaction takes with it the
// handoff's tool result and the human agent's messages, and a conversation RESOLVED while a person
// held it is exactly that case, so without this the next turn would find no evidence and the agent
// would stay silent. Metadata, not prose: the summary text is model-written. It rides on the head,
// not as a note of its own, because the note is a claim about NOW that only a turn under its
// ownership guard may make; this says only what the summarized stretch ended in.
const HANDOFF_OPEN_KWARG = "fazerHandoffOpen";

// `id` reuses the id of the message the head replaces, which is what keeps it at the front of the
// channel (the reducer replaces a same-id message in place and appends an unknown-id one at the end).
export function memoryHeadMessage(
  content: string,
  id?: string,
  endedInHumanAttendance = false,
): HumanMessage {
  return new HumanMessage({
    ...(id ? { id } : {}),
    content,
    additional_kwargs: {
      [MARKER_KWARG]: "memory_head" satisfies SystemMarker,
      ...(endedInHumanAttendance ? { [HANDOFF_OPEN_KWARG]: true } : {}),
    },
  });
}

export function endedInHumanAttendance(message: BaseMessage): boolean {
  return message.additional_kwargs?.[HANDOFF_OPEN_KWARG] === true;
}

// A proactive nudge enters the thread as a HUMAN turn (a SystemMessage would make strict providers
// reject the call), so without its marker the operator's guidance and an untrusted event payload
// would read, and be summarized, as the contact's words. Stamped like every message we write: a nudge
// can be the FIRST activity of a new attendance, and an unstamped one leaves the cut reading the
// previous attendance as current, summarizing the nudge and its reply away. The conversation is
// required so no writer can forget it.
export function nudgeMessage(
  content: string,
  conversationId: number,
): HumanMessage {
  return new HumanMessage({
    content,
    additional_kwargs: {
      [MARKER_KWARG]: "nudge" satisfies SystemMarker,
      ...conversationStamp(conversationId),
    },
  });
}

// A message a HUMAN AGENT sent the customer while the bot was silent. It rides as a HumanMessage (a
// system role is dropped before the model call), so this note is what keeps the model and the
// summarizer from reading the operator's words as the CONTACT's. The note is a short constant with no
// attendant NAME: it is prepended to every attendant message in every prompt until compaction, so its
// length recurs (unlike the divider's), a name would cost more for no decision it changes, and a
// constant lets the transcript trim it by exact match (../modules/memory/summarize.ts).
export const HUMAN_AGENT_NOTE =
  "(Contexto do sistema: mensagem enviada ao cliente por um atendente humano da equipe.)";

// `conversationId` is NULLABLE, and null is not "unknown": it says this message must not claim an
// attendance. The cut (../modules/memory/cut.ts) reads the stamp to decide which attendance is open,
// so a stamp for a conversation the thread already left redefines the open one (see ./ingest.ts).
export function humanAgentMessage(
  conversationId: number | null,
  text: string,
  id?: string,
  sentAt?: Date | null,
): HumanMessage {
  return new HumanMessage({
    ...(id ? { id } : {}),
    content: `${HUMAN_AGENT_NOTE}\n\n${text}`,
    additional_kwargs: {
      [MARKER_KWARG]: "human_agent" satisfies SystemMarker,
      ...(conversationId === null ? {} : conversationStamp(conversationId)),
      ...sentAtStamp(sentAt),
    },
  });
}

// The end of the human stretch. The thread records a transfer and a person answering but not the
// conversation coming back, so a prompt like "após transferir, não responda mais" would keep applying
// forever, and models then either go silent or send the silence to the customer as text. It states a
// fact and orders nothing: telling the model it is "responsible for replying from here" would have
// the product overrule the operator's own prompt. The operator's rule stays in force; the model
// learns that the condition it hangs on has stopped being true.
export const HUMAN_HANDBACK_NOTE =
  "(Contexto do sistema: o atendimento humano terminou e a conversa voltou para o agente virtual.)";

// Stamped like every other message we write, and for the reason `nudgeMessage` states: this can be
// the first thing written in a new attendance (a hand-back that lands before the customer speaks
// again), and an unstamped one leaves the cut reading the previous attendance as still current.
export function humanHandbackMessage(conversationId: number): HumanMessage {
  return new HumanMessage({
    content: HUMAN_HANDBACK_NOTE,
    additional_kwargs: {
      [MARKER_KWARG]: "human_handback" satisfies SystemMarker,
      ...conversationStamp(conversationId),
    },
  });
}

export function isHumanHandback(message: BaseMessage): boolean {
  return hasMarker(message, "human_handback");
}

export function isConversationDivider(message: BaseMessage): boolean {
  return hasMarker(message, "divider");
}

export function isMemoryHead(message: BaseMessage): boolean {
  return hasMarker(message, "memory_head");
}

export function isNudgeTurn(message: BaseMessage): boolean {
  return hasMarker(message, "nudge");
}

export function isHumanAgentTurn(message: BaseMessage): boolean {
  return hasMarker(message, "human_agent");
}

// What a tool call gets back when the turn was called off while it was in flight. The text is for the
// model; the MARKER is for us: a rollback must know nothing ran, and cannot ask the tool's name (the
// caller's to choose; `toolDefinitionCreateSchema` reserves no native ones) or the content (a tool may
// return this sentence itself). Only the graph writes the marker. It does not name `/reset`, since a
// retired job withdraws a turn the same way, and a guessed cause would be wrong for half the callers.
export const CALLED_OFF_TOOL_RESULT =
  "Not executed: this turn was cancelled while the call was in flight.";

export function calledOffToolResult(call: {
  id?: string;
  name: string;
}): ToolMessage {
  return new ToolMessage({
    tool_call_id: call.id ?? "",
    name: call.name,
    content: CALLED_OFF_TOOL_RESULT,
    additional_kwargs: { [MARKER_KWARG]: "called_off" },
  });
}

export function isCalledOffToolResult(message: BaseMessage): boolean {
  return message.getType() === "tool" && hasMarker(message, "called_off");
}

// Whether the tool boundary refused this invoke's calls, asked by the caller of what `graph.invoke`
// returned because its own fence may answer differently now: the channel-redirect one reads
// `agent.enabled` on every ask, so an agent switched off and back on during the call would look like
// an ordinary SILENT turn, and the caller would mark the message handled without rolling back. Read
// positionally, as the boundary emits it (the refusals, then the empty turn): an OLDER refusal still
// in the thread cannot sit second to last, because every later invoke appends its own turn after it.
export function turnWasCalledOff(produced: readonly BaseMessage[]): boolean {
  const beforeLast = produced.at(-2);
  return beforeLast !== undefined && isCalledOffToolResult(beforeLast);
}
