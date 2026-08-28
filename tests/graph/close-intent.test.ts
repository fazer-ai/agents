import { describe, expect, test } from "bun:test";
import { mayCloseConversation } from "@/graph/close-intent";

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
