import { describe, expect, test } from "bun:test";
import {
  STATUS_CLAIM_TTL_MS,
  statusClaimDeadline,
  statusClaimDeferredWins,
  statusClaimIsLive,
  statusClaimVerdict,
} from "@/modules/chatwoot/status-claim";

// The two halves of the claim that its callers cannot reach (issue #436). What it REFUSES is
// exercised through the decision table in ./chatwoot-state-order.test.ts, where the rest of the
// ordering lives; here are the two answers no row of that table can hold — the deadline, which is one
// instant wide on a clock the callers do not control, and the adjudication, which belongs to the
// reconcile and happens after every payload the table can describe has already been decided.

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

describe("what a claim does before and after its version is stamped", () => {
  const now = new Date("2026-09-01T12:00:00.000Z");
  const claimed = {
    status: "open",
    statusClaimUntil: new Date(now.getTime() + 30_000),
    statusClaimFrom: "pending",
  };
  const restating = { status: "pending", reopens: false, version: 101 };

  test("inside the gap it refuses, and keeps the version to be adjudicated", () => {
    // No stamp yet: the source has said nothing about our own transition, so there is nothing this
    // version can be placed against. It is kept rather than dropped because the event carrying it is
    // about to be acknowledged and Chatwoot never sends it again.
    expect(
      statusClaimVerdict(
        { ...claimed, statusClaimStampedAt: null },
        restating,
        now,
      ),
    ).toBe("refuse-and-defer");
  });

  test("a payload with no version at all is refused with nothing to keep", () => {
    // Chatwoot < 4.0.2. There is no number to adjudicate later, so the refusal is the whole answer.
    expect(
      statusClaimVerdict(
        { ...claimed, statusClaimStampedAt: null },
        { ...restating, version: null },
        now,
      ),
    ).toBe("refuse");
  });

  test("once ours is stamped, only a STRICTLY newer write gets through", () => {
    const stamped = { ...claimed, statusClaimStampedAt: 101 };
    // Ahead of our transition: committed after it, so it is a hand-back and must land.
    expect(
      statusClaimVerdict(stamped, { ...restating, version: 101.5 }, now),
    ).toBe("apply");
    // Equal is the reading our own reconcile took, and below it is the gap itself. Neither is
    // evidence of anything committed after our write.
    expect(statusClaimVerdict(stamped, restating, now)).toBe(
      "refuse-and-defer",
    );
    expect(
      statusClaimVerdict(stamped, { ...restating, version: 100.5 }, now),
    ).toBe("refuse-and-defer");
  });
});

describe("adjudicating what the gap refused", () => {
  test("a refusal ahead of our own stamped version stands", () => {
    expect(statusClaimDeferredWins(101.5, 101)).toBe(true);
  });

  test("equal or behind is a snapshot from before our write, and goes", () => {
    expect(statusClaimDeferredWins(101, 101)).toBe(false);
    expect(statusClaimDeferredWins(100.5, 101)).toBe(false);
  });

  test("nothing refused, or nothing stamped, decides nothing", () => {
    // The second is the versionless deployment and the failed toggle alike: no stamp ever arrives,
    // so the deferred version is never answered and the deadline is what ends the fence.
    expect(statusClaimDeferredWins(null, 101)).toBe(false);
    expect(statusClaimDeferredWins(101.5, null)).toBe(false);
  });
});
