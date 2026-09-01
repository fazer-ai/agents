import {
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";

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
  id?: string,
): HumanMessage {
  return new HumanMessage({
    ...(id ? { id } : {}),
    content: trailingText
      ? `${CONVERSATION_DIVIDER}\n\n${trailingText}`
      : CONVERSATION_DIVIDER,
    additional_kwargs: {
      [MARKER_KWARG]: "divider" satisfies SystemMarker,
      ...conversationStamp(conversationId),
    },
  });
}

// WHETHER THE ATTENDANCE THIS HEAD REPLACED ENDED OWING A HAND-BACK (issue #457, review round 8).
//
// Compaction replaces a closed attendance with its summary, and with it the two things the hand-back
// decision reads: the handoff's tool result and the human agent's messages. A conversation RESOLVED
// while a person still held it is exactly that case — the next turn on the thread would find no
// evidence, ask nothing, and the agent would go back to the silence this whole feature exists to
// end. Carried as METADATA and not as prose, for the reason the marker block above gives: the
// summary text is model-written, and nothing decides anything from model-written text.
//
// It rides on the head rather than as a message of its own, because a note here would be written
// while the person may still hold the conversation — the note is a claim about NOW, and only a turn
// under its ownership guard may make it. This says something weaker and durable: what the summarized
// stretch ended in.
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

// A message a HUMAN AGENT sent to the customer while the bot was silent. It rides as a HumanMessage
// for the reason at the top of this file (a system role is dropped before the model call), and that
// is precisely what makes the note below load-bearing: without it the model reads the operator's own
// words as something the CONTACT said. The summarizer read it that way too, and wrote it into the
// permanent memory of the contact — issue #187, the failure the issue calls worse than the omission.
//
// The note is a constant, carries no attendant NAME, and is kept short. It is prepended to EVERY
// attendant message and travels in every prompt of that attendance until compaction, so its length is
// a recurring cost, unlike the divider's (once per attendance). The name would be a second recurring
// cost for something that changes no decision the agent makes, on operator-controlled text; and a
// constant prefix is what lets the transcript trim it back off by exact match
// (../modules/memory/summarize.ts).
export const HUMAN_AGENT_NOTE =
  "(Contexto do sistema: mensagem enviada ao cliente por um atendente humano da equipe.)";

// `conversationId` is NULLABLE, and null is not "unknown": it says this message must not claim an
// attendance. The stamp is what ../modules/memory/cut.ts reads to decide which attendance is open, so
// a message stamped with a conversation the thread has already left redefines the open one from the
// end of the channel — see ./ingest.ts, issue #194.
export function humanAgentMessage(
  conversationId: number | null,
  text: string,
  id?: string,
): HumanMessage {
  return new HumanMessage({
    ...(id ? { id } : {}),
    content: `${HUMAN_AGENT_NOTE}\n\n${text}`,
    additional_kwargs: {
      [MARKER_KWARG]: "human_agent" satisfies SystemMarker,
      ...(conversationId === null ? {} : conversationStamp(conversationId)),
    },
  });
}

// THE END OF THE HUMAN STRETCH, and it exists because only the START of one was ever written down
// (issue #457). The note above marks a person answering; the agent's own transfer turn sits in the
// thread above that; and when the conversation comes back, nothing anywhere says so. An operator
// prompt as ordinary as "após transferir, não responda mais" then keeps applying to a stretch that
// ended, forever — measured live against two models: one turned silent (`outcome=empty`) and the
// other wrote the silence out loud, sending "(Silêncio, pois a conversa agora é entre você e o
// atendente humano.)" to the customer.
//
// IT STATES A FACT AND ORDERS NOTHING, which is the whole design and was measured against the
// alternative. A note telling the model it is "responsible for replying from here" also works, and
// it makes the product overrule an operator's own prompt — a much bigger decision than this issue
// asks for. Stating what changed is enough: the operator's rule stays in force, and what the model
// learns is that the condition it hangs on stopped being true.
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

// WHAT A TOOL CALL GETS BACK WHEN THE TURN WAS CALLED OFF WHILE IT WAS IN FLIGHT (issue #449).
//
// The text is for the model that eventually reads this thread; the MARKER is for us, and the two are
// not interchangeable. A rollback has to know that nothing ran, and it cannot ask the tool's name —
// the name is the caller's (`toolDefinitionCreateSchema` does not reserve the native ones) and the
// refusal covers every tool source there is. It cannot read the content either: a tool is free to
// return this sentence itself. Only the graph writes this marker, so only the graph's own refusal
// carries it.
//
// It does not name `/reset`, because the fence does not either: a retired job withdraws a turn the
// same way, and a result that guessed the cause would be wrong on the other half of the callers.
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

// DID THE TOOL BOUNDARY REFUSE THIS INVOKE'S CALLS? Asked of what `graph.invoke` returned, by the
// caller, and it exists because the caller cannot ask its own fence again to find out.
//
// The fences handed to the graph are not all monotonic: the channel-redirect one reads `agent.enabled`
// on every ask, so an operator who switches the agent off during the model call and back on before
// the caller's post-invoke check gets `true` there. The turn then looks like an ordinary SILENT one —
// the boundary ends it on an empty assistant message — and the caller advances its ladder, marks the
// message handled, and rolls nothing back, on a turn that was withdrawn (review round 5).
//
// Read positionally, the same axis the rollback pairs on, because that is the shape the boundary
// emits: the refusals for one batch, then the empty turn that closes it. So the message before the
// last one is a refusal exactly when this invoke ended in one — an OLDER refusal still in the thread
// (the reactive rollback keeps a call and its answer) cannot sit there, because every later invoke
// appends its own turn after it.
export function turnWasCalledOff(produced: readonly BaseMessage[]): boolean {
  const beforeLast = produced.at(-2);
  return beforeLast !== undefined && isCalledOffToolResult(beforeLast);
}
