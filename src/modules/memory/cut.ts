import type { BaseMessage, HumanMessage } from "@langchain/core/messages";
import {
  isMemoryHead,
  lastStampedConversationId,
  MEMORY_HEAD_CLOSE,
  MEMORY_HEAD_OPEN,
  memoryHeadMessage,
  stampedConversationId,
} from "@/graph/markers";
import { formatWithPattern } from "@/graph/time";

// Where one attendance ends and the next begins, inside the contact's memory thread.
//
// The thread is keyed per contact-inbox, so it accumulates every conversation that contact ever had
// on that channel. Compaction replaces the raw turns of the attendances that ALREADY ENDED with one
// summary each, and this module answers the only question that decision needs: which messages belong
// to attendances that are over.
//
// Pure on purpose: no model, no database, no clock. Same reason as src/graph/history-window.ts — the
// rule is a decision, and a decision belongs in a table of cases rather than behind a job that also
// talks to a provider.
//
// THE FOUR INVARIANTS:
//
//   1. The memory head is never part of the closed chunk. It is rendered from attendance_summaries
//      on every compaction, so feeding it back to the summarizer would summarize a summary — the
//      compounding loss this whole design exists to avoid. Each attendance is summarized ONCE, from
//      its raw turns.
//   2. Whole attendances only. The cut lands where the CURRENT attendance starts, found from the
//      conversation stamped on each message (src/graph/markers.ts) — not from the divider, which is
//      prompt content that can be erased by a concurrent invoke or never written at all. Cutting
//      anywhere else would summarize half a conversation and leave the other half raw, describing the
//      same events twice.
//   3. Nothing is closed just because the thread is long. Without a later attendance, the only
//      attendance present is the open one, and the answer is "nothing to compact" — the ceiling
//      (src/graph/history-window.ts) is what bounds a single endless attendance, not this.
//   4. Except when the caller knows the current attendance itself ended (the resolve trigger), in
//      which case everything below the head is closed and the thread compacts down to the head
//      alone. That is the case worth having: it makes the RESUMPTION turn cheap, which measurement
//      showed is the turn that is billed fresh (cache rate ~0% past 24h).

export interface AttendanceCut {
  // The memory head already sitting at the front of the thread, if there is one. Returned so the
  // caller can tell "no head yet" from "head rebuilt", never to be re-summarized (invariant 1).
  head: BaseMessage | null;
  // Messages of attendances that are over. Empty means there is nothing to compact.
  closed: BaseMessage[];
  // Messages of the attendance still in progress. They travel untouched.
  open: BaseMessage[];
}

export function selectClosedPrefix(
  messages: BaseMessage[],
  opts: { currentAttendanceClosed: boolean },
): AttendanceCut {
  const first = messages[0];
  const hasHead = first !== undefined && isMemoryHead(first);
  const head = hasHead ? (first as BaseMessage) : null;
  const body = hasHead ? messages.slice(1) : messages;

  // NOTE: Invariant 4 — the caller vouches that the conversation this thread is on has ended, so
  // there is no open attendance to protect.
  if (opts.currentAttendanceClosed) return { head, closed: body, open: [] };

  // The open attendance is whatever the LAST stamped message belongs to, and it starts at the first
  // message of that conversation's LAST RUN — the earliest one not separated from the end by some
  // other conversation. Asking where it starts (rather than where the previous one ended) is what
  // lets assistant replies go unstamped: they are generated inside the graph, and every one of them
  // sits after the stamped human turn of its own attendance, so the scan simply walks past them.
  //
  // The run, and not the first occurrence anywhere: a conversation can be REOPENED after another one
  // has already run on this thread (an operator picking an old conversation back up, a human agent
  // replying in it), which leaves stamps reading 1 … 2 … 1. Taking the first `1` put the start at the
  // top of the thread, so nothing was ever closed and the ended attendances stayed raw in every
  // prompt from then on — silently, and permanently, since no later boundary changes the answer.
  // Threads carrying several raw attendances at once are exactly where this shows up: compaction
  // newly enabled, or a run that kept failing.
  const current = lastStampedConversationId(body);
  let start = -1;
  if (current !== null) {
    for (let i = body.length - 1; i >= 0; i--) {
      const m = body[i];
      if (m === undefined) continue;
      const stamp = stampedConversationId(m);
      if (stamp === null) continue;
      // A different conversation ends the run: everything at or below it belongs to an attendance
      // that is over.
      if (stamp !== current) break;
      start = i;
    }
  }
  // NOTE: Invariant 3 — one attendance (or a thread written before stamps existed) means everything
  // present belongs to the attendance in progress. A thread that predates stamps compacts on its next
  // boundary, when the first stamped message arrives.
  if (start <= 0) return { head, closed: [], open: body };
  return { head, closed: body.slice(0, start), open: body.slice(start) };
}

// How many attendances the head carries. The rows are all kept; this bounds what the MODEL reads, so
// a contact with a long history does not spend its whole budget on memory. The oldest fall off the
// front, which is the same order a person forgets in.
export const MEMORY_HEAD_MAX_ATTENDANCES = 20;

// Anything a summary could contain that reads as the fence's own tag, in every spelling it could
// take. A summary is model output derived from customer text, so it is not trusted to stay inside
// the block it was put in.
const FENCE_TAG = /<\s*\/?\s*(atendimento|atendimentos-anteriores)[^>]*>/gi;

export interface SummaryRow {
  conversationId: number;
  summary: string;
  // When the ATTENDANCE happened, not when its summary was written. Compaction can run months after
  // the fact, and a memory dated by the job would tell the model a returning customer's history
  // happened today. NULL when the mirrored conversation is gone and there is nothing to read the
  // date off: the line then renders WITHOUT a date rather than carrying a manufactured one.
  attendanceAt: Date | null;
}

// Renders the compacted memory as the thread's first message. Ordered oldest-first, which is how the
// raw turns it replaces were ordered. Rides in a HumanMessage: see src/graph/markers.ts.
// `timezone` is the agent's own (AgentConfig.timezone, from its BusinessHours). Dating in UTC instead
// would put an attendance from 22:30 on the 19th in Sao Paulo on the 20th, and that wrong date then
// rides in every future prompt as fact. It is also the timezone {{data_atual}} already renders in, so
// the model would otherwise be reading two calendars at once.
export function renderMemoryHead(
  rows: SummaryRow[],
  timezone: string,
): HumanMessage | null {
  const kept = rows.slice(-MEMORY_HEAD_MAX_ATTENDANCES);
  const entries = kept
    .map((r) => {
      const text = r.summary.replace(FENCE_TAG, "").trim();
      if (!text) return null;
      // No date is a real answer here, and a better one than today's: the model reads this as fact,
      // and "this happened today" about an attendance from March is worse than not saying when.
      if (r.attendanceAt === null)
        return `<atendimento>\n${text}\n</atendimento>`;
      const date = formatWithPattern(r.attendanceAt, timezone, "YYYY-MM-DD");
      return `<atendimento data="${date}">\n${text}\n</atendimento>`;
    })
    .filter((e): e is string => e !== null);
  if (entries.length === 0) return null;
  return memoryHeadMessage(
    `${MEMORY_HEAD_OPEN}\n(Contexto do sistema: resumos de atendimentos já encerrados com este mesmo contato, do mais antigo para o mais recente. É memória de conversas passadas, não o assunto atual.)\n${entries.join("\n")}\n${MEMORY_HEAD_CLOSE}`,
  );
}
