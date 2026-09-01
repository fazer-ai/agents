import { describe, expect, test } from "bun:test";
import {
  STATUS_CLAIM_TTL_MS,
  statusClaimDeadline,
  statusClaimIsLive,
  statusClaimVerdict,
} from "@/modules/chatwoot/status-claim";

// The two halves of the claim that its callers cannot reach (issue #436). What it REFUSES is
// exercised through the decision table in ./chatwoot-state-order.test.ts, where the rest of the
// ordering lives; here are the answers no row of that table can hold — the deadline, which is one
// instant wide on a clock the callers do not control, and the verdict a LIVE READ gets, which the
// table cannot ask for because every payload it feeds the mirror is a dispatch.

describe("the status claim's deadline", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");

  test("a claim taken now runs out one TTL later", () => {
    expect(statusClaimDeadline(now).getTime()).toBe(
      now.getTime() + STATUS_CLAIM_TTL_MS,
    );
  });

  test("a claim stands up to its deadline and not at it", () => {
    const until = statusClaimDeadline(now);
    expect(statusClaimIsLive(until, now)).toBe(true);
    expect(statusClaimIsLive(until, new Date(until.getTime() - 1))).toBe(true);
    // AT the deadline it is over. The instant it names is when it stops mattering, not the last
    // instant it matters — which is the reading the writers stamp: a claim taken at T with a TTL of
    // N is asking for N milliseconds of fence, and `>=` would give it N+1 forever.
    expect(statusClaimIsLive(until, until)).toBe(false);
    expect(statusClaimIsLive(until, new Date(until.getTime() + 1))).toBe(false);
  });

  test("no claim is not a claim that ran out, and both answer the same", () => {
    expect(statusClaimIsLive(null, now)).toBe(false);
  });
});

describe("what a live read gets from a claim", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  // A claim taken at version 100 whose mark has since moved to 101: a dispatch serialized before the
  // toggle was refused on the way in and kept its version, which is the mark a companion of that same
  // write is compared against.
  const row = {
    status: "open",
    statusAt: 101,
    statusClaimUntil: new Date(now.getTime() + 30_000),
    statusClaimFrom: "pending",
    statusClaimFromAt: 100,
  };
  const restating = { status: "pending", reopens: false, version: 101 };

  test("a dispatch at that version is the companion and is let through", () => {
    expect(
      statusClaimVerdict(row, { ...restating, source: "dispatch" }, now),
    ).toBe("apply");
  });

  test("a read at that version is refused, and leaves the mark alone", () => {
    // Refused because a snapshot repeats a version by not having changed, which while the toggle is
    // on the wire is the state the claim was taken to leave. `refuse` and not `refuse-and-mark`: a
    // read's version stamped onto the mark would be the value a pre-toggle dispatch is carrying, and
    // that dispatch would then qualify as the companion of a write nobody made.
    expect(statusClaimVerdict(row, { ...restating, source: "read" }, now)).toBe(
      "refuse",
    );
  });
});
