import { describe, expect, test } from "bun:test";
import {
  type AttendanceWrites,
  decideAttendanceWatermarks,
  type SeenAttendance,
  type StoredAttendance,
} from "@/modules/chatwoot/attendance-watermarks";

// The rule as a table. A DB-backed test proves the mirror is wired to it; only a table can enumerate
// the orderings, because reaching each one through the receiver would mean staging a webhook
// delivery per row.
const T0 = new Date("2026-08-25T12:00:00.000Z");
const T1 = new Date("2026-08-25T12:00:10.000Z");
const T2 = new Date("2026-08-25T12:00:20.000Z");

function stored(over: Partial<StoredAttendance> = {}): StoredAttendance {
  return {
    firstInboundAt: null,
    lastInboundAt: null,
    firstHumanReplyAt: null,
    lastHumanReplyAt: null,
    ...over,
  };
}
function seen(over: Partial<SeenAttendance> = {}): SeenAttendance {
  return { inboundAt: null, humanReplyAt: null, ...over };
}

const cases: {
  name: string;
  stored: StoredAttendance;
  seen: SeenAttendance;
  want: AttendanceWrites;
}[] = [
  {
    name: "an event that carries neither reading writes nothing",
    stored: stored({ firstInboundAt: T0 }),
    seen: seen(),
    want: {},
  },
  {
    name: "the first inbound on a conversation nothing was ever watermarked on anchors it",
    stored: stored(),
    seen: seen({ inboundAt: T1 }),
    want: { firstInboundAt: T1 },
  },
  {
    name: "a conversation whose traffic predates the columns is never anchored",
    // lastInboundAt without firstInboundAt is the migration's own signature: the row existed, and
    // customer messages were mirrored onto it, before there was anywhere to date the first one.
    stored: stored({ lastInboundAt: T0 }),
    seen: seen({ inboundAt: T1 }),
    want: {},
  },
  {
    name: "a second customer message leaves the anchor where it is",
    stored: stored({ firstInboundAt: T0, lastInboundAt: T0 }),
    seen: seen({ inboundAt: T2 }),
    want: {},
  },
  {
    name: "an inbound that arrives late but happened earlier lowers the anchor",
    // Chatwoot retries out of order, and the state ordering refuses such an event for the STATE it
    // carries. The message it mentions still happened first.
    stored: stored({ firstInboundAt: T1, lastInboundAt: T1 }),
    seen: seen({ inboundAt: T0 }),
    want: { firstInboundAt: T0 },
  },
  {
    name: "the first team reply sets both ends at once",
    stored: stored({ firstInboundAt: T0, lastInboundAt: T0 }),
    seen: seen({ humanReplyAt: T1 }),
    want: { firstHumanReplyAt: T1, lastHumanReplyAt: T1 },
  },
  {
    name: "a later reply advances only the last end",
    stored: stored({
      firstInboundAt: T0,
      lastInboundAt: T0,
      firstHumanReplyAt: T1,
      lastHumanReplyAt: T1,
    }),
    seen: seen({ humanReplyAt: T2 }),
    want: { lastHumanReplyAt: T2 },
  },
  {
    name: "a reply that arrives late but happened earlier lowers only the first end",
    stored: stored({
      firstInboundAt: T0,
      lastInboundAt: T0,
      firstHumanReplyAt: T2,
      lastHumanReplyAt: T2,
    }),
    seen: seen({ humanReplyAt: T1 }),
    want: { firstHumanReplyAt: T1 },
  },
  {
    name: "a re-delivered reply on the exact stored clock writes nothing",
    stored: stored({
      firstInboundAt: T0,
      lastInboundAt: T0,
      firstHumanReplyAt: T1,
      lastHumanReplyAt: T1,
    }),
    seen: seen({ humanReplyAt: T1 }),
    want: {},
  },
  {
    name: "a legacy row still dates the team's reply, and stays out of the sample for want of an anchor",
    stored: stored({ lastInboundAt: T0 }),
    seen: seen({ humanReplyAt: T1 }),
    want: { firstHumanReplyAt: T1, lastHumanReplyAt: T1 },
  },
];

describe("decideAttendanceWatermarks", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(decideAttendanceWatermarks(c.stored, c.seen)).toEqual(c.want);
    });
  }
});
