import { describe, expect, test } from "bun:test";
import { burstReopenedResolved } from "@/graph/reopened-by-burst";
import { parseChatwootMessages } from "@/modules/chatwoot/messages";

// Issue #897: whether the messages a turn answers reopened a resolved conversation, read off
// Chatwoot's activity trail. The rows go through the real page parser, spelled as the REST partial
// renders them, so a change in how the trail is read fails here too.

const row = (id: number, messageType: number, extra = {}) => ({
  id,
  content: "x",
  message_type: messageType,
  private: false,
  created_at: 1_790_000_000 + id,
  ...extra,
});
const status = (id: number, s: string) =>
  row(id, 2, {
    content_attributes: {
      activity: { type: "conversation_status_changed", status: s },
    },
  });
const page = (...rows: unknown[]) => parseChatwootMessages({ payload: rows });

describe("burstReopenedResolved", () => {
  test("a thank-you right after a close reopened it", () => {
    expect(
      burstReopenedResolved(
        page(row(10, 0), row(11, 1), status(12, "resolved"), row(20, 0)),
        [20],
      ),
    ).toBe(true);
  });

  test("the satisfaction survey and a private note after the close do not count as talk", () => {
    expect(
      burstReopenedResolved(
        page(
          row(11, 1),
          status(12, "resolved"),
          row(13, 3),
          row(14, 1, { private: true }),
          row(20, 0),
        ),
        [20],
      ),
    ).toBe(true);
  });

  test("a burst of two after the close is still the reopen", () => {
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), row(20, 0), row(21, 0)),
        [20, 21],
      ),
    ).toBe(true);
  });

  test("a conversation never resolved on the page is not a reopen", () => {
    expect(
      burstReopenedResolved(page(row(10, 0), row(11, 1), row(20, 0)), [20]),
    ).toBe(false);
  });

  test("an operator's reopen after the close means the message did not reopen it", () => {
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), status(15, "open"), row(20, 0)),
        [20],
      ),
    ).toBe(false);
  });

  test("an operator's reopen whose activity lands after the message still counts", () => {
    // The activity job is asynchronous: the reopen's row can carry a higher id than the message.
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), row(20, 0), status(21, "open")),
        [20],
      ),
    ).toBe(false);
  });

  test("an 'ok' later in the episode the reopen started is not the reopen", () => {
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), row(15, 0), row(16, 1), row(20, 0)),
        [20],
      ),
    ).toBe(false);
  });

  test("an earlier customer message after the close, answered by nobody yet, is not in this burst", () => {
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), row(15, 0), row(20, 0)),
        [20],
      ),
    ).toBe(false);
  });

  test("a close written after the message is not a close the message reopened", () => {
    expect(
      burstReopenedResolved(
        page(row(11, 1), row(20, 0), status(21, "resolved")),
        [20],
      ),
    ).toBe(false);
  });

  test("a snooze is not a close", () => {
    expect(
      burstReopenedResolved(page(status(12, "snoozed"), row(20, 0)), [20]),
    ).toBe(false);
  });

  test("an activity that is not a status change does not stand for one", () => {
    expect(
      burstReopenedResolved(
        page(
          row(12, 2, {
            content_attributes: {
              activity: { type: "linear_issue_created", status: "resolved" },
            },
          }),
          row(20, 0),
        ),
        [20],
      ),
    ).toBe(false);
  });

  test("a burst id the page does not carry is not vouched for", () => {
    expect(
      burstReopenedResolved(page(status(12, "resolved"), row(20, 0)), [20, 30]),
    ).toBe(false);
  });

  test("an outgoing message of ours is not a burst that reopened anything", () => {
    expect(
      burstReopenedResolved(page(status(12, "resolved"), row(20, 1)), [20]),
    ).toBe(false);
  });

  test("an empty burst answers no", () => {
    expect(
      burstReopenedResolved(page(status(12, "resolved"), row(20, 0)), []),
    ).toBe(false);
  });

  test("a message of ours after the close means the burst is not the first thing said", () => {
    // Somebody on our side wrote after the close (a proactive message, a person answering), so the
    // conversation was already talking again when this burst came in.
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), row(15, 1), row(20, 0)),
        [20],
      ),
    ).toBe(false);
  });

  test("an empty burst answers no even on a page that ends in a close", () => {
    expect(burstReopenedResolved(page(status(12, "resolved")), [])).toBe(false);
  });

  test("a thank-you whose turn runs after a newer exchange was answered does not close it", () => {
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), row(20, 0), row(21, 0), row(22, 1)),
        [20],
      ),
    ).toBe(false);
  });

  test("a newer customer message after the burst, not yet answered, holds the close too", () => {
    expect(
      burstReopenedResolved(
        page(status(12, "resolved"), row(20, 0), row(21, 0)),
        [20],
      ),
    ).toBe(false);
  });

  test("a private note or a non-status activity after the burst does not hold the close", () => {
    expect(
      burstReopenedResolved(
        page(
          status(12, "resolved"),
          row(20, 0),
          row(21, 1, { private: true }),
          row(22, 2),
        ),
        [20],
      ),
    ).toBe(true);
  });
});
