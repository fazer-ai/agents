/// <reference lib="dom" />

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { UsageFigure } from "@/client/components/TokenUsage";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import {
  buildTimeline,
  type Message,
  type TurnUsageEntry,
} from "@/client/pages/conversationTimeline";
import { PRICE_TABLE_READ_AT } from "@/modules/pricing/version";

// Issues #853 and #858: each agent turn's spend sits at the foot of the last message the turn
// created that is on screen. A turn with none on screen (silent, older than the loaded page, from
// before its messages were recorded) keeps a line in the timeline at the time of its last billed
// call, and while older pages are still to load a line older than the oldest loaded message waits
// for them instead of stacking above the first bubble.

afterEach(() => {
  cleanup();
});

// The real catalogs, so a figure reads the way the operator reads it, whatever ran before this file.
async function inLanguage(lng: "en" | "pt-BR", ui: ReactNode) {
  const i = i18next.createInstance();
  await i.init({
    lng,
    resources: {
      en: { translation: clientEn },
      "pt-BR": { translation: clientPt },
    },
    interpolation: { escapeValue: false },
  });
  return render(<I18nextProvider i18n={i}>{ui}</I18nextProvider>);
}

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
      costUsd: 0,
      unpricedCalls: 2,
      olderTablePricedCalls: 0,
      tenantPricedCalls: 0,
      reportedPricedCalls: 0,
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
  test("shows the input tokens and nothing else before it is opened", async () => {
    await inLanguage(
      "en",
      <UsageFigure usage={turn("tA", T0).usage} timing={turn("tA", T0)} />,
    );
    const text = screen.getByTestId("token-usage").textContent ?? "";
    expect(text.replace(/ /g, " ")).toBe("1.6K input tokens");
    expect(screen.queryByTestId("token-usage-detail") === null).toBe(true);
  });

  // Issue #863: the cost is in the popover and nowhere else.
  const priced = (costUsd: number, unpricedCalls: number) => ({
    ...turn("tA", T0).usage,
    costUsd,
    unpricedCalls,
  });
  const open = () => {
    fireEvent.click(screen.getByTestId("token-usage"));
    return screen.getByTestId("token-usage-detail").textContent ?? "";
  };

  test("the cost shows only once the popover is open", async () => {
    await inLanguage("en", <UsageFigure usage={priced(0.001234, 0)} />);
    expect(screen.getByTestId("token-usage").textContent).not.toContain("$");
    const detail = open();
    expect(detail).toContain("$0.001234");
    // How old the rates are, as a date the reader's locale writes.
    expect(detail).toContain(
      `price table of ${new Intl.DateTimeFormat("en", { dateStyle: "short" }).format(new Date(`${PRICE_TABLE_READ_AT}T12:00:00Z`))}`,
    );
    expect(detail).not.toContain("no price are not in it");
  });

  test("a turn nothing could price says so, and shows no dollar figure", async () => {
    await inLanguage("en", <UsageFigure usage={priced(0, 2)} />);
    const detail = open();
    expect(detail).toContain("no price");
    expect(detail).not.toContain("$");
  });

  test("a total with unpriced calls says how many it leaves out", async () => {
    await inLanguage("en", <UsageFigure usage={priced(0.25, 1)} />);
    const detail = open();
    expect(detail).toContain("$0.25");
    expect(detail).toContain("1 call with no price is not in it");
  });

  test("in Portuguese, the words and the currency are the operator's", async () => {
    await inLanguage(
      "pt-BR",
      <UsageFigure usage={{ ...priced(0.25, 2), calls: 3 }} />,
    );
    const detail = open().replace(/\u00a0/g, " ");
    expect(detail).toContain("US$ 0,25");
    expect(detail).toContain("2 chamadas sem preço ficaram de fora");
  });

  // A figure an older table priced is not dated with today's table.
  test("a figure with calls an older table priced does not carry the current table's date", async () => {
    await inLanguage(
      "en",
      <UsageFigure usage={{ ...priced(0.25, 0), olderTablePricedCalls: 1 }} />,
    );
    const detail = open();
    expect(detail).toContain(
      "Estimated from the price tables in force when the calls were made",
    );
    expect(detail).not.toContain("price table of");
  });

  // Issue #865: the line under the figure says whose prices it used.
  test("a figure priced by the tenant's own prices says so, and a mixed one names both", async () => {
    await inLanguage(
      "en",
      <UsageFigure usage={{ ...priced(0.25, 0), tenantPricedCalls: 2 }} />,
    );
    const own = open();
    expect(own).toContain("From this tenant's own prices");
    expect(own).not.toContain("price table of");
    cleanup();
    await inLanguage(
      "en",
      <UsageFigure usage={{ ...priced(0.25, 0), tenantPricedCalls: 1 }} />,
    );
    expect(open()).toContain(
      "From this tenant's own prices and the price table of",
    );
    cleanup();
    await inLanguage(
      "en",
      <UsageFigure
        usage={{
          ...priced(0.25, 0),
          tenantPricedCalls: 1,
          olderTablePricedCalls: 1,
        }}
      />,
    );
    expect(open()).toContain(
      "From this tenant's own prices and the price tables in force when the calls were made",
    );
  });

  // Issue #866: an OpenRouter call carries what OpenRouter charged, which is no table estimate.
  test("a figure OpenRouter reported says so, and three sources are named together", async () => {
    await inLanguage(
      "en",
      <UsageFigure usage={{ ...priced(0.25, 0), reportedPricedCalls: 2 }} />,
    );
    const reported = open();
    expect(reported).toContain("What OpenRouter reported it charged");
    expect(reported).not.toContain("price table of");
    cleanup();
    await inLanguage(
      "en",
      <UsageFigure
        usage={{
          ...priced(0.25, 0),
          calls: 3,
          tenantPricedCalls: 1,
          reportedPricedCalls: 1,
        }}
      />,
    );
    expect(open()).toContain(
      "From this tenant's own prices, what OpenRouter reported, and the price table of",
    );
    cleanup();
    await inLanguage(
      "pt-BR",
      <UsageFigure
        usage={{
          ...priced(0.25, 0),
          tenantPricedCalls: 1,
          reportedPricedCalls: 1,
        }}
      />,
    );
    expect(open()).toContain(
      "Calculado pelos preços próprios deste tenant e pelo que a OpenRouter informou",
    );
  });

  test("a total with no call renders nothing, not a zero", async () => {
    await inLanguage(
      "en",
      <UsageFigure
        usage={{
          calls: 0,
          promptTokens: 0,
          cachedReadTokens: 0,
          cacheCreationTokens: 0,
          completionTokens: 0,
          byNode: {},
          costUsd: 0,
          unpricedCalls: 0,
          olderTablePricedCalls: 0,
          tenantPricedCalls: 0,
          reportedPricedCalls: 0,
        }}
        label="Tokens"
      />,
    );
    expect(screen.queryByTestId("token-usage") === null).toBe(true);
  });
});
