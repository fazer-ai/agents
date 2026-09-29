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

// Where one attendance ends and the next begins, inside the contact's memory thread (keyed per
// contact-inbox). Pure: no model, no database, no clock. The invariants (docs/graph.md, Memory
// compaction):
//   1. The memory head is never part of the closed chunk: each attendance is summarized once.
//   2. Whole attendances only, found from the conversation stamped on each message, not the divider.
//   3. Nothing is closed just because the thread is long: a lone attendance is the open one.
//   4. Unless the caller says the current attendance ended (resolve), then all below the head closes.

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

  // NOTE: invariant 4: the caller vouches the conversation ended, so there is no open attendance.
  if (opts.currentAttendanceClosed) return { head, closed: body, open: [] };

  // The open attendance starts at the first message of the LAST stamped conversation's last
  // RUN. Asking for the start lets assistant replies go unstamped (each sits after its stamped human
  // turn). The run and not the first occurrence: a reopened conversation leaves stamps 1 … 2 … 1, and
  // the first `1` would close nothing, ever.
  const current = lastStampedConversationId(body);
  let start = -1;
  if (current !== null) {
    for (let i = body.length - 1; i >= 0; i--) {
      const m = body[i];
      if (m === undefined) continue;
      const stamp = stampedConversationId(m);
      if (stamp === null) continue;
      // NOTE: a different conversation ends the run; everything at or below it is over.
      if (stamp !== current) break;
      start = i;
    }
  }
  // NOTE: invariant 3: one attendance (or a thread that predates stamps) is all in progress. A
  // pre-stamp thread compacts on its next boundary, once a stamped message arrives.
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

// Renders the compacted memory as the thread's first message, oldest-first like the raw turns it
// replaces. Rides in a HumanMessage: see src/graph/markers.ts. `timezone` is the agent's own, the one
// {{data_atual}} renders in: UTC would date a 22:30 attendance in Sao Paulo on the next day.
export function renderMemoryHead(
  rows: SummaryRow[],
  timezone: string,
): HumanMessage | null {
  const kept = rows.slice(-MEMORY_HEAD_MAX_ATTENDANCES);
  const entries = kept
    .map((r) => {
      const text = r.summary.replace(FENCE_TAG, "").trim();
      if (!text) return null;
      // NOTE: no date beats a wrong one: the model reads this as fact.
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

// A head with no entries, which exists to carry the metadata that would otherwise be deleted with
// the messages when every summary is empty. When the attendance ended with a person still handling
// the conversation, the hand-back decision reads its evidence from that stamp; losing it silences
// the agent for good.
export function renderEmptyMemoryHead(): HumanMessage {
  return memoryHeadMessage(
    `${MEMORY_HEAD_OPEN}\n(Contexto do sistema: houve atendimentos anteriores com este contato, mas não há resumo deles.)\n${MEMORY_HEAD_CLOSE}`,
  );
}
