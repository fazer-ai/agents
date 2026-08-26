// What a ledger row still stuck on PENDING or PROCESSING means, long after the attempt that claimed
// it started.
//
// `processChatwootDelivery` brackets its work between a CAS `PENDING -> PROCESSING` and a final
// `-> PROCESSED`, and the 200 is already out before either runs. A process that dies anywhere in
// there leaves a non-terminal row with nothing working it: Chatwoot will not redeliver, and a
// redelivery would CAS against `PENDING` and match nothing. The customer's message is never
// answered, and the only trace is a row nobody reads (issue #228).
//
// Measured, on this repo's own code: an interruption injected between the two CAS points leaves
// `status = PROCESSING, attempts = 0`, and a second call for the same row returns "skipped". An
// ordinary exception does NOT reach here — the agent turn, the eager media pass and the mirror write
// are each caught, so the delivery still reaches PROCESSED.
//
// This says whether a customer message was LOST, and nothing else. It does not answer, and the sweep
// that consumes it does not either — recovering the turn needs the gates the delivery path applies
// before a flush (test mode, availability, redirect) and none of them survive the process that died.
// That is issue #295.
//
// A pure function of the row alone, and it got there by DELETION. What used to live here was a
// comparison against the conversation's watermarks, meant to tell a message a later burst covered
// from one nothing covered. Three review rounds each found a different way that fails, for one
// shared reason: a watermark is a per-CONVERSATION high-water mark and this is a per-MESSAGE
// question, so every scalar reading of it either closes a real loss or reports a covered message.
// The fact now comes from the only place that holds it — a turn that runs over a message retires
// that message's ledger row itself, so a row still non-terminal is one nothing covered. The sweep
// and that retirement are both in ./delivery-sweep.ts.

import { TURN_BEARING_EVENT } from "./normalize";

export interface StrandedDeliveryRow {
  // The Chatwoot event name, as the receiver stored it. The one column here that EVERY build has
  // written, which is why it is read before the fence for builds that wrote the others.
  event: string;
  // Which non-terminal state it is stuck in. Both strand, but only one of them carries a promise
  // about the other columns (see `claimedAt`).
  status: "PENDING" | "PROCESSING";
  receivedAt: Date;
  // When the CURRENT attempt claimed the row, or null when nothing has. A row is not stranded
  // because it is old, it is stranded because nothing has moved it for longer than the longest
  // legitimate delivery — and a redelivery is allowed to claim a row left stranded on PENDING, so an
  // attempt that started a minute ago must not be judged by a receipt from an hour ago.
  claimedAt: Date | null;
  // The conversation this delivery was about. Written at INSERT by every build that has the column,
  // for every event that names one — which, on the receiver, is every event that reaches the ledger
  // at all. Null therefore means one of two things, and the pair below tells them apart.
  conversationId: number | null;
  // The INBOUND message this delivery carried, when it carried one. Null on every event that is not
  // a customer message — a conversation update, the bot's own reply coming back around — and those
  // are the rows where nothing was lost no matter how long they sat.
  inboundMessageId: number | null;
}

export interface StrandedDeliveryPolicy {
  now: Date;
  // How long a row may sit non-terminal before it counts as abandoned rather than in flight.
  staleAfterMs: number;
}

export type StrandedVerdict =
  // The current attempt started recently enough that a live process may still be working it. Left
  // alone.
  | "in-flight"
  // Stranded, but carried no inbound message — either its event could never carry one, or its event
  // could and this one did not (our own reply coming back around). Terminal and benign: nothing a
  // customer sent is at stake, so it must NOT appear in the list of lost messages.
  | "no-message"
  // Stranded with a customer message nothing ever covered, or stranded by a build whose columns
  // cannot be read. Nothing will answer it.
  //
  // There is no "already covered" verdict, and its absence is the design rather than an omission: a
  // message a later turn ran over never reaches this function at all, because that turn retired its
  // row and the scan only sees non-terminal ones.
  | "lost";

export function classifyStrandedDelivery(
  row: StrandedDeliveryRow,
  policy: StrandedDeliveryPolicy,
): StrandedVerdict {
  const age =
    policy.now.getTime() - (row.claimedAt ?? row.receivedAt).getTime();
  if (age < policy.staleAfterMs) return "in-flight";
  // An event that could never have owed a turn never lost one, and this is asked BEFORE the fence
  // below because the event name is the one column no migration added: a row an older build wrote
  // still names its event, so this answers for those rows too, which is the population the fence
  // exists for.
  //
  // MEASURED against the local Chatwoot fork (4.16.0), by pointing a real Agent Bot at a capture
  // endpoint: `AgentBotListener` dispatches exactly seven events, and `contact_created` is not among
  // them. They are `conversation_resolved`, `conversation_opened`, `conversation_status_changed`,
  // `conversation_updated`, `message_created`, `message_updated` and `webwidget_triggered`.
  //
  // Six of the seven name a conversation, so a row THIS build wrote for them already fails the
  // message-id check below. The seventh does not: `webwidget_triggered` carries a CONTACT_INBOX
  // (observed: top-level `id` = 69, the contact_inbox id, and no `conversation` key at all), and
  // `normalize.ts` reads a conversation id from nothing but the two shapes that are a conversation
  // or a message (issue #257) — so it reaches the ledger with BOTH ids null and, if the process dies
  // before the claim, no stamp either: byte for byte the signature the fence below reads as "a build
  // we cannot read".
  //
  // The other population this answers for is every event an OLDER build wrote, which is the one the
  // fence exists for and the one a rollout produces in bulk. A `message_updated` is that story from
  // the other direction — our own media write-back coming around, driving no turn — which is why the
  // name it shares with `isNewIncomingMessage` is one constant and not two.
  if (row.event !== TURN_BEARING_EVENT) return "no-message";
  // A row this build never touched, whose nulls are UNRECORDED rather than "nothing was there". Read
  // the literal way, every message the previous release lost would be closed as carrying none — the
  // exact silence this sweep exists to remove, on the rows a deploy is most likely to strand, since
  // the migration runs while that release is still serving and it writes none of these columns.
  //
  // Two signatures, one per state, because each state promises a different column. tx1 stamps the
  // claim on every row this build works, so a PROCESSING row without one was claimed by an older
  // build. Nothing has claimed a PENDING row, so the stamp says nothing there — what does is the
  // conversation, written at INSERT for every event that reaches the ledger.
  if (
    row.claimedAt === null &&
    (row.status === "PROCESSING" || row.conversationId === null)
  ) {
    return "lost";
  }
  if (row.inboundMessageId === null) return "no-message";
  return "lost";
}
