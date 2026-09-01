import { describe, expect, test } from "bun:test";
import {
  STATUS_CLAIM_TTL_MS,
  statusClaimDeadline,
  statusClaimIsLive,
} from "@/modules/chatwoot/status-claim";

// The deadline half of the claim (issue #436). What the claim REFUSES is exercised through the
// decision table in ./chatwoot-state-order.test.ts, where the rest of the ordering lives; what is
// here is the boundary, which no table row can hold: it is one instant wide, and the two callers that
// read it hand it a clock they do not control.

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
