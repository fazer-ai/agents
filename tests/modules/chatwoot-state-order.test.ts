import { describe, expect, test } from "bun:test";
import {
  decideConversationWrites,
  type StateDecision,
  type StatePayload,
  type StateRow,
} from "@/modules/chatwoot/state-order";

// The ordering rules as a table. Every row states one rule from the header of `state-order.ts`;
// the mirror's DB-backed suite then proves the writes follow the decision, not that the decision
// is right. Times are minutes apart so a `last_activity_at` difference is never ambiguous.
const NOW = new Date("2026-08-15T12:00:00.000Z");
const EARLIER = new Date("2026-08-15T11:00:00.000Z");
const LATER = new Date("2026-08-15T11:30:00.000Z");

// Versions are raw unix-seconds doubles, sub-second apart on purpose: the whole point of the
// version is resolving a burst that shares one `last_activity_at` second.
const V_OLD = 1_776_000_000.101;
const V_NOW = 1_776_000_000.202;
const V_NEW = 1_776_000_000.303;
// A claim's deadline, either side of the caller's clock. `decideConversationWrites` is handed `NOW`,
// so these are what "still standing" and "ran out" look like to it.
const CLAIM_LIVE = new Date(NOW.getTime() + 30_000);
const CLAIM_EXPIRED = new Date(NOW.getTime() - 1);

const ALL_STATED = {
  labels: true,
  customAttributes: true,
  conversationType: true,
  kanbanAttributes: true,
};

function marks(v: number | null) {
  return {
    labels: v,
    customAttributes: v,
    conversationType: v,
    kanbanAttributes: v,
  };
}

// Every fact written and stamped with `at`, or every fact left alone. A fresh object per key: Bun's
// `toMatchObject` stops comparing an expected object it has already visited, so one object shared by
// the four keys is checked against the first of them only.
function allFacts(write: boolean, at: number | null = null) {
  return {
    labels: { write, at },
    customAttributes: { write, at },
    conversationType: { write, at },
    kanbanAttributes: { write, at },
  };
}

const ALL_RELATIONS = { contact: true, contactInbox: true, inbox: true };

function relationMarks(v: number | null) {
  return { contact: v, contactInbox: v, inbox: v };
}

// Fresh objects per key, for the reason `allFacts` gives.
function allRelations(write: boolean, at: number | null = null) {
  return {
    contact: { write, at },
    contactInbox: { write, at },
    inbox: { write, at },
  };
}

function conversationEvent(over: Partial<StatePayload> = {}): StatePayload {
  return {
    version: V_NEW,
    activityAt: LATER,
    fromConversationEvent: true,
    reopensConversation: false,
    status: "resolved",
    assigneeStated: true,
    assigneeType: "User",
    redirectOriginCleared: false,
    redirectOriginStated: false,
    ownershipChangeStated: false,
    assigneeId: null,
    factsStated: ALL_STATED,
    kanbanCardId: null,
    kanbanCardAt: null,
    relationsStated: ALL_RELATIONS,
    ...over,
  };
}

function messageEvent(over: Partial<StatePayload> = {}): StatePayload {
  return conversationEvent({
    fromConversationEvent: false,
    version: V_NEW,
    ...over,
  });
}

function storedRow(over: Partial<StateRow> = {}): StateRow {
  return {
    status: "open",
    activityAt: LATER,
    statusAt: V_NOW,
    assigneeAt: V_NOW,
    assigneeType: "AgentBot",
    redirectOriginAt: null,
    redirectOriginKnown: false,
    statusClaimUntil: null,
    statusClaimFrom: null,
    statusClaimStampedAt: null,
    statusClaimRefusedAt: null,
    ownershipChangedAt: null,
    assigneeId: null,
    factMarks: marks(null),
    kanbanCardId: null,
    kanbanCardAt: null,
    redirectOriginClearedAt: null,
    relationMarks: relationMarks(null),
    relationsStored: ALL_RELATIONS,
    ...over,
  };
}

interface Case {
  name: string;
  payload: StatePayload;
  row: StateRow | null;
  want: Partial<StateDecision>;
}

const CASES: Case[] = [
  // The tail of a handoff burst carries the pre-handoff snapshot.
  {
    name: "a message snapshot writes no status and no assignee, however recent it is",
    payload: messageEvent({
      activityAt: NOW,
      status: "open",
      assigneeType: null,
    }),
    row: storedRow({ assigneeType: "User" }),
    want: { stale: false, status: null, assignee: false },
  },
  {
    name: "a message snapshot claims neither version mark",
    payload: messageEvent({ activityAt: NOW, status: "open" }),
    row: storedRow(),
    want: { statusAt: null, assigneeAt: null },
  },
  {
    name: "a message snapshot still mirrors the relations",
    payload: messageEvent({ activityAt: NOW }),
    row: storedRow(),
    want: { relations: allRelations(true, V_NEW) },
  },
  // The one transition a message carries faithfully, because Chatwoot performs it before dispatch.
  {
    name: "a brand-new incoming message reopens: status only",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "open",
      assigneeType: null,
    }),
    row: storedRow({ assigneeType: "User" }),
    want: { status: "open", assignee: false },
  },
  // A reopen is faithful AT ITS OWN INSTANT, and every payload is a snapshot of an earlier one:
  // Chatwoot freezes its own at enqueue, and a delivery recovery rebuilds one from reads made a
  // moment before. Unordered, a message serialized before an operator's resolve would walk the status
  // back to `open` after it.
  {
    // Only the status mark can refuse this: the payload is ahead of the row's activity (not
    // stale), and its status mark sits an hour later, as a resolve leaves it (a resolve moves
    // `updated_at` and never `last_activity_at`).
    name: "a reopen from a second BEHIND the status mark does not walk it back",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "open",
    }),
    row: storedRow({
      activityAt: LATER,
      statusAt: NOW.getTime() / 1000 + 3600,
    }),
    want: { status: null },
  },
  {
    // The mark carries a fraction (`updated_at`) and the message whole seconds
    // (`last_activity_at`), so within one burst the mark is a little ahead of the message it
    // accompanies. Compared raw, every same-second reopen would lose to its own companion.
    name: "a reopen in the SAME second as the status mark still wins",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "open",
    }),
    row: storedRow({
      activityAt: LATER,
      statusAt: NOW.getTime() / 1000 + 0.202,
    }),
    want: { status: "open" },
  },
  {
    name: "the reopen claims the status mark and leaves the assignee mark behind",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "open",
    }),
    row: storedRow(),
    want: { statusAt: V_NEW, assigneeAt: null },
  },

  // Ordering conversation events among themselves, by version alone.
  {
    name: "a conversation event behind BOTH marks is stale",
    payload: conversationEvent({ version: V_OLD }),
    row: storedRow(),
    want: {
      stale: true,
      status: null,
      assignee: false,
      relations: allRelations(false),
    },
  },
  {
    name: "behind the status mark but not the assignee mark: not stale, assignee only",
    payload: conversationEvent({ version: V_OLD }),
    row: storedRow({ assigneeAt: V_OLD }),
    want: { stale: false, status: null, assignee: true },
  },
  {
    name: "behind the assignee mark but not the status mark: status only",
    payload: conversationEvent({ version: V_OLD }),
    row: storedRow({ statusAt: V_OLD }),
    want: { stale: false, status: "resolved", assignee: false },
  },
  {
    name: "a delayed handoff (newer version, older last_activity_at) applies its state",
    payload: conversationEvent({ activityAt: EARLIER }),
    row: storedRow({ activityAt: LATER }),
    want: { stale: false, status: "resolved", assignee: true },
  },
  {
    name: "...and its relations stay silent, so a newer payload's relations survive",
    payload: conversationEvent({ activityAt: EARLIER }),
    row: storedRow({ activityAt: LATER }),
    want: { relations: allRelations(false) },
  },
  {
    name: "a versioned event against a migrated row (no marks) applies",
    payload: conversationEvent({ activityAt: EARLIER }),
    row: storedRow({ statusAt: null, assigneeAt: null, activityAt: LATER }),
    want: { stale: false, status: "resolved", assignee: true },
  },

  // The equal-version rule, so the outcome cannot depend on delivery order.
  {
    name: "an equal version applies (>=, not >), so a write's second companion is not dropped",
    payload: conversationEvent({ version: V_NOW }),
    row: storedRow(),
    want: { stale: false, status: "resolved", assignee: true },
  },
  {
    name: "at an equal version an assignee may be SET",
    payload: conversationEvent({ version: V_NOW, assigneeType: "User" }),
    row: storedRow({ assigneeType: null }),
    want: { assignee: true },
  },
  {
    name: "at an equal version an assignee may NOT be cleared (null is the degraded reading)",
    payload: conversationEvent({ version: V_NOW, assigneeType: null }),
    row: storedRow({ assigneeType: "User" }),
    want: { assignee: false },
  },
  {
    name: "at a STRICTLY greater version a real unassignment goes through",
    payload: conversationEvent({ version: V_NEW, assigneeType: null }),
    row: storedRow({ assigneeType: "User" }),
    want: { assignee: true },
  },

  // A degraded payload (no assignee stated) is why there are two marks.
  {
    name: "a degraded payload writes the status and does not wipe the stored assignee",
    payload: conversationEvent({ assigneeStated: false, assigneeType: null }),
    row: storedRow({ assigneeType: "User" }),
    want: { status: "resolved", assignee: false },
  },
  {
    name: "...and moves only the status mark, leaving the assignee mark where it was",
    payload: conversationEvent({ assigneeStated: false, assigneeType: null }),
    row: storedRow(),
    want: { statusAt: V_NEW, assigneeAt: null },
  },

  // Marks move when the field is written, and only forward.
  {
    name: "a mark does not move when its field was not written",
    payload: conversationEvent({ status: null }),
    row: storedRow(),
    want: { status: null, statusAt: null, assigneeAt: V_NEW },
  },
  {
    name: "a mark never moves backwards",
    payload: conversationEvent({ version: V_OLD }),
    row: storedRow({ statusAt: V_OLD, assigneeAt: V_OLD }),
    want: { statusAt: null, assigneeAt: null },
  },

  // Fallback for a Chatwoot too old to send a version: the monotonic guard.
  {
    name: "an unversioned conversation event behind on last_activity_at is stale",
    payload: conversationEvent({ version: null, activityAt: EARLIER }),
    row: storedRow({ activityAt: LATER }),
    want: { stale: true },
  },
  {
    name: "an unversioned conversation event that is current applies best-effort",
    payload: conversationEvent({ version: null, activityAt: NOW }),
    row: storedRow({ activityAt: LATER }),
    want: { stale: false, status: "resolved", assignee: true, statusAt: null },
  },
  {
    name: "a message behind on last_activity_at is stale",
    payload: messageEvent({ activityAt: EARLIER }),
    row: storedRow({ activityAt: LATER }),
    want: { stale: true },
  },

  // No row: nothing to be behind, so everything the payload states applies.
  {
    name: "with no row the payload applies and claims its version",
    payload: conversationEvent(),
    row: null,
    want: {
      stale: false,
      status: "resolved",
      assignee: true,
      relations: allRelations(true, V_NEW),
      statusAt: V_NEW,
      assigneeAt: V_NEW,
    },
  },
  {
    name: "with no row a degraded payload claims no assignee mark",
    payload: conversationEvent({ assigneeStated: false }),
    row: null,
    want: { statusAt: V_NEW, assigneeAt: null },
  },
  {
    name: "with no row a payload that states no status claims no status mark (the created `open` is a default, not a reading)",
    payload: conversationEvent({ status: null }),
    row: null,
    want: { status: null, statusAt: null, assigneeAt: V_NEW },
  },

  // The redirect pairing, on its own mark. The consumer of this field messages AND resolves the
  // conversation it names, so a value that regresses to a previous episode's origin acts
  // destructively on the wrong WhatsApp thread.
  {
    name: "a payload that names no origin writes none and stamps nothing",
    payload: messageEvent({ activityAt: NOW }),
    row: storedRow({ redirectOriginAt: V_NOW }),
    want: { redirectOrigin: false, redirectOriginAt: null },
  },
  {
    name: "a message snapshot DOES carry the pairing, unlike status and assignee",
    payload: messageEvent({ activityAt: NOW, redirectOriginStated: true }),
    row: storedRow(),
    want: { redirectOrigin: true, redirectOriginAt: V_NEW },
  },
  {
    name: "a retried snapshot behind the mark cannot regress the pairing",
    payload: messageEvent({
      version: V_OLD,
      activityAt: LATER,
      redirectOriginStated: true,
    }),
    row: storedRow({ redirectOriginAt: V_NOW }),
    want: { stale: false, redirectOrigin: false, redirectOriginAt: null },
  },
  {
    name: "an equal version writes the same reading rather than letting delivery order decide",
    payload: messageEvent({ version: V_NOW, redirectOriginStated: true }),
    row: storedRow({ redirectOriginAt: V_NOW }),
    want: { redirectOrigin: true, redirectOriginAt: null },
  },
  // The event the fork emits when the pairing changes on an existing conversation: a fresh version
  // and a last_activity_at that a column write never moved. Recency would discard it; version does not.
  {
    name: "the pairing's own event applies on version, with a frozen last_activity_at",
    payload: conversationEvent({
      version: V_NEW,
      activityAt: EARLIER,
      redirectOriginStated: true,
    }),
    row: storedRow({ activityAt: LATER, redirectOriginAt: V_OLD }),
    want: {
      redirectOrigin: true,
      redirectOriginAt: V_NEW,
      relations: allRelations(false),
    },
  },
  // The stale branch's one exception: `stale` means "behind on every axis this payload OFFERS", and
  // the pairing is an axis of its own. The first payload to carry one is routinely behind on the
  // others — a retry, or any event on a conversation the mirror followed since before the fork had
  // the field, where the other two marks are set and this one is null.
  {
    name: "a stale event still delivers a pairing its own mark does not refuse",
    payload: conversationEvent({ version: V_OLD, redirectOriginStated: true }),
    row: storedRow({ redirectOriginAt: null }),
    want: { stale: true, redirectOrigin: true, redirectOriginAt: V_OLD },
  },
  {
    name: "...and nothing else leaks through with it",
    payload: conversationEvent({
      version: V_OLD,
      reopensConversation: true,
      redirectOriginStated: true,
    }),
    row: storedRow({ redirectOriginAt: null }),
    want: { status: null, assignee: false, relations: allRelations(false) },
  },
  {
    name: "a stale event behind the redirect mark too writes no pairing",
    payload: conversationEvent({ version: V_OLD, redirectOriginStated: true }),
    row: storedRow({ redirectOriginAt: V_NOW }),
    want: { stale: true, redirectOrigin: false, redirectOriginAt: null },
  },
  {
    name: "a stale event that names no pairing writes none",
    payload: conversationEvent({ version: V_OLD }),
    row: storedRow({ redirectOriginAt: null }),
    want: { stale: true, redirectOrigin: false, redirectOriginAt: null },
  },
  // No version to order by (Chatwoot < 4.0.2): the pairing is written and no mark is stamped.
  {
    name: "a versionless payload writes the pairing and stamps no mark",
    payload: messageEvent({ version: null, redirectOriginStated: true }),
    row: storedRow({ redirectOriginAt: null }),
    want: { redirectOrigin: true, redirectOriginAt: null },
  },
  {
    name: "the first pairing seen on a conversation with no row claims the mark",
    payload: messageEvent({ redirectOriginStated: true }),
    row: null,
    want: { redirectOrigin: true, redirectOriginAt: V_NEW },
  },

  // THE LOCAL CLAIM: a status this side wrote that the source has not versioned. No reading of
  // `updated_at` separates a snapshot taken before that write from one taken after it, because a
  // customer message advances the version on its own account. ../../src/modules/chatwoot/status-claim.ts.
  {
    // The takeover writes `open` over `pending` and then calls Chatwoot. The customer message
    // Chatwoot serialized before it committed the toggle still says `pending`, and the reopen
    // exception is the one rule that lets a message move status at all.
    name: "a live claim refuses the status it is replacing, carried by a message",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "pending",
    }),
    row: storedRow({
      status: "open",
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
      // Nothing stamped: the reconcile has not run, so there is no version of our own to place this
      // against.
      statusClaimStampedAt: null,
    }),
    // Kept like every other refusal inside the gap: the payload states a version, and the reconcile
    // is the only thing that can place it.
    want: { status: null, statusAt: null, statusClaimRefusedAt: V_NEW },
  },
  {
    // Without the claim, a delayed or companion `conversation_*` event carrying the pre-takeover
    // `pending` would win on the ordinary ordered path: the claim advanced no mark for it to lose to.
    name: "a live claim refuses the status it is replacing, carried by a conversation event",
    payload: conversationEvent({ version: V_NEW, status: "pending" }),
    row: storedRow({
      status: "open",
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
      // Nothing stamped: the reconcile has not run.
      statusClaimStampedAt: null,
    }),
    // ...and the VERSION IS KEPT, on the claim's own mark and not on the status one. This payload is
    // a transition somebody dispatched and we are about to acknowledge it, so dropping it would lose
    // a hand-back made while the toggle was on the wire; the reconcile answers it against the version
    // the source gives our own write.
    want: { status: null, statusAt: null, statusClaimRefusedAt: V_NEW },
  },
  {
    // ...and it is the NEWEST refusal that is kept, forward-only like every other mark here: two
    // payloads frozen before the toggle are two readings of a state we already decided to leave, and
    // only the later one could be evidence of anything.
    name: "a second refusal keeps only the newer version",
    payload: conversationEvent({ version: V_NOW, status: "pending" }),
    row: storedRow({
      status: "open",
      // Behind the version already kept, and AHEAD of the status mark, so this payload is a live
      // reading and not a stale one: what stops it is the comparison, not the staleness branch.
      statusAt: V_OLD,
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
      statusClaimRefusedAt: V_NEW,
    }),
    want: { status: null, statusClaimRefusedAt: null },
  },
  {
    // ...and once the source HAS stamped our transition, the ordinary question is back: a version
    // strictly ahead of ours was committed after our write, so it is a hand-back and it lands.
    name: "a write committed after the stamped transition applies",
    payload: conversationEvent({ version: V_NEW, status: "pending" }),
    row: storedRow({
      status: "open",
      statusAt: V_NOW,
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
      statusClaimStampedAt: V_NOW,
    }),
    want: { status: "pending", statusAt: V_NEW, statusClaimRefusedAt: null },
  },
  {
    // ...and a version the stamp has already placed as ours or older is still the gap: EQUAL is the
    // reading our own reconcile took, and a payload restating it is that same state read twice.
    name: "a version equal to the stamped transition is still refused",
    payload: conversationEvent({ version: V_NOW, status: "pending" }),
    row: storedRow({
      status: "open",
      statusAt: V_NOW,
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
      statusClaimStampedAt: V_NOW,
    }),
    want: { status: null, statusAt: null },
  },
  {
    // The REOPEN route asks the same question. When a hand-back's conversation event is delayed
    // or lost, the next customer message carries the new `pending` with a version of its own; refusing
    // it on the stored status alone leaves the mirror closed to the bot while Chatwoot waits for it.
    name: "a message newer than the stamped transition moves the status it restates",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "pending",
      version: V_NEW,
    }),
    row: storedRow({
      status: "open",
      statusAt: V_NOW,
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
      statusClaimStampedAt: V_NOW,
    }),
    want: { status: "pending" },
  },
  {
    // Not a freeze of the field. An operator resolving inside the claim produces ONE event, which we
    // ack and Chatwoot never redelivers, so a blanket fence would lose it with no later event on a
    // resolved conversation to repair it.
    name: "a live claim lets a status it is not replacing through",
    payload: conversationEvent({ version: V_NEW, status: "resolved" }),
    row: storedRow({
      status: "open",
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
      // Nothing stamped: the reconcile has not run.
      statusClaimStampedAt: null,
    }),
    want: { status: "resolved", statusAt: V_NEW },
  },
  {
    // Keyed on the status the ROW holds, not the payload's: `reopen_conversation` acts only on a
    // resolved or snoozed conversation, so on a row we believe resolved it is evidence of a change made
    // AFTER our write. On the fork that act yields `pending` rather than `open` on an inbox with an
    // active bot, which is why the rule cannot key on the status it produces.
    name: "a live claim does not refuse the source's own reopen of a resolved conversation",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "open",
    }),
    row: storedRow({
      status: "resolved",
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "open",
    }),
    want: { status: "open" },
  },
  {
    // Same act, on a row nothing can reopen: the status is only the snapshot every message
    // payload embeds.
    name: "the reopen exception does not rescue a payload on a row that cannot be reopened",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "pending",
    }),
    row: storedRow({
      status: "pending",
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
    }),
    want: { status: null },
  },
  {
    // A MARK THAT MOVED IS NOT A STAMP. Whatever moved the status mark (a delivery for another
    // field, an operator's change) says nothing about whether the SOURCE decided our transition, so the
    // gap is still open and a payload restating the replaced status is still unplaceable.
    name: "a live claim refuses a payload on a mark that moved without a stamp",
    payload: conversationEvent({ version: V_NEW, status: "pending" }),
    row: storedRow({
      status: "open",
      statusAt: V_NOW,
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
    }),
    want: { status: null, statusAt: null, statusClaimRefusedAt: V_NEW },
  },
  {
    // A stamped claim still fences the reopen exception, which is why the claim does not retire at
    // the reconcile: that route compares WHOLE SECONDS against the mark, so a message frozen in the same
    // second as the toggle wins that comparison. It cannot beat the stamp, because the toggle wrote after
    // the message did.
    name: "a stamped transition still fences a message frozen before it",
    payload: messageEvent({
      reopensConversation: true,
      activityAt: NOW,
      status: "pending",
      version: V_OLD,
    }),
    row: storedRow({
      status: "open",
      statusAt: V_NOW,
      statusClaimStampedAt: V_NOW,
      statusClaimUntil: CLAIM_LIVE,
      statusClaimFrom: "pending",
    }),
    want: { status: null },
  },
  {
    // A claim is a deadline, not a flag: the pair is left where the writer put it, so a claim that
    // ran out and no claim at all are the same answer, ordinary ordering.
    name: "an expired claim refuses nothing",
    payload: conversationEvent({ version: V_NEW, status: "pending" }),
    row: storedRow({
      status: "open",
      statusClaimUntil: CLAIM_EXPIRED,
      statusClaimFrom: "pending",
    }),
    want: { status: "pending", statusAt: V_NEW },
  },

  // THE FACT MARKS. Labels, attribute bags and `group_type` carry no version of their own and
  // `last_activity_at` does not move when they change, so a delayed snapshot from the same second used
  // to win. The conversation's version moves on every one of those writes.
  {
    name: "a snapshot older than the version that last wrote a fact leaves it alone, in the same second",
    payload: messageEvent({ version: V_OLD, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, factMarks: marks(V_NOW) }),
    want: { stale: false, facts: allFacts(false) },
  },
  {
    name: "...and so does a conversation event at an older version",
    payload: conversationEvent({ version: V_OLD, activityAt: LATER }),
    row: storedRow({
      activityAt: LATER,
      factMarks: marks(V_NOW),
      statusAt: V_OLD,
      assigneeAt: V_OLD,
    }),
    want: { facts: allFacts(false) },
  },
  {
    // Each relation is ordered by its own mark: a payload refused for the facts still writes them.
    name: "a fact refused by its mark leaves the relations to their own marks",
    payload: messageEvent({ version: V_OLD, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, factMarks: marks(V_NOW) }),
    want: { relations: allRelations(true, V_OLD) },
  },
  {
    name: "a newer version in the same second writes the facts and moves their marks",
    payload: messageEvent({ version: V_NEW, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, factMarks: marks(V_NOW) }),
    want: { facts: allFacts(true, V_NEW) },
  },
  {
    // The same row version is the same facts, and its companions agree by construction.
    name: "the same version writes the facts again and leaves the marks",
    payload: messageEvent({ version: V_NOW, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, factMarks: marks(V_NOW) }),
    want: { facts: allFacts(true, null) },
  },
  {
    name: "a row from before the marks takes the first versioned facts and is stamped",
    payload: messageEvent({ version: V_OLD, activityAt: LATER }),
    row: storedRow({ activityAt: LATER }),
    want: { facts: allFacts(true, V_OLD) },
  },
  {
    name: "a row born from a versioned payload is stamped",
    payload: messageEvent({ version: V_NEW }),
    row: null,
    want: { facts: allFacts(true, V_NEW) },
  },
  {
    // Chatwoot < 4.0.2: no version to order by, so the recency rule stands alone, ties included.
    name: "a versionless payload keeps the recency rule and stamps nothing",
    payload: messageEvent({ version: null, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, factMarks: marks(V_NOW) }),
    want: { facts: allFacts(true, null) },
  },
  {
    name: "a newer version behind on last_activity_at still writes no facts",
    payload: conversationEvent({ version: V_NEW, activityAt: EARLIER }),
    row: storedRow({ activityAt: LATER, factMarks: marks(V_NOW) }),
    want: { facts: allFacts(false) },
  },
  {
    // A payload that omits a fact says nothing about it, so its mark stays where the last writer of
    // THAT fact left it, and an older payload carrying it is still heard.
    name: "a fact the payload omits is neither written nor stamped",
    payload: messageEvent({
      version: V_NEW,
      activityAt: LATER,
      factsStated: { ...ALL_STATED, labels: false },
    }),
    row: storedRow({ activityAt: LATER, factMarks: marks(V_NOW) }),
    want: {
      facts: { ...allFacts(true, V_NEW), labels: { write: false, at: null } },
    },
  },
  {
    name: "each fact is ordered by its own mark",
    payload: messageEvent({ version: V_NOW, activityAt: LATER }),
    row: storedRow({
      activityAt: LATER,
      factMarks: { ...marks(V_OLD), labels: V_NEW },
    }),
    want: {
      facts: { ...allFacts(true, V_NOW), labels: { write: false, at: null } },
    },
  },
  // THE CARD. Editing a kanban card writes the card, not the conversation, so two snapshots of one
  // conversation version can carry two states of the same card; the card's own `updated_at` orders
  // them. Linking another card moves neither clock, so a different card at the same version is a tie.
  {
    name: "at the same version, an older state of the same card is refused, the rest still written",
    payload: messageEvent({
      version: V_NOW,
      activityAt: LATER,
      kanbanCardId: 7,
      kanbanCardAt: V_OLD,
    }),
    row: storedRow({
      activityAt: LATER,
      factMarks: marks(V_NOW),
      kanbanCardId: 7,
      kanbanCardAt: V_NOW,
    }),
    want: {
      facts: {
        ...allFacts(true, null),
        kanbanAttributes: { write: false, at: null },
      },
    },
  },
  {
    name: "at the same version, a newer state of the same card is written",
    payload: messageEvent({
      version: V_NOW,
      activityAt: LATER,
      kanbanCardId: 7,
      kanbanCardAt: V_NEW,
    }),
    row: storedRow({
      activityAt: LATER,
      factMarks: marks(V_NOW),
      kanbanCardId: 7,
      kanbanCardAt: V_NOW,
    }),
    want: { facts: allFacts(true, null) },
  },
  {
    name: "at the same version, another card is written whatever its clock",
    payload: messageEvent({
      version: V_NOW,
      activityAt: LATER,
      kanbanCardId: 8,
      kanbanCardAt: V_OLD,
    }),
    row: storedRow({
      activityAt: LATER,
      factMarks: marks(V_NOW),
      kanbanCardId: 7,
      kanbanCardAt: V_NOW,
    }),
    want: { facts: allFacts(true, null) },
  },
  {
    name: "a newer conversation version writes the card even when its clock is older",
    payload: messageEvent({
      version: V_NEW,
      activityAt: LATER,
      kanbanCardId: 7,
      kanbanCardAt: V_OLD,
    }),
    row: storedRow({
      activityAt: LATER,
      factMarks: marks(V_NOW),
      kanbanCardId: 7,
      kanbanCardAt: V_NOW,
    }),
    want: { facts: allFacts(true, V_NEW) },
  },
  {
    name: "a card behind its mark is refused whatever its clock",
    payload: messageEvent({
      version: V_OLD,
      activityAt: LATER,
      kanbanCardId: 7,
      kanbanCardAt: V_NEW,
    }),
    row: storedRow({
      activityAt: LATER,
      factMarks: marks(V_NOW),
      kanbanCardId: 7,
      kanbanCardAt: V_NOW,
    }),
    want: { facts: allFacts(false) },
  },
  // A NULL THAT DOES NOT ANSWER still dates itself. On a row never told about a pairing a stated null
  // stamps no pairing mark (that would close the recency fallback), and is recorded on a mark of its
  // own, which an older stated origin then loses to.
  {
    name: "a null on a row never told about a pairing records its version and stamps no pairing mark",
    payload: messageEvent({
      version: V_NOW,
      redirectOriginStated: true,
      redirectOriginCleared: true,
    }),
    row: storedRow({ redirectOriginAt: null, redirectOriginKnown: false }),
    want: {
      redirectOrigin: false,
      redirectOriginAt: null,
      redirectOriginClearedAt: V_NOW,
    },
  },
  {
    name: "...and so does one that creates the row",
    payload: messageEvent({
      version: V_NOW,
      redirectOriginStated: true,
      redirectOriginCleared: true,
    }),
    row: null,
    want: {
      redirectOrigin: false,
      redirectOriginAt: null,
      redirectOriginClearedAt: V_NOW,
    },
  },
  {
    name: "...and one behind on state",
    payload: conversationEvent({
      version: V_NOW,
      redirectOriginStated: true,
      redirectOriginCleared: true,
    }),
    row: storedRow({
      statusAt: V_NEW,
      assigneeAt: V_NEW,
      redirectOriginClearedAt: V_OLD,
    }),
    want: {
      stale: true,
      redirectOrigin: false,
      redirectOriginClearedAt: V_NOW,
    },
  },
  {
    name: "an origin older than the recorded null is refused, behind on state",
    payload: conversationEvent({ version: V_OLD, redirectOriginStated: true }),
    row: storedRow({
      statusAt: V_NOW,
      assigneeAt: V_NOW,
      redirectOriginClearedAt: V_NOW,
    }),
    want: { stale: true, redirectOrigin: false, redirectOriginAt: null },
  },
  {
    name: "an origin older than the recorded null is refused, ahead on state",
    payload: conversationEvent({ version: V_OLD, redirectOriginStated: true }),
    row: storedRow({
      statusAt: V_OLD,
      assigneeAt: V_OLD,
      redirectOriginClearedAt: V_NOW,
    }),
    want: { stale: false, redirectOrigin: false, redirectOriginAt: null },
  },
  {
    name: "an origin newer than the recorded null installs and stamps the pairing mark",
    payload: conversationEvent({ version: V_NEW, redirectOriginStated: true }),
    row: storedRow({ redirectOriginClearedAt: V_NOW }),
    want: { redirectOrigin: true, redirectOriginAt: V_NEW },
  },
  {
    name: "an older null moves the null mark nowhere",
    payload: messageEvent({
      version: V_OLD,
      redirectOriginStated: true,
      redirectOriginCleared: true,
    }),
    row: storedRow({ redirectOriginClearedAt: V_NOW }),
    want: { redirectOriginClearedAt: null },
  },
  {
    name: "a null that answers stamps the pairing mark and not the null mark",
    payload: messageEvent({
      version: V_NEW,
      redirectOriginStated: true,
      redirectOriginCleared: true,
    }),
    row: storedRow({ redirectOriginAt: V_NOW, redirectOriginKnown: true }),
    want: {
      redirectOrigin: true,
      redirectOriginAt: V_NEW,
      redirectOriginClearedAt: null,
    },
  },
  {
    name: "a versionless null records nothing",
    payload: messageEvent({
      version: null,
      redirectOriginStated: true,
      redirectOriginCleared: true,
    }),
    row: storedRow(),
    want: { redirectOriginClearedAt: null },
  },
  // THE RELATIONS. Moving the contact or the contact inbox is a write to the conversation, so its
  // version moves and `last_activity_at` does not: a snapshot serialized before a merge shares the
  // second of the one after it and used to write the old contact back.
  {
    name: "a snapshot older than the version that last wrote a relation leaves it, in the same second",
    payload: messageEvent({ version: V_OLD, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, relationMarks: relationMarks(V_NOW) }),
    want: { stale: false, relations: allRelations(false) },
  },
  {
    name: "a newer version in the same second writes the relations and moves their marks",
    payload: messageEvent({ version: V_NEW, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, relationMarks: relationMarks(V_NOW) }),
    want: { relations: allRelations(true, V_NEW) },
  },
  {
    // The case a single mark for every relation could not hold: the degraded event that created the
    // row named none, so nothing it stamped can refuse the complete event serialized before it.
    name: "an empty relation is filled by an older payload naming it, and stamped",
    payload: messageEvent({ version: V_OLD, activityAt: LATER }),
    row: storedRow({
      activityAt: LATER,
      relationsStored: { contact: false, contactInbox: false, inbox: true },
    }),
    want: {
      relations: {
        contact: { write: true, at: V_OLD },
        contactInbox: { write: true, at: V_OLD },
        inbox: { write: true, at: V_OLD },
      },
    },
  },
  {
    name: "...even when the payload is stale, which fills and holds nothing back",
    payload: conversationEvent({ version: V_OLD }),
    row: storedRow({
      relationsStored: { contact: false, contactInbox: true, inbox: true },
    }),
    want: {
      stale: true,
      relations: {
        contact: { write: true, at: V_OLD },
        contactInbox: { write: false, at: null },
        inbox: { write: false, at: null },
      },
    },
  },
  {
    name: "...and so is one behind on last_activity_at",
    payload: conversationEvent({ version: V_NEW, activityAt: EARLIER }),
    row: storedRow({
      activityAt: LATER,
      relationsStored: { contact: false, contactInbox: true, inbox: true },
    }),
    want: {
      relations: {
        contact: { write: true, at: V_NEW },
        contactInbox: { write: false, at: null },
        inbox: { write: false, at: null },
      },
    },
  },
  {
    // A degraded payload names no relation, so it moves no mark and a later payload newer than the
    // last one that DID name it is still heard.
    name: "a relation the payload does not name is neither written nor stamped",
    payload: messageEvent({
      version: V_NEW,
      activityAt: LATER,
      relationsStated: { contact: false, contactInbox: false, inbox: true },
    }),
    row: storedRow({ activityAt: LATER, relationMarks: relationMarks(V_OLD) }),
    want: {
      relations: {
        contact: { write: false, at: null },
        contactInbox: { write: false, at: null },
        inbox: { write: true, at: V_NEW },
      },
    },
  },
  {
    name: "each relation is ordered by its own mark",
    payload: messageEvent({ version: V_NOW, activityAt: LATER }),
    row: storedRow({
      activityAt: LATER,
      relationMarks: { ...relationMarks(V_OLD), contactInbox: V_NEW },
    }),
    want: {
      relations: {
        ...allRelations(true, V_NOW),
        contactInbox: { write: false, at: null },
      },
    },
  },
  {
    name: "a versionless payload keeps the recency rule for relations and stamps nothing",
    payload: messageEvent({ version: null, activityAt: LATER }),
    row: storedRow({ activityAt: LATER, relationMarks: relationMarks(V_NOW) }),
    want: { relations: allRelations(true, null) },
  },
  {
    name: "a row born from a payload naming no relation stamps none",
    payload: messageEvent({
      relationsStated: { contact: false, contactInbox: false, inbox: false },
    }),
    row: null,
    want: { relations: allRelations(false) },
  },
];

describe("decideConversationWrites", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const got = decideConversationWrites(c.payload, c.row, NOW);
      expect(got).toMatchObject(c.want);
    });
  }

  // `lastEventAt` is broadcast to every client and sorts the console's conversation list, so it is
  // clamped rather than taken from the payload.
  test("lastEventAt never rewinds over a delayed event", () => {
    const got = decideConversationWrites(
      conversationEvent({ activityAt: EARLIER }),
      storedRow({ activityAt: LATER }),
      NOW,
    );
    expect(got.activityAt).toEqual(LATER);
  });

  test("lastEventAt advances on a current event", () => {
    const got = decideConversationWrites(
      conversationEvent({ activityAt: NOW }),
      storedRow({ activityAt: LATER }),
      NOW,
    );
    expect(got.activityAt).toEqual(NOW);
  });

  test("a payload with no last_activity_at falls back to the caller's clock", () => {
    const got = decideConversationWrites(
      conversationEvent({ activityAt: null }),
      null,
      NOW,
    );
    expect(got.activityAt).toEqual(NOW);
  });
});

// THE CHANGE MARK. The status mark moves on every ordered conversation event, a
// restatement included, and that is right for ordering snapshots. The ownership mark answers a different
// question, the one the human-reply takeover asks: did the status MOVE after the reply was written?
// A person's reply makes Chatwoot emit its own conversation_updated a few milliseconds later, same
// status, and that is not a later decision.
describe("the ownership mark", () => {
  test("a restatement moves the status mark and leaves the ownership mark", () => {
    const d = decideConversationWrites(
      conversationEvent({
        status: "pending",
        assigneeType: "AgentBot",
        ownershipChangeStated: false,
      }),
      storedRow({ status: "pending", ownershipChangedAt: V_OLD }),
      NOW,
    );
    expect(d.statusAt).toBe(V_NEW);
    expect(d.ownershipChangedAt).toBeNull();
  });

  test("a status that differs from the row moves both marks", () => {
    const d = decideConversationWrites(
      conversationEvent({ status: "open", ownershipChangeStated: false }),
      storedRow({ status: "pending", ownershipChangedAt: V_OLD }),
      NOW,
    );
    expect(d.statusAt).toBe(V_NEW);
    expect(d.ownershipChangedAt).toBe(V_NEW);
  });

  // The row never saw the open in between: the event that would have said so was lost or is still
  // in flight. The source says the status moved at this write, and the source is the one that knows.
  test("a change the source states moves the ownership mark even when the row already agrees", () => {
    const d = decideConversationWrites(
      conversationEvent({ status: "pending", ownershipChangeStated: true }),
      storedRow({ status: "pending", ownershipChangedAt: V_OLD }),
      NOW,
    );
    expect(d.ownershipChangedAt).toBe(V_NEW);
  });

  test("a first event stamps the ownership mark with its own version", () => {
    const d = decideConversationWrites(
      conversationEvent({ status: "pending", ownershipChangeStated: false }),
      null,
      NOW,
    );
    expect(d.ownershipChangedAt).toBe(V_NEW); // A first event that states only the holder dates ownership too; one that states neither does not.
    const holderOnly = (assigneeStated: boolean) =>
      decideConversationWrites(
        conversationEvent({ status: null, assigneeStated }),
        null,
        NOW,
      ).ownershipChangedAt;
    expect(holderOnly(true)).toBe(V_NEW);
    expect(holderOnly(false)).toBeNull();
  });

  test("the ownership mark only moves forward", () => {
    const d = decideConversationWrites(
      conversationEvent({
        status: "open",
        version: V_NOW,
        ownershipChangeStated: true,
      }),
      storedRow({
        status: "pending",
        statusAt: V_OLD,
        ownershipChangedAt: V_NEW,
      }),
      NOW,
    );
    expect(d.status).toBe("open");
    expect(d.ownershipChangedAt).toBeNull();
  });

  // A hand-back delivered behind a newer restatement: the restatement moved the status mark only, so
  // this event is the one word that the status moved in between, and it dates the change.
  test("a stated change behind a newer restatement still moves the ownership mark", () => {
    const row = storedRow({
      status: "pending",
      statusAt: V_NEW,
      assigneeAt: V_NEW,
      ownershipChangedAt: V_OLD,
    });
    const late = (ownershipChangeStated: boolean) =>
      decideConversationWrites(
        conversationEvent({
          status: "pending",
          assigneeType: "AgentBot",
          version: V_NOW,
          ownershipChangeStated,
        }),
        row,
        NOW,
      );
    expect(late(true).stale).toBe(true);
    expect(late(true).status).toBeNull();
    expect(late(true).ownershipChangedAt).toBe(V_NOW);
    // Without the source's word it is a stale snapshot like any other.
    expect(late(false).ownershipChangedAt).toBeNull();
  });

  // Same, when the assignee half is still newer and the payload is not stale as a whole.
  test("a stated change behind the status mark moves the ownership mark on the live exit too", () => {
    const d = decideConversationWrites(
      conversationEvent({
        status: "pending",
        version: V_NOW,
        ownershipChangeStated: true,
      }),
      storedRow({
        status: "pending",
        statusAt: V_NEW,
        assigneeAt: V_OLD,
        ownershipChangedAt: V_OLD,
      }),
      NOW,
    );
    expect(d.stale).toBe(false);
    expect(d.status).toBeNull();
    expect(d.ownershipChangedAt).toBe(V_NOW);
  });

  // The holder is the other half of who has the conversation: an assignment away and back leaves the
  // status `pending` throughout, and each move is still a decision a reply from before must not undo.
  test("a holder that moved stamps the ownership mark, a restated one does not", () => {
    const row = storedRow({
      status: "pending",
      assigneeType: "AgentBot",
      assigneeId: 9,
      ownershipChangedAt: V_OLD,
    });
    const at = (assigneeType: string, assigneeId: number) =>
      decideConversationWrites(
        conversationEvent({ status: "pending", assigneeType, assigneeId }),
        row,
        NOW,
      ).ownershipChangedAt;
    expect(at("User", 5)).toBe(V_NEW);
    expect(at("AgentBot", 7)).toBe(V_NEW);
    expect(at("AgentBot", 9)).toBeNull();
  });

  test("a stated holder change behind a newer restatement still moves the ownership mark", () => {
    const d = decideConversationWrites(
      conversationEvent({
        status: null,
        assigneeType: "AgentBot",
        assigneeId: 9,
        version: V_NOW,
        ownershipChangeStated: true,
      }),
      storedRow({
        status: "pending",
        statusAt: V_OLD,
        assigneeAt: V_NEW,
        assigneeType: "AgentBot",
        assigneeId: 9,
        ownershipChangedAt: V_OLD,
      }),
      NOW,
    );
    expect(d.assignee).toBe(false);
    expect(d.ownershipChangedAt).toBe(V_NOW);
  });

  // A row from before the mark: the fence reads the status mark there, so the first stamp, from a
  // holder ordered while the status was not, starts at the status mark and never below it.
  test("the first ownership stamp on a row without one does not sit below the status mark", () => {
    const d = decideConversationWrites(
      conversationEvent({
        status: "pending",
        assigneeType: "User",
        assigneeId: 5,
        version: V_NOW,
      }),
      storedRow({
        status: "pending",
        statusAt: V_NEW,
        assigneeAt: V_OLD,
        assigneeType: "AgentBot",
        assigneeId: 9,
        ownershipChangedAt: null,
      }),
      NOW,
    );
    expect(d.assignee).toBe(true);
    expect(d.status).toBeNull();
    expect(d.ownershipChangedAt).toBe(V_NEW);
  });

  test("a status that is not written stamps no change", () => {
    const d = decideConversationWrites(
      conversationEvent({
        status: "open",
        version: V_OLD,
        ownershipChangeStated: true,
      }),
      storedRow({ status: "pending", statusAt: V_NOW, assigneeAt: V_NOW }),
      NOW,
    );
    expect(d.status).toBeNull();
    // A row without the ownership mark falls back to the status mark, already ahead of this version.
    expect(d.ownershipChangedAt).toBeNull();
  });
});
