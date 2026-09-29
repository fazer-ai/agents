// What a ledger row still stuck on PENDING or PROCESSING means, long after its attempt started. The
// 200 is out before `processChatwootDelivery`'s CAS `PENDING -> PROCESSING` and its final
// `-> PROCESSED`, so a process that dies in between leaves a row nothing works, Chatwoot does not
// redeliver, and the customer's message is never answered. An ordinary exception does NOT strand a
// row: the agent turn, the eager media pass and the mirror write are each caught. This says only
// whether a customer message was LOST. Neither it nor the sweep answers: the delivery path's gates
// (test mode, availability, redirect) die with the process, so the sweep arms a DELIVERY_RECOVERY
// that re-runs that path (./recover-delivery.ts). Why: docs/chatwoot.md, "Webhook receiver".

import type { HumanReplyRoute } from "./normalize";
import { LATE_TRANSCRIPTION_EVENT, TURN_BEARING_EVENT } from "./normalize";

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
  // legitimate delivery, and a redelivery is allowed to claim a row left stranded on PENDING, so an
  // attempt that started a minute ago must not be judged by a receipt from an hour ago.
  claimedAt: Date | null;
  // The conversation this delivery was about. Written at INSERT by every build that has the column,
  // for every event that names one, which on the receiver is every event that reaches the ledger
  // at all. Null therefore means one of two things, and the pair below tells them apart.
  conversationId: number | null;
  // The INBOUND message this delivery carried, when it carried one. Null on every event that is not
  // a customer message (a conversation update, the bot's own reply coming back around), and those
  // are the rows where nothing was lost no matter how long they sat.
  inboundMessageId: number | null;
  // What this delivery owed, when what it owed was the human-reply takeover: the shape the payload
  // had, `composer` or `device`, written at INSERT. Null on every other delivery AND on every row an
  // older build wrote, which is why it is read only where the answer would otherwise be the benign
  // `no-message`, never as evidence about a customer message.
  humanReplyShape: string | null;
  // Whose route it arrived on: true an observer's, false the responder's, null a row written before
  // the column or one stranded before the receiver could state it. Read only where `humanReplyShape`
  // already decided the row owed a side effect, to say WHICH one; never as evidence about a customer
  // message.
  routeObserved: boolean | null;
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
  // Stranded, but carried no inbound message: either its event could never carry one, or its event
  // could and this one did not (our own reply coming back around). Terminal and benign: nothing a
  // customer sent is at stake, so it must NOT appear in the list of lost messages.
  //
  // BENIGN IS ABOUT THE CUSTOMER'S MESSAGE, and it is not the same as "no effect was owed": the
  // verdict below is what carries that other half.
  | "no-message"
  // Stranded carrying no customer message, and owing a HUMAN-REPLY TAKEOVER that never ran: a
  // colleague's reply steps the agent off, and a death in the detached window leaves the conversation
  // `pending` and the bot's, so the next customer message drives a turn that answers over the person.
  // Not `no-message` (replays nothing) and not `lost` (DEAD, an alert about a message nobody lost, and
  // a model turn answering our own reply). `device` is also what an unreserved echo of our own reply
  // looks like; the recovery decides that against the inbox (`resolveHumanReplyRoute`), since an inbox
  // read per row does not belong in an indexed scan and a safe-side guess here costs the takeover.
  | "owed-takeover"
  // Stranded on an OBSERVER's route, carrying a colleague's reply. It owes no takeover: the handover
  // steps the RESPONDER off (whose own delivery of the reply owes it), and an observer was never on it.
  // What it can owe is the observer's ingestion, and only beside a responder of ours whose memory it
  // shares (beside none the route folds nothing in, `route_remembers = false`). That is recoverable:
  // the ledger names the reply (`humanReplyMessageId`), so ./recover-human-reply.ts reads the words
  // back by id. The row stays terminal, since `DEAD` is the worklist of customers nobody answered, and
  // the memory job is armed beside it.
  | "observer-strand"
  // Stranded carrying a colleague's reply on a route NOTHING EVER NAMED: the process died between the
  // INSERT and the claim, which writes `claimedAt` and `routeObserved` together, so the null role
  // records nothing. As `owed-takeover`, a watcher's lost ingestion would leave no trace (the takeover
  // recovery answers `not-owed` silently); as `observer-strand`, a real handover on the far commoner
  // responder's route would never be armed. So it does both: arms the takeover, free where not owed
  // (./recover-takeover.ts re-asks every gate), and files the gap line, so the operator reads the
  // uncertainty rather than a coin toss.
  | "role-unstated"
  // Stranded carrying the TRANSCRIPTION of a customer message, on the `message_updated` that wrote it.
  // Not `no-message`: wherever nothing ran a turn at creation (an inaudible voice note, an observer
  // with no responder, a conversation a colleague owns) the words are the message's only readable
  // form, and closing the row loses them silently. Not `lost`: `DEAD` lists customers awaiting a reply
  // and none is. The ingestion is REPLAYABLE (the row names the message), and safe on the ordinary
  // write-backs this over-covers: the replay is a `message_updated`, which drives no turn, and
  // ./webhook.ts's ingest gate refuses a message the bot answered. A replay rebuilt as a creation would
  // answer the customer twice.
  | "owed-transcription"
  // Stranded with a customer message nothing ever covered, or stranded by a build whose columns
  // cannot be read. Nothing will answer it.
  //
  // There is no "already covered" verdict, and its absence is the design rather than an omission: a
  // message a later turn ran over never reaches this function at all, because that turn retired its
  // row and the scan only sees non-terminal ones.
  | "lost";

// A pure function of the row alone. A watermark is a per-CONVERSATION high-water mark and this is a
// per-MESSAGE question, so every comparison against one either closes a real loss or reports a
// covered message. Instead a turn that runs over a message retires that message's ledger row itself,
// so a row still non-terminal is one nothing covered. The sweep and that retirement are both in
// ./delivery-sweep.ts.
export function classifyStrandedDelivery(
  row: StrandedDeliveryRow,
  policy: StrandedDeliveryPolicy,
): StrandedVerdict {
  const age =
    policy.now.getTime() - (row.claimedAt ?? row.receivedAt).getTime();
  if (age < policy.staleAfterMs) return "in-flight";
  // NOTE: an event that could never have owed a turn never lost one. Asked BEFORE the fence below
  // because the event name is the one column no migration added, so this answers for older builds'
  // rows too. `AgentBotListener` dispatches seven events (`conversation_resolved`, `_opened`,
  // `_status_changed`, `_updated`, `message_created`, `message_updated`, `webwidget_triggered`), and
  // `webwidget_triggered` carries a contact_inbox and no conversation, so it reaches the ledger with
  // both ids null and no stamp: the signature the fence reads as "a build we cannot read". See
  // docs/chatwoot.md, "Webhook receiver".
  const bears = bearsTurn(row);
  if (bears === "no") return "no-message";
  // NOTE: ANSWERED BEFORE THE LEGACY FENCE, and that ordering is the point rather than a shortcut: the
  // pair that identifies a transcription row (a `message_updated` naming an inbound message) is
  // itself proof this build wrote it, so its nulls are recorded and there is nothing for the fence
  // to protect. Asked after it, a transcription row stranded on PROCESSING without a stamp would be
  // called `lost`, the one answer it must never get, since no customer is waiting on a reply.
  if (bears === "transcription") return "owed-transcription";
  // NOTE: a row this build never touched, whose nulls are UNRECORDED rather than "nothing was there".
  // Read literally, every message the previous release lost would be closed as carrying none, on the
  // rows a deploy most likely strands (the migration runs while that release still serves). One
  // signature per state: tx1 stamps the claim on every row this build works, so PROCESSING without one
  // is an older build's; nothing claims a PENDING row, so there the conversation (written at INSERT
  // for every event that reaches the ledger) is what speaks.
  if (
    row.claimedAt === null &&
    (row.status === "PROCESSING" || row.conversationId === null)
  ) {
    return "lost";
  }
  if (row.inboundMessageId === null) {
    // The one place the column is read, and only from the arm that was already going to answer
    // benign: a row that carries a customer message is `lost` whatever it also owed, because the
    // recovery for THAT re-runs the delivery path, takeover included.
    if (
      !isHumanReplyShape(row.humanReplyShape) ||
      row.conversationId === null
    ) {
      return "no-message";
    }
    // NOTE: nothing claimed it, so nothing stated the role. Asked before the role itself because it is
    // about whether the column was ever WRITTEN: the claim is the statement, and a row it never
    // reached carries a null that records nothing, whoever wrote it.
    if (row.claimedAt === null) return "role-unstated";
    // NOTE: the ROLE decides which of the two, read only here: a takeover is the responder's to owe,
    // and arming one for an observer's row spends a job that answers `not-owed` and reports nothing.
    // Null HERE is a row the claim reached without stating a role, an older build's, not a watcher's.
    return row.routeObserved === true ? "observer-strand" : "owed-takeover";
  }
  return "lost";
}

// Whether this row could have owed a customer an answer, from the two columns every build writes the
// same way: `message_created` on its own, and `message_updated` only when it also names an inbound
// message (the transcription that was the message's only readable form). Safe to widen because an
// older build writes `inboundMessageId` only for `isNewIncomingMessage`, which requires
// `message_created`, so its `message_updated` rows carry null and close benign.
function bearsTurn(
  row: StrandedDeliveryRow,
): "no" | "message" | "transcription" {
  if (row.event === TURN_BEARING_EVENT) return "message";
  if (row.event === LATE_TRANSCRIPTION_EVENT && row.inboundMessageId !== null)
    return "transcription";
  return "no";
}

// Whether the stored shape is one this build can act on. A String column rather than an enum, like
// `event` beside it, so the reader answers for what is actually in the row: null from an older
// build, and anything else from a build that spells a shape this one does not know.
export function isHumanReplyShape(v: string | null): v is HumanReplyRoute {
  return v === "composer" || v === "device";
}
