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
    attendanceTrackedFromStart: true,
    firstInboundAt: null,
    lastInboundAt: null,
    firstHumanReplyAt: null,
    lastHumanReplyAt: null,
    firstHumanMessageAt: null,
    ...over,
  };
}
function seen(over: Partial<SeenAttendance> = {}): SeenAttendance {
  return { inboundAt: null, humanReplyAt: null, ...over };
}
// A conversation already being watermarked, answered once at T1.
function answered(over: Partial<StoredAttendance> = {}): StoredAttendance {
  return stored({
    firstInboundAt: T0,
    lastInboundAt: T0,
    firstHumanReplyAt: T1,
    lastHumanReplyAt: T1,
    firstHumanMessageAt: T1,
    ...over,
  });
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
    // The migration leaves existing rows explicitly ineligible regardless of their watermarks.
    stored: stored({ attendanceTrackedFromStart: false, lastInboundAt: T0 }),
    seen: seen({ inboundAt: T1 }),
    want: {},
  },
  {
    name: "a reset watermark cannot make an untracked conversation eligible",
    stored: stored({ attendanceTrackedFromStart: false, lastInboundAt: null }),
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
    name: "the first team reply sets every end at once",
    stored: stored({ firstInboundAt: T0, lastInboundAt: T0 }),
    seen: seen({ humanReplyAt: T1 }),
    want: {
      firstHumanReplyAt: T1,
      lastHumanReplyAt: T1,
      firstHumanMessageAt: T1,
    },
  },
  {
    name: "a later reply advances only the last end",
    stored: answered(),
    seen: seen({ humanReplyAt: T2 }),
    want: { lastHumanReplyAt: T2 },
  },
  {
    name: "a reply that arrives late but happened earlier lowers both first ends",
    stored: answered({
      firstHumanReplyAt: T2,
      lastHumanReplyAt: T2,
      firstHumanMessageAt: T2,
    }),
    seen: seen({ humanReplyAt: T1 }),
    want: { firstHumanReplyAt: T1, firstHumanMessageAt: T1 },
  },
  {
    name: "a re-delivered reply on the exact stored clock writes nothing",
    stored: answered(),
    seen: seen({ humanReplyAt: T1 }),
    want: {},
  },
  {
    name: "an answer inside the same second as the question is still an answer",
    // Chatwoot's clock is whole seconds, so a reply typed fast shares its reading with the message
    // it answers. Demanding a strictly later one would drop exactly the best attendances.
    stored: stored({ firstInboundAt: T1, lastInboundAt: T1 }),
    seen: seen({ humanReplyAt: T1 }),
    want: {
      firstHumanReplyAt: T1,
      lastHumanReplyAt: T1,
      firstHumanMessageAt: T1,
    },
  },
  {
    name: "a team message with no anchor is recorded, but not as a first response",
    // Either the business opening the conversation or a customer message still in the retry ladder.
    // The two rows are identical here; the KPI is where they are told apart.
    stored: stored(),
    seen: seen({ humanReplyAt: T0 }),
    want: { lastHumanReplyAt: T0, firstHumanMessageAt: T0 },
  },
  {
    name: "and the answer after the customer finally writes is the response",
    stored: stored({
      firstInboundAt: T1,
      lastInboundAt: T1,
      lastHumanReplyAt: T0,
      firstHumanMessageAt: T0,
    }),
    seen: seen({ humanReplyAt: T2 }),
    want: { firstHumanReplyAt: T2, lastHumanReplyAt: T2 },
  },
  {
    name: "a team message dated before the anchor never becomes the first response",
    stored: answered({
      firstInboundAt: T1,
      lastInboundAt: T1,
      firstHumanReplyAt: T2,
      lastHumanReplyAt: T2,
      firstHumanMessageAt: T2,
    }),
    seen: seen({ humanReplyAt: T0 }),
    want: { firstHumanMessageAt: T0 },
  },
  {
    name: "a legacy row records the team's word and never a first response",
    stored: stored({ lastInboundAt: T0 }),
    seen: seen({ humanReplyAt: T1 }),
    want: { lastHumanReplyAt: T1, firstHumanMessageAt: T1 },
  },
];

describe("decideAttendanceWatermarks", () => {
  for (const c of cases) {
    test(c.name, () => {
      expect(decideAttendanceWatermarks(c.stored, c.seen)).toEqual(c.want);
    });
  }
});
