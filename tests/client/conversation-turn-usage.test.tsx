/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { UsageFigure } from "@/client/components/TokenUsage";
import {
  buildTimeline,
  type Message,
  type TurnUsageEntry,
} from "@/client/pages/conversationTimeline";

// Issues #853 and #858: each agent turn's spend sits at the foot of the last message the turn
// created that is on screen. A turn with none on screen (silent, older than the loaded page, from
// before its messages were recorded) keeps a line in the timeline at the time of its last billed
// call, and while older pages are still to load a line older than the oldest loaded message waits
// for them instead of stacking above the first bubble.

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

function turn(
  turnId: string,
  atMs: number,
  messageIds: number[] = [],
): TurnUsageEntry {
  return {
    turnId,
    at: new Date(atMs).toISOString(),
    messageIds,
    turnMs: 4200,
    modelMs: 3100,
    usage: {
      calls: 2,
      promptTokens: 1600,
      cachedReadTokens: 600,
      cacheCreationTokens: 0,
      completionTokens: 75,
      byNode: { agent: 1, guardrail: 1 },
    },
  };
}

const lines = (tl: ReturnType<typeof buildTimeline>) =>
  tl.items.flatMap((i) => (i.kind === "usage" ? [i.turn.turnId] : []));
const onMessage = (tl: ReturnType<typeof buildTimeline>) =>
  Object.fromEntries(
    [...tl.usageOnMessage.entries()].map(([k, u]) => [k, u.turnId]),
  );

describe("where a turn's usage sits", () => {
  test("on the last of its messages, and on none of the others or the customer's", () => {
    const messages = [
      msg(1, T0),
      msg(2, T0 + 10_000, 1),
      msg(3, T0 + 11_000, 1),
      msg(4, T0 + 12_000, 1),
    ];
    const tl = buildTimeline(messages, [], 0, [
      turn("tA", T0 + 9_000, [2, 3, 4]),
    ]);
    expect(onMessage(tl)).toEqual({ "m-4": "tA" });
    expect(lines(tl)).toEqual([]);
  });

  test("on the last one LOADED when the later ones are not on screen", () => {
    const tl = buildTimeline([msg(1, T0), msg(2, T0 + 10_000, 1)], [], 0, [
      turn("tA", T0 + 9_000, [2, 3]),
    ]);
    expect(onMessage(tl)).toEqual({ "m-2": "tA" });
  });

  test("a turn with no message on screen keeps a line, between the messages around it", () => {
    const messages = [msg(1, T0), msg(2, T0 + 60_000)];
    const tl = buildTimeline(messages, [], 0, [
      // Silent: created nothing.
      turn("tSilent", T0 + 5_000),
      // Recorded messages that are not in the thread any more.
      turn("tGone", T0 + 70_000, [999]),
    ]);
    expect(onMessage(tl)).toEqual({});
    expect(
      tl.items.map((i) =>
        i.kind === "message"
          ? `m${i.m.id}`
          : i.kind === "usage"
            ? i.turn.turnId
            : "trail",
      ),
    ).toEqual(["m1", "tSilent", "m2", "tGone"]);
  });

  test("a line older than the loaded messages waits while older pages are pending", () => {
    const messages = [msg(3, T0 + 60_000), msg(4, T0 + 70_000, 1)];
    const turns = [turn("tOld", T0 + 8_000, [2]), turn("tB", T0 + 68_000, [4])];
    const pending = buildTimeline(messages, [], 0, turns, true);
    expect(lines(pending)).toEqual([]);
    expect(onMessage(pending)).toEqual({ "m-4": "tB" });
    // Nothing older left to load: the old turn's line shows.
    expect(lines(buildTimeline(messages, [], 0, turns, false))).toEqual([
      "tOld",
    ]);
  });
});

describe("the figure itself", () => {
  test("shows the input tokens and nothing else before it is opened", () => {
    render(
      <UsageFigure usage={turn("tA", T0).usage} timing={turn("tA", T0)} />,
    );
    const text = screen.getByTestId("token-usage").textContent ?? "";
    expect(text.replace(/ /g, " ")).toBe("1.6K input tokens");
    expect(screen.queryByTestId("token-usage-detail") === null).toBe(true);
  });

  test("a total with no call renders nothing, not a zero", () => {
    render(
      <UsageFigure
        usage={{
          calls: 0,
          promptTokens: 0,
          cachedReadTokens: 0,
          cacheCreationTokens: 0,
          completionTokens: 0,
          byNode: {},
        }}
        label="Tokens"
      />,
    );
    expect(screen.queryByTestId("token-usage") === null).toBe(true);
  });
});
