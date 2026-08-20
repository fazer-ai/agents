import { type BaseMessage, HumanMessage } from "@langchain/core/messages";

// The system markers that ride INSIDE messages of the graph memory thread.
//
// They live in a near-leaf module — messages only, no Prisma, no tenancy, no checkpointer — because
// the code that DECIDES where an attendance begins and ends (src/modules/memory/cut.ts) is a pure
// function over an array of messages, and it must stay that way.
//
// Why the markers are messages and not a SystemMessage: the agent node drops every system message
// from the history before the model call (src/graph/graph.ts), because a second system message is
// rejected outright by some providers. A system-role marker would therefore be invisible at exactly
// the moment it matters.
//
// RECOGNIZED BY METADATA, WRITTEN ONLY HERE. The marker text still travels in the content, because
// that is what the model reads, but nothing decides anything from that text. A customer whose message
// happens to start with one of these tags would otherwise be read as a system marker — and this repo
// is public, so "happens to" includes "chose to". The sharp end is the memory head: a message taken
// for the head is excluded from the summary and then REPLACED by the rendered head, so a customer's
// words would be deleted without ever having been summarized. Metadata cannot be typed into a chat.

const MARKER_KWARG = "fazerMarker";
type SystemMarker = "divider" | "memory_head" | "nudge";

function hasMarker(message: BaseMessage, marker: SystemMarker): boolean {
  return message.additional_kwargs?.[MARKER_KWARG] === marker;
}

// WHICH ATTENDANCE A MESSAGE BELONGS TO, stamped on the message itself.
//
// This is what the cut reads, and the divider is NOT. The divider is one message that somebody has to
// notice the need for, write in the right place, and keep: an invoke that started earlier saves the
// channel it loaded and erases it, ingestion only looked for the transition on customer messages, and
// the marker row recording "we already wrote one" advances independently of it. Each of those is a way
// for the boundary to end up somewhere the cut cannot find, and a boundary the cut cannot find merges
// two attendances into one summary, silently.
//
// A stamp has none of those failure modes: it is written with the message it describes, by whoever
// writes it, and an invoke that restores an older channel restores the stamps with it. Assistant
// replies are deliberately NOT stamped — they are built inside the graph, not by us — which is why the
// cut asks where the CURRENT attendance STARTS rather than where the previous one ended.
//
// Inert on the wire: the OpenAI, Google and Anthropic adapters read only known keys out of
// additional_kwargs (tool calls, thought signatures) and never spread the rest into the request.
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

// WHICH ATTENDANCE THE THREAD IS ON, which is the last stamped message's — not "any message stamped
// with X exists somewhere". A conversation can be REOPENED after another has already run on this
// thread (an operator picking an old one back up, a human agent replying in it), so a stamp appearing
// earlier says nothing about where the thread is now. Asking "does X appear anywhere" answered yes
// for an attendance that ended long ago, and every reader of that answer got it wrong in its own way.
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
// silent-message ingestion (src/graph/ingest.ts) — the first as its own message, the second prepended
// to the customer's text, which is why the factory takes the trailing text.
export const CONVERSATION_DIVIDER =
  "(Contexto do sistema: início de uma nova conversa com este mesmo contato. As mensagens anteriores são de atendimentos passados; não presuma que o assunto continua, trate isto como um novo atendimento.)";

// The compacted memory of already-closed attendances, rendered from attendance_summaries and kept as
// the FIRST message of the thread. Recognizing it matters as much as writing it: the head is rebuilt
// from the rows on every compaction, so it must never be fed back to the summarizer — that is the
// difference between summarizing each attendance once and re-summarizing a summary forever.
export const MEMORY_HEAD_OPEN = "<atendimentos-anteriores>";
export const MEMORY_HEAD_CLOSE = "</atendimentos-anteriores>";

// The divider is PROMPT CONTENT: it tells the model a new attendance started. It is not what the cut
// reads — see conversationStamp above — so losing one costs a hint in one prompt, never a boundary.
export function conversationDividerMessage(
  conversationId: number,
  trailingText?: string,
): HumanMessage {
  return new HumanMessage({
    content: trailingText
      ? `${CONVERSATION_DIVIDER}\n\n${trailingText}`
      : CONVERSATION_DIVIDER,
    additional_kwargs: {
      [MARKER_KWARG]: "divider" satisfies SystemMarker,
      ...conversationStamp(conversationId),
    },
  });
}

// `id` reuses the id of the message the head replaces, which is what keeps it at the front of the
// channel (the reducer replaces a same-id message in place and appends an unknown-id one at the end).
export function memoryHeadMessage(content: string, id?: string): HumanMessage {
  return new HumanMessage({
    ...(id ? { id } : {}),
    content,
    additional_kwargs: { [MARKER_KWARG]: "memory_head" satisfies SystemMarker },
  });
}

// A proactive nudge is injected into the thread as a HUMAN turn — a SystemMessage would make strict
// providers reject the call (src/graph/graph.ts) — so from the channel's point of view the operator's
// own guidance and the untrusted external event payload look exactly like something the customer
// typed. Nothing downstream could tell them apart, and the summarizer wrote them into the permanent
// memory as the contact's words. Marked at the source, like every other marker here.
// Stamped like every other message we write: a nudge can be the FIRST activity of a new attendance
// (a redirect follow-up that lands before the customer says anything), and an unstamped one leaves
// the cut reading the previous attendance as still current — so the nudge and the reply it produced
// were summarized away as part of it. The conversation is required, not optional, so a future writer
// cannot forget it the way this one did.
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

export function isConversationDivider(message: BaseMessage): boolean {
  return hasMarker(message, "divider");
}

export function isMemoryHead(message: BaseMessage): boolean {
  return hasMarker(message, "memory_head");
}

export function isNudgeTurn(message: BaseMessage): boolean {
  return hasMarker(message, "nudge");
}
