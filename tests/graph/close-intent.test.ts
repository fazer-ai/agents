import { describe, expect, test } from "bun:test";
import {
  mayCloseConversation,
  type PostedOutcome,
  postedOutcomeFor,
} from "@/graph/close-intent";

// THE WHOLE TABLE, asserted at once, because this question was answered at three call sites and got
// a different answer at each — the review loop found the same defect in them one round at a time
// (issue #429). Two independent inputs make four cases, and a table is the only shape that cannot
// leave one of them unwritten.
describe("mayCloseConversation", () => {
  test.each([
    // replyPartial, attachmentFailed, may close, why
    [false, false, true, "everything the turn promised reached the customer"],
    [true, false, false, "the customer holds only part of the reply text"],
    [
      false,
      true,
      false,
      "a promised file did not get through, though the text did",
    ],
    [true, true, false, "neither half arrived whole"],
  ])(
    "replyPartial=%s attachmentFailed=%s → %s (%s)",
    (replyPartial, attachmentFailed, expected) => {
      expect(
        mayCloseConversation({
          replyPartial: replyPartial as boolean,
          attachmentFailed: attachmentFailed as boolean,
        }),
      ).toBe(expected as boolean);
    },
  );

  // The one that is easy to write backwards: closing is the DEFAULT, refused by any partial. Stated
  // separately from the table so a table rewritten around the wrong polarity still fails here.
  test("only a complete delivery closes", () => {
    expect(
      mayCloseConversation({ replyPartial: false, attachmentFailed: false }),
    ).toBe(true);
    for (const o of [
      { replyPartial: true, attachmentFailed: false },
      { replyPartial: false, attachmentFailed: true },
    ]) {
      expect(mayCloseConversation(o)).toBe(false);
    }
  });
});

// THE SECOND CONSEQUENCE OF THE SAME TWO BITS, asserted as its own table rather than folded into the
// one above, because the two answers are different KINDS of thing: one is a permission (may this
// turn close the conversation) and the other is a report (what did this turn do). Deriving one from
// the other is what keeps them from drifting; asserting both is what proves the derivation is the
// one intended, and not the inverse.
describe("postedOutcomeFor", () => {
  test.each([
    [
      false,
      false,
      "posted",
      "the whole reply and every file reached the customer",
    ],
    [
      true,
      false,
      "posted-partial",
      "the customer holds only part of the reply text",
    ],
    [false, true, "posted-partial", "a promised file did not get through"],
    [true, true, "posted-partial", "neither half arrived whole"],
  ])(
    "replyPartial=%s attachmentFailed=%s → %s (%s)",
    (replyPartial, attachmentFailed, expected) => {
      expect(
        postedOutcomeFor({
          replyPartial: replyPartial as boolean,
          attachmentFailed: attachmentFailed as boolean,
        }),
      ).toBe(expected as PostedOutcome);
    },
  );

  // The coupling itself, stated so a later edit cannot answer one question and forget the other:
  // every delivery that may close is "posted", and every one that may not is "posted-partial".
  // Written as an equivalence rather than two lists, because a list can be extended on one side
  // alone — which is exactly how these two drifted apart at three call sites before (see above).
  test("the two answers are the same bit, asked twice", () => {
    for (const replyPartial of [false, true]) {
      for (const attachmentFailed of [false, true]) {
        const o = { replyPartial, attachmentFailed };
        expect(postedOutcomeFor(o) === "posted").toBe(mayCloseConversation(o));
      }
    }
  });
});
