/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageLine } from "@/client/components/TokenUsage";
import {
  buildTimeline,
  type Message,
  type TurnUsageEntry,
} from "@/client/pages/conversationTimeline";

// Issue #853: each agent turn's spend is a line in the conversation timeline, at the time of its last
// billed call. The thread pages in from the newest, so a turn older than the oldest loaded message
// waits for its messages instead of stacking above the first bubble; once the whole thread is loaded,
// every line shows.

afterEach(() => {
  cleanup();
});

const T0 = Date.parse("2026-09-25T10:00:00Z");

function msg(id: number, atMs: number, messageType = 0): Message {
  return {
    id,
    content: `m${id}`,
    messageType,
    createdAt: Math.floor(atMs / 1000),
    attachments: [],
  } as unknown as Message;
}

function turn(turnId: string, atMs: number): TurnUsageEntry {
  return {
    turnId,
    at: new Date(atMs).toISOString(),
    usage: {
      calls: 2,
      promptTokens: 1600,
      cachedReadTokens: 600,
      cacheCreationTokens: 0,
      completionTokens: 75,
    },
  };
}

const order = (tl: ReturnType<typeof buildTimeline>) =>
  tl.items.map((i) =>
    i.kind === "message"
      ? `m${i.m.id}`
      : i.kind === "usage"
        ? i.turn.turnId
        : `t${i.entry.id}`,
  );

describe("where a turn's line sits", () => {
  test("between the message it answered and the next one", () => {
    const tl = buildTimeline(
      [
        msg(1, T0),
        msg(2, T0 + 10_000, 1),
        msg(3, T0 + 60_000),
        msg(4, T0 + 70_000, 1),
      ],
      [],
      0,
      [turn("tA", T0 + 8_000), turn("tB", T0 + 68_000)],
    );
    expect(order(tl)).toEqual(["m1", "tA", "m2", "m3", "tB", "m4"]);
  });

  test("a turn older than the loaded messages waits while older pages are pending", () => {
    const messages = [msg(3, T0 + 60_000), msg(4, T0 + 70_000, 1)];
    const turns = [turn("tOld", T0 + 8_000), turn("tB", T0 + 68_000)];
    expect(order(buildTimeline(messages, [], 0, turns, true))).toEqual([
      "m3",
      "tB",
      "m4",
    ]);
    // Nothing older left to load: the turn that opened the conversation shows too.
    expect(order(buildTimeline(messages, [], 0, turns, false))).toEqual([
      "tOld",
      "m3",
      "tB",
      "m4",
    ]);
  });
});

describe("the line itself", () => {
  test("says the input with its cached part, and the output, never the input minus the cache", () => {
    render(<UsageLine usage={turn("tA", T0).usage} />);
    const text = screen.getByTestId("token-usage").textContent ?? "";
    expect(text).toBe("In 1,600 (600 from cache) · out 75 · 2 calls");
    expect(text.includes("1,000")).toBe(false);
  });

  test("a total with no call renders nothing, not a zero", () => {
    render(
      <UsageLine
        usage={{
          calls: 0,
          promptTokens: 0,
          cachedReadTokens: 0,
          cacheCreationTokens: 0,
          completionTokens: 0,
        }}
        label="Tokens"
      />,
    );
    expect(screen.queryByTestId("token-usage") === null).toBe(true);
  });
});
