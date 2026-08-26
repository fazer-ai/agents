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
    activityAt: LATER,
    statusAt: V_NOW,
    assigneeAt: V_NOW,
    assigneeType: "AgentBot",
    redirectOriginAt: null,
    redirectOriginKnown: false,
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
  // The issue itself: the tail of a handoff burst carries the pre-handoff snapshot.
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
    name: "a message snapshot still mirrors the unversioned fields",
    payload: messageEvent({ activityAt: NOW }),
    row: storedRow(),
    want: { unversioned: true },
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
    want: { stale: true, status: null, assignee: false, unversioned: false },
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
    name: "...and its unversioned fields stay silent, so a newer payload's bags survive",
    payload: conversationEvent({ activityAt: EARLIER }),
    row: storedRow({ activityAt: LATER }),
    want: { unversioned: false },
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

  // The degraded payload of issue #27, which is why there are two marks.
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

  // Fallback for a Chatwoot too old to send a version: the monotonic guard, as before.
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
      unversioned: true,
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

  // The redirect pairing (#222), on its own mark. The consumer of this field messages AND resolves
  // the conversation it names, so a value that regresses to a previous episode's origin acts
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
    want: { redirectOrigin: true, redirectOriginAt: V_NEW, unversioned: false },
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
    want: { status: null, assignee: false, unversioned: false },
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
  // No version to order by (Chatwoot < 4.0.2): the pre-fence behaviour, stated rather than implied.
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
