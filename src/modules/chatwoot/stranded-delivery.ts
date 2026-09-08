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
// This says whether a customer message was LOST, and nothing else. It does not answer, and neither
// does the sweep that consumes it: recovering the turn needs the gates the delivery path applies
// before a flush (test mode, availability, redirect) and none of them survive the process that died,
// so the sweep arms a DELIVERY_RECOVERY that re-runs that path where the gates already live (issue
// #295, ./recover-delivery.ts).
//
// A pure function of the row alone, and it got there by DELETION. What used to live here was a
// comparison against the conversation's watermarks, meant to tell a message a later burst covered
// from one nothing covered. Three review rounds each found a different way that fails, for one
// shared reason: a watermark is a per-CONVERSATION high-water mark and this is a per-MESSAGE
// question, so every scalar reading of it either closes a real loss or reports a covered message.
// The fact now comes from the only place that holds it — a turn that runs over a message retires
// that message's ledger row itself, so a row still non-terminal is one nothing covered. The sweep
// and that retirement are both in ./delivery-sweep.ts.

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
  // WHAT THIS DELIVERY OWED, when what it owed was the human-reply takeover (issue #439): the shape
  // the payload had, `composer` or `device`, written at INSERT. Null on every other delivery AND on
  // every row an older build wrote — which is why it is read only where the answer would otherwise
  // be the benign `no-message`, never as evidence about a customer message.
  humanReplyShape: string | null;
  // WHOSE ROUTE it arrived on (issue #476): true an observer's, false the responder's, null a row
  // written before the column or one stranded before the receiver could state it. Read only where
  // `humanReplyShape` already decided the row owed a side effect, to say WHICH side effect that is —
  // never as evidence about a customer message.
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
  // Stranded, but carried no inbound message — either its event could never carry one, or its event
  // could and this one did not (our own reply coming back around). Terminal and benign: nothing a
  // customer sent is at stake, so it must NOT appear in the list of lost messages.
  //
  // BENIGN IS ABOUT THE CUSTOMER'S MESSAGE, and it is not the same as "no effect was owed" — the
  // verdict below is what carries that other half.
  | "no-message"
  // Stranded carrying no customer message, and owing a HUMAN-REPLY TAKEOVER that never ran (issue
  // #439). The delivery is a colleague's own reply — from the composer or the paired phone — and
  // since issue #430 that is the delivery that steps the agent off the conversation. A process that
  // died in the detached window leaves the conversation `pending` and still the bot's, so the next
  // customer message drives a full turn and the agent answers over the person.
  //
  // A VERDICT OF ITS OWN because neither neighbour fits, in opposite directions. `no-message` closes
  // the row and replays nothing, which is what shipped and is the defect. `lost` is wrong twice
  // over: it marks the row DEAD and DISPATCHES an alert about a message nobody lost, and it arms a
  // recovery that spends a model turn answering a reply that was ours. What is owed here is a side
  // effect, and the recovery for it re-runs the takeover and nothing else.
  //
  // The SHAPE is not yet the route: `device` is also what an echo of our own reply looks like on a
  // provider that does not reserve its ids. That half is decided by the recovery, against the inbox
  // row (resolveHumanReplyRoute) — asking it here would mean reading an inbox per row inside a scan
  // sized for indexed queries, and answering it wrong in the safe direction costs the takeover this
  // verdict exists to recover.
  | "owed-takeover"
  // Stranded on an OBSERVER's route, carrying a colleague's reply (issue #476 review, round 27). It
  // owes no takeover: the handover steps the RESPONDER off the conversation, and an observer was
  // never on it. On an inbox with a responder of ours, that responder's own delivery of the same
  // reply carries the shape and owes the takeover there, so this row owes nothing at all; on an
  // inbox nobody of ours answers, there is no takeover to owe and no responder to hand back to.
  //
  // What it DID owe is the observer's ingestion — the colleague's reply folded into the memory the
  // observer keeps — and that cannot be recovered from here: the payload is never stored (issue
  // #228) and the delivery recovery needs a customer message id to anchor on, which a colleague's
  // reply has by construction not got. So the row is terminal like its neighbours and the gap is
  // REPORTED rather than replayed: on an observer-only inbox the observer's memory is the only one
  // there is, and a hole in it that nothing names is the silence this sweep exists to remove.
  | "observer-strand"
  // Stranded carrying a colleague's reply on a route NOTHING EVER NAMED (issue #540, window 2). The
  // process died between the INSERT and the claim, and this build writes `claimedAt` and
  // `routeObserved` in one statement — so an unclaimed row has no role because nothing was there to
  // state one, not because the answer was "the responder's".
  //
  // Read as `owed-takeover`, which is what shipped, the row is silently mis-served in one direction
  // only: on a WATCHER's route the takeover recovery correctly answers `not-owed` and reports
  // nothing, so the observer's lost ingestion — the whole of what that route owed — leaves no trace
  // anywhere. Read as `observer-strand` it would be mis-served in the other: on the far commoner
  // responder's route a real handover would never be armed, and the conversation stays with the bot
  // until the next human reply.
  //
  // So this verdict does BOTH honest things instead of guessing between them. It arms the takeover,
  // which is free where it was not owed — `recover-takeover.ts` re-asks every gate and answers
  // `not-owed` — and it files the gap line, so a watcher's missing memory is named rather than
  // silent. The uncertainty is in the line, where an operator reads it, rather than resolved by a
  // coin toss here.
  | "role-unstated"
  // Stranded carrying the TRANSCRIPTION of a customer message, on the `message_updated` that finally
  // wrote it (issue #478 review, round 1). A verdict of its own for the same reason `owed-takeover`
  // is one, and the two neighbours it sits between are the same two.
  //
  // `no-message` is what shipped and is the defect: the words are the message's only readable form
  // wherever nothing ran a turn at creation — an inaudible voice note, an observer with no responder
  // beside it, a conversation a colleague already owns — so closing the row benign loses the whole
  // of what the customer said, and loses it silently.
  //
  // `lost` is wrong in the other direction, and about the WORKLIST rather than about the words.
  // `DEAD` is the list of customers who wrote and were never answered, and nobody here is waiting on
  // a reply: on the routes this verdict is about, no reply was ever coming. What was owed is the
  // ingestion, and it is REPLAYABLE — unlike the observer's reply above, this delivery names a
  // message id and the words are still readable from the account, so the recovery re-runs the same
  // delivery path with the same event and the gates decide again exactly as they did.
  //
  // WHICH IS ALSO WHY IT IS SAFE ON THE ROWS IT OVER-COVERS. A ledger row cannot tell a transcription
  // nothing covered from the ordinary write-back of a message a turn already answered — the payload
  // is not stored — so both reach this verdict. Replaying the ordinary one costs nothing: the replay
  // is a `message_updated`, which drives no turn, and ../chatwoot/webhook.ts's ingest gate refuses a
  // message the bot answered. It is the REBUILD BEING FAITHFUL TO THE EVENT that makes that true; a
  // replay rebuilt as a creation would answer the customer twice.
  | "owed-transcription"
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
  const bears = bearsTurn(row);
  if (bears === "no") return "no-message";
  // NOTE: ANSWERED BEFORE THE LEGACY FENCE, and that ordering is the point rather than a shortcut: the
  // pair that identifies a transcription row (a `message_updated` naming an inbound message) is
  // itself proof this build wrote it, so its nulls are recorded and there is nothing for the fence
  // to protect. Asked after it, a transcription row stranded on PROCESSING without a stamp would be
  // called `lost` — the one answer it must never get, since no customer is waiting on a reply.
  if (bears === "transcription") return "owed-transcription";
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
    // NOTHING CLAIMED IT, SO NOTHING STATED THE ROLE (issue #540, window 2). Asked before the role
    // itself, because it is about whether the role column was ever WRITTEN rather than what it says:
    // the claim is the statement, and a row it never reached carries a null that records nothing.
    // True of every build, not only this one — a PENDING row is unclaimed whoever wrote it.
    if (row.claimedAt === null) return "role-unstated";
    // The ROLE decides which of the two, and it is read only here: a takeover is the responder's to
    // owe, and arming one for an observer's row spends a job that answers `not-owed` and reports
    // nothing (issue #476 review, round 27). Null HERE is a row the claim reached without stating a
    // role, which is an older build's — the receiver has stated it on every delivery since #476 —
    // and that is a population this build does not read as a watcher's.
    return row.routeObserved === true ? "observer-strand" : "owed-takeover";
  }
  return "lost";
}

// WHETHER THIS ROW COULD HAVE OWED A CUSTOMER AN ANSWER, from the two columns every build writes in
// the same way. `message_created` on its own, as it always has been. `message_updated` only when it
// also names an inbound message — the transcription that arrived on the write-back and was the
// message's only readable form (issue #478 review, round 1).
//
// The pair is what makes this safe to widen. `inboundMessageId` was written for `isNewIncomingMessage`
// and nothing else until this build, and that predicate requires `message_created`, so a
// `message_updated` row carrying one CANNOT come from an older build. Every legacy write-back keeps
// the null it has always had, falls through here and is closed benign exactly as before — which
// matters most on the rows a deploy strands in bulk, since the migration runs while the previous
// release is still serving.
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
