import { expect, test } from "bun:test";
import type { TFunction } from "i18next";
import { approvalOutcomeLabel } from "@/client/lib/approval-status";

// What a decided approval says it came to. An approval with no recorded outcome is "on its way" only
// while that can still be true: past ten minutes a run that never finished is not on its way.

const t = ((_key: string, fallback: string) =>
  fallback) as unknown as TFunction;

test("an approval with no outcome is on its way only for a while", () => {
  const recent = new Date(Date.now() - 30_000).toISOString();
  const stale = new Date(Date.now() - 11 * 60_000).toISOString();
  expect(
    approvalOutcomeLabel(
      { status: "APPROVED", outcome: null, decidedAt: recent },
      t,
    ),
  ).toBe("On its way to the customer");
  expect(
    approvalOutcomeLabel(
      { status: "APPROVED", outcome: null, decidedAt: stale },
      t,
    ),
  ).toBe("No confirmation that it was sent");
  expect(
    approvalOutcomeLabel(
      { status: "APPROVED", outcome: "DELIVERED", decidedAt: stale },
      t,
    ),
  ).toBe("Sent to the customer");
  expect(
    approvalOutcomeLabel({ status: "EXPIRED", outcome: null }, t),
  ).toBeNull();
});
