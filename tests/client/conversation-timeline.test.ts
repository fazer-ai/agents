import { describe, expect, test } from "bun:test";
import type { TFunction } from "i18next";
import {
  buildTimeline,
  followUpBadgeText,
  type Message,
  type TrailEntry,
} from "@/client/pages/conversationTimeline";

// Issue #846: a proactive bubble said "Follow-up" whatever sent it, and the bubble was picked by time
// (the first outgoing message up to five minutes after the line). The badge now says where the turn
// came from, and a turn that recorded the message it sent badges exactly that message; a line from
// before that keeps the time guess.

const T0 = Date.parse("2026-09-24T12:00:00Z");

function msg(id: number, atMs: number, messageType = 1): Message {
  return {
    id,
    content: `m${id}`,
    messageType,
    createdAt: Math.floor(atMs / 1000),
    attachments: [],
  } as unknown as Message;
}

function entry(over: Partial<TrailEntry> & { id: string }): TrailEntry {
  return {
    kind: "followup",
    name: "followup",
    status: "ok",
    durationMs: null,
    step: null,
    args: null,
    output: null,
    errorMessage: null,
    turnDelivered: null,
    originRecorded: true,
    messageId: null,
    integrationName: null,
    at: new Date(T0).toISOString(),
    ...over,
  } as TrailEntry;
}

const markers = (tl: ReturnType<typeof buildTimeline>) =>
  tl.items.flatMap((i) => (i.kind === "trail" ? [i.entry.id] : []));

describe("which bubble a proactive turn badges", () => {
  test("a recorded event badges the message it sent, not the first outgoing one after it", async () => {
    const reply = msg(10, T0 + 30_000); // an ordinary reply, inside the old five-minute window
    const sent = msg(11, T0 + 60_000);
    const tl = buildTimeline(
      [reply, sent],
      [
        entry({
          id: "e1",
          kind: "event",
          name: "GENERIC",
          messageId: 11,
          integrationName: "ERP da loja",
        }),
      ],
      3,
    );
    expect([...tl.followUpBadges.keys()]).toEqual(["m-11"]);
    expect(tl.followUpBadges.get("m-11")).toEqual({
      kind: "event",
      step: null,
      total: 3,
      integrationName: "ERP da loja",
    });
    expect(markers(tl)).toEqual([]);
  });

  test("a recorded turn that sent nothing badges nothing, however close a reply is", async () => {
    const tl = buildTimeline(
      [msg(20, T0 + 10_000)],
      [entry({ id: "n1", kind: "event", name: "GENERIC", messageId: null })],
      3,
    );
    expect(tl.followUpBadges.size).toBe(0);
    // It is not lost: it stays a marker on the trail.
    expect(markers(tl)).toEqual(["n1"]);
  });

  test("a recorded message that is not in the loaded page falls back to a marker", async () => {
    const tl = buildTimeline(
      [msg(30, T0 + 10_000)],
      [entry({ id: "r1", kind: "redirect", messageId: 999 })],
      3,
    );
    expect(tl.followUpBadges.size).toBe(0);
    expect(markers(tl)).toEqual(["r1"]);
  });

  test("a line from before #846 keeps the time-window guess", async () => {
    const tl = buildTimeline(
      [msg(40, T0 - 60_000), msg(41, T0 + 20_000), msg(42, T0 + 400_000)],
      [
        entry({
          id: "old",
          kind: "followup",
          step: 2,
          originRecorded: false,
          messageId: null,
        }),
      ],
      3,
    );
    expect([...tl.followUpBadges.keys()]).toEqual(["m-41"]);
    expect(tl.followUpBadges.get("m-41")?.step).toBe(2);
  });

  test("only the inactivity sequence anchors the 'complete' line", async () => {
    const tl = buildTimeline(
      [msg(60, T0 + 1_000), msg(61, T0 + 2_000)],
      [
        entry({ id: "f", kind: "followup", step: 3, messageId: 60 }),
        entry({
          id: "e",
          kind: "event",
          messageId: 61,
          at: new Date(T0 + 1_500).toISOString(),
        }),
      ],
      3,
    );
    expect(tl.followUpBadges.size).toBe(2);
    expect(tl.lastFollowUpKey).toBe("m-60");
  });

  test("a reminder stays a trail marker, as it always was", async () => {
    const tl = buildTimeline(
      [msg(70, T0 + 1_000)],
      [entry({ id: "rem", kind: "reminder", messageId: 70 })],
      3,
    );
    expect(tl.followUpBadges.size).toBe(0);
    expect(markers(tl)).toEqual(["rem"]);
  });
});

describe("what the badge says", () => {
  // The defaults, interpolated: the words a reader sees before any catalog is loaded.
  const t = ((_key: string, def: string, vars?: Record<string, unknown>) =>
    def.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
      String(vars?.[k] ?? ""),
    )) as unknown as TFunction;
  const b = (over: Partial<Parameters<typeof followUpBadgeText>[0]>) =>
    followUpBadgeText(
      {
        kind: "followup",
        step: null,
        total: 3,
        integrationName: null,
        ...over,
      },
      t,
    );

  test("an event names its integration, or says it was external", () => {
    expect(b({ kind: "event", integrationName: "ERP da loja" })).toBe(
      "Event: ERP da loja",
    );
    expect(b({ kind: "event" })).toBe("External event");
  });

  test("a redirect follow-up has its own label", () => {
    expect(b({ kind: "redirect", step: 1 })).toBe("Redirect follow-up");
  });

  test("an inactivity follow-up keeps N/M", () => {
    expect(b({ step: 2 })).toBe("Follow-up 2/3");
    expect(b({})).toBe("Follow-up");
  });
});
