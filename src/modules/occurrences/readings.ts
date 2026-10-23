import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn } from "@/lib/tenancy";
import { clipText, makeStorable } from "@/lib/text";
import { sysCtx } from "./config";

// A reading's value as stored: trimmed and capped. Empty is a value of its own ("read, nothing
// there"): an empty reference is the no-reference bucket, an empty reason is a conversation with
// nothing to group. Only a field the observer did not mention is left as it was.
export const READING_VALUE_MAX = 500;

export function readingValue(raw: string): string {
  // A model's text can carry what a `text` column refuses (a NUL, half of a surrogate pair), and one
  // refused value would lose the whole call's readings.
  return clipText(
    makeStorable(raw.replace(/\s+/g, " ").trim()),
    READING_VALUE_MAX,
  );
}

// One row per conversation and field. A new value replaces the old one and moves `last_read_at`;
// `first_read_at` stays the instant the conversation was first read for that field, which is what
// "new conversations in the window" counts. Rewriting the same value only moves `last_read_at`.

// Thrown inside the write when the caller's time ran out, so the transaction rolls back.
// `/reset` empties the conversation's Chatwoot attributes on purpose: a canonical copy still pending
// for one of its readings must not write the reference back. Marked before the attributes are cleared,
// so a copy queued behind the reset finds nothing to copy; the next reading the observer writes, in
// the new episode, makes it pending again.
export async function withdrawReadingCopies(
  base: PrismaClient,
  tenantId: bigint,
  conversationId: bigint,
): Promise<void> {
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversationReading.updateMany({
      where: { conversationId, canonicalWritten: false },
      data: { canonicalWritten: true },
    }),
  );
}

// The conversation's `/reset` mark as a reading's observation starts, before its Chatwoot write. The
// write compares it again under the conversation's row lock (`upsertReadings`): a reset that moved it
// in between cleared, or is about to clear, what the observation copied there.
export async function readResetMark(
  base: PrismaClient,
  tenantId: bigint,
  conversationId: bigint,
): Promise<number | null> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findUnique({
      where: { id: conversationId },
      select: { resetAtMessageId: true },
    }),
  );
  return row?.resetAtMessageId ?? null;
}

export class ReadingsExpiredError extends Error {
  constructor() {
    super("the observation's time ran out before its readings committed");
    this.name = "ReadingsExpiredError";
  }
}

// The names Chatwoot may hold once a reading's value changes: the copy's name when it wrote one (else
// every spelling before it since then) and the value itself, the newest last, at most
// REMOTE_BEFORE_MAX of them.
export const REMOTE_BEFORE_MAX = 5;
function remoteBeforeOf(before: {
  value: string;
  writtenName: string | null;
  remoteBefore: string[];
}): string[] {
  const since =
    before.writtenName !== null ? [before.writtenName] : before.remoteBefore;
  const names = [...since.filter((n) => n !== before.value), before.value];
  return names.slice(-REMOTE_BEFORE_MAX);
}

// `expired`, when given, is asked before each write and again before the commit: an observation that
// ran out of time while waiting for a connection or a statement writes nothing.
export async function upsertReadings(
  base: PrismaClient,
  tenantId: bigint,
  conversationId: bigint,
  agentId: bigint | null,
  values: Record<string, string>,
  now: Date = new Date(),
  expired?: () => boolean,
  resetMark?: number | null,
): Promise<void> {
  const entries = Object.entries(values);
  if (entries.length === 0) return;
  const fence = () => {
    if (expired?.()) throw new ReadingsExpiredError();
  };
  await runScopedOn(base, sysCtx(tenantId), async (db) => {
    // Under the row lock the reset takes to move its mark, and before its withdrawal: a mark that
    // moved since the observation started means the reset's withdrawal may have missed these rows,
    // so they are stored with their copy already withdrawn.
    let withdrawn = false;
    if (resetMark !== undefined) {
      const [live] = await db.$queryRaw<
        { reset_at_message_id: number | null }[]
      >`
        SELECT reset_at_message_id FROM conversations WHERE id = ${conversationId}
        FOR UPDATE`;
      withdrawn = (live?.reset_at_message_id ?? null) !== resetMark;
    }
    for (const [field, value] of entries) {
      fence();
      // Locked, so a copy marking its name cannot commit between this read and the write below: the
      // names Chatwoot may still hold are derived from the row as it stands, and a copy that comes
      // after finds the reading changed and keeps its name among them (`rememberPosted`).
      const [row] = await db.$queryRaw<
        {
          value: string;
          written_name: string | null;
          remote_before: string[];
        }[]
      >`
        SELECT value, written_name, remote_before FROM conversation_readings
        WHERE conversation_id = ${conversationId} AND field = ${field}
        FOR UPDATE`;
      const before = row
        ? {
            value: row.value,
            writtenName: row.written_name,
            remoteBefore: row.remote_before,
          }
        : null;
      const changed = before !== null && before.value !== value;
      await db.conversationReading.upsert({
        where: { conversationId_field: { conversationId, field } },
        create: {
          tenantId,
          conversationId,
          field,
          value,
          agentId,
          firstReadAt: now,
          lastReadAt: now,
          canonicalWritten: withdrawn,
        },
        // A new value is a new spelling: its canonical is the canonical step's to decide again, and
        // an emptied reference falls into the no-reference bucket. What Chatwoot may still hold is kept (the
        // copy's name, or every spelling since it, as each observer write may have failed), so a copy
        // can tell that leftover from a newer write. Any write put the observer's spelling in
        // Chatwoot, so the canonical is copied there again.
        update: {
          value,
          agentId,
          lastReadAt: now,
          canonicalWritten: withdrawn,
          ...(changed
            ? {
                canonicalId: null,
                writtenName: null,
                remoteBefore: remoteBeforeOf(before),
                copyTriedAt: null,
              }
            : {}),
        },
      });
    }
    fence();
  });
}
