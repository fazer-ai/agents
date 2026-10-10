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

test("an approval whose document was never issued is not on its way", () => {
  expect(
    approvalOutcomeLabel(
      {
        status: "APPROVED",
        outcome: null,
        // Past the moment a document may still be issuing.
        decidedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        issuedDocumentId: null,
      },
      t,
    ),
  ).toBe("Not issued: approve it again");
});

test("a rejection the bot could not hand over does not claim a person had the conversation", () => {
  expect(
    approvalOutcomeLabel({ status: "REJECTED", outcome: "NOTED" }, t),
  ).toBe("Nothing sent, and the conversation was not handed over");
});

test("an approval sent without its PDF and without a note does not claim a note", () => {
  expect(
    approvalOutcomeLabel({ status: "APPROVED", outcome: "NOT_SENT" }, t),
  ).toBe("Not sent to the customer");
});

test("an approval with no document yet is issuing for a moment, then not issued", () => {
  const recent = new Date(Date.now() - 20_000).toISOString();
  const old = new Date(Date.now() - 3 * 60_000).toISOString();
  expect(
    approvalOutcomeLabel(
      {
        status: "APPROVED",
        outcome: null,
        decidedAt: recent,
        issuedDocumentId: null,
      },
      t,
    ),
  ).toBe("On its way to the customer");
  expect(
    approvalOutcomeLabel(
      {
        status: "APPROVED",
        outcome: null,
        decidedAt: old,
        issuedDocumentId: null,
      },
      t,
    ),
  ).toBe("Not issued: approve it again");
});
