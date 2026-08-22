import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage } from "@langchain/core/messages";
import {
  attendanceHasStarted,
  claimAttendanceBoundary,
  crossesAttendanceBoundary,
  movesAttendanceFrontier,
  needsAttendanceStartProbe,
} from "@/graph/attendance-boundary";
import { conversationStamp } from "@/graph/markers";

// Decision table for the boundary claim shared by the three writers of a contact's memory thread
// (runtime, ingest, nudge). Every row is a state one of them can actually be in; the columns are the
// three things it then has to do.
describe("claimAttendanceBoundary", () => {
  const CURRENT = 77;
  const PREVIOUS = 42;

  const cases: {
    name: string;
    previous: number | null;
    inFlight: boolean;
    started: boolean;
    divider: boolean;
    advance: boolean;
    closed: number | null;
  }[] = [
    {
      // First activity ever on this thread. The row must be created even though nothing ended: without
      // it, resolve-time compaction has no marker to read and exits before doing anything.
      name: "fresh thread, no marker yet",
      previous: null,
      inFlight: false,
      started: false,
      divider: false,
      advance: true,
      closed: null,
    },
    {
      name: "fresh thread is unaffected by an invoke in flight",
      previous: null,
      inFlight: true,
      started: false,
      divider: false,
      advance: true,
      closed: null,
    },
    {
      name: "same attendance, marker already there",
      previous: CURRENT,
      inFlight: false,
      started: true,
      divider: false,
      advance: false,
      closed: null,
    },
    {
      // The plain boundary: previous attendance ended, nothing in the way, this attendance has not
      // put a message in the thread yet.
      name: "boundary consumed",
      previous: PREVIOUS,
      inFlight: false,
      started: false,
      divider: true,
      advance: true,
      closed: PREVIOUS,
    },
    {
      // Case 1: an invoke would erase the divider while the marker advanced for good. Defer both,
      // arm compaction anyway — the attendance that ended is compactable from its stamps alone.
      name: "boundary deferred while another invoke reads the thread",
      previous: PREVIOUS,
      inFlight: true,
      started: false,
      divider: false,
      advance: false,
      closed: PREVIOUS,
    },
    {
      // Case 2: the deferral above left the marker behind, so the boundary is still visible — but by
      // now this attendance has messages in the thread and an appended divider would land after them.
      name: "boundary consumed without a divider once the attendance started",
      previous: PREVIOUS,
      inFlight: false,
      started: true,
      divider: false,
      advance: true,
      closed: PREVIOUS,
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(
        claimAttendanceBoundary({
          previousConversationId: c.previous,
          conversationId: CURRENT,
          anotherInvokeIsReading: c.inFlight,
          attendanceAlreadyStarted: c.started,
        }),
      ).toEqual({
        writeDivider: c.divider,
        advanceMarker: c.advance,
        closedConversationId: c.closed,
      });
    });
  }

  // Every case that ends an attendance must arm compaction for it, including the two that write
  // nothing to the thread. Compaction that is not armed here waits on a writer that may never come.
  test("every boundary row reports the closed attendance", () => {
    const boundaryRows = cases.filter(
      (c) => c.previous !== null && c.previous !== CURRENT,
    );
    expect(boundaryRows.length).toBe(3);
    for (const c of boundaryRows) expect(c.closed).toBe(PREVIOUS);
  });
});

describe("crossesAttendanceBoundary", () => {
  test("only a different, already-recorded conversation crosses", () => {
    expect(crossesAttendanceBoundary(null, 7)).toBe(false);
    expect(crossesAttendanceBoundary(7, 7)).toBe(false);
    expect(crossesAttendanceBoundary(6, 7)).toBe(true);
  });
});

describe("needsAttendanceStartProbe", () => {
  // The probe is a checkpointer read, and it only changes the answer on a boundary that is actually
  // being consumed. Asking in the other states would buy a round-trip per message written.
  test("only on a boundary with no invoke in the way", () => {
    expect(needsAttendanceStartProbe(6, 7, false)).toBe(true);
    expect(needsAttendanceStartProbe(6, 7, true)).toBe(false);
    expect(needsAttendanceStartProbe(7, 7, false)).toBe(false);
    expect(needsAttendanceStartProbe(null, 7, false)).toBe(false);
  });
});

describe("attendanceHasStarted", () => {
  const stamped = (conversation: number) =>
    new HumanMessage({
      content: "x",
      additional_kwargs: conversationStamp(conversation),
    });

  test("an empty thread has started nothing", () => {
    expect(attendanceHasStarted([], 7)).toBe(false);
  });

  test("the attendance the last stamped message belongs to has started", () => {
    expect(attendanceHasStarted([stamped(7)], 7)).toBe(true);
  });

  // Assistant replies carry no stamp and sit after the human turn of their own attendance, so the
  // scan has to walk past them rather than stop at the end of the array.
  test("unstamped replies at the end do not hide the answer", () => {
    expect(attendanceHasStarted([stamped(7), new AIMessage("oi")], 7)).toBe(
      true,
    );
  });

  // THE REOPENED CASE. Asking "does 1 appear anywhere" answered yes for an attendance that ended
  // before 2 ran, so the writer skipped the divider for a conversation that had genuinely just
  // resumed — and the first turn of it reached the model as a continuation of 2. The stamp is inert
  // to the model; the divider is the only part it reads.
  test("a conversation that ran EARLIER has not started the current attendance", () => {
    const thread = [stamped(1), new AIMessage("resposta"), stamped(2)];
    expect(attendanceHasStarted(thread, 1)).toBe(false);
    expect(attendanceHasStarted(thread, 2)).toBe(true);
  });

  test("a conversation reopened at the end HAS started", () => {
    const thread = [stamped(1), stamped(2), stamped(1)];
    expect(attendanceHasStarted(thread, 1)).toBe(true);
    expect(attendanceHasStarted(thread, 2)).toBe(false);
  });
});

// The guard in front of the table above (issue #194): only the newest message the THREAD has seen
// may make a statement about which attendance it is on. Every false row is a message that, allowed
// through, would summarise a conversation still being served.
describe("movesAttendanceFrontier", () => {
  const cases: [string, (number | null | undefined)[], number, boolean][] = [
    ["a thread that has never been written", [null, null], 500, true],
    ["the ordinary case: the newest id there is", [500, null], 501, true],
    ["a delayed id, its own direction ahead", [500, null], 499, false],
    // THE ROUND-6 CASE. The attendant opened the new conversation, so the customer's own mark is
    // still back in the old one and their delayed note read as current.
    ["a delayed id, the OTHER direction ahead", [500, 502], 501, false],
    ["a new id above both directions", [500, 502], 503, true],
    // A direction that has never written owes nothing: an attendant's first reply must not read as
    // late just because the customer's side is empty, and vice versa.
    ["one direction still empty", [null, 502], 503, true],
    [
      "one direction still empty, and late in the other",
      [null, 502],
      501,
      false,
    ],
    // Re-delivery of the frontier itself. Deduplication refuses it long before this, and the answer
    // here is still "not older than what we have" rather than a second refusal on another axis.
    ["the frontier id itself", [500, 502], 502, true],
  ];
  for (const [name, marks, id, want] of cases) {
    test(`${name} -> ${want}`, () => {
      expect(movesAttendanceFrontier(marks, id)).toBe(want);
    });
  }

  // Order-independence, asserted apart from the table: the caller passes the two marks as a pair and
  // nothing about which slot holds which direction may change the answer.
  test("the pair is symmetric", () => {
    expect(movesAttendanceFrontier([500, 502], 501)).toBe(
      movesAttendanceFrontier([502, 500], 501),
    );
  });
});
