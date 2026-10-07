import { describe, expect, test } from "bun:test";
import { toCsv } from "@/client/pages/dashboard/csv";
import {
  DEFAULT_FILTERS,
  daysOf,
  drillDownHref,
  localDayKey,
  previousWindow,
  readFilters,
  trendPointHref,
  windowOf,
  writeFilters,
} from "@/client/pages/dashboard/filters";

// THE DASHBOARD'S FILTER LIVES IN THE URL. A link reproduces the view, a hand-edited link opens on a
// valid view rather than an error, and the window and the period before it are the operator's own
// days.

describe("reading the filter from a link", () => {
  test("a full link reads back exactly", () => {
    const f = readFilters(
      new URLSearchParams("range=7d&agent=12&inbox=3&source=playground"),
    );
    expect(f).toEqual({
      range: "7d",
      from: null,
      to: null,
      agentId: "12",
      inboxId: "3",
      source: "playground",
    });
  });

  test("what does not parse falls back to the default, parameter by parameter", () => {
    const f = readFilters(
      new URLSearchParams("range=forever&agent=abc&inbox=-1&source=prod"),
    );
    expect(f).toEqual(DEFAULT_FILTERS);
  });

  test("a custom range needs two real days in order", () => {
    expect(
      readFilters(
        new URLSearchParams("range=custom&from=2026-09-02&to=2026-09-05"),
      ).range,
    ).toBe("custom");
    for (const q of [
      "range=custom&from=2026-09-05&to=2026-09-02",
      "range=custom&from=2026-02-30&to=2026-03-02",
      "range=custom&from=2026-09-02",
      "range=custom",
    ])
      expect(readFilters(new URLSearchParams(q)).range).toBe(
        DEFAULT_FILTERS.range,
      );
  });

  test("defaults are left out of the URL, and what is written reads back", () => {
    expect(writeFilters(DEFAULT_FILTERS).toString()).toBe("");
    const f = {
      ...DEFAULT_FILTERS,
      range: "custom" as const,
      from: "2026-09-02",
      to: "2026-09-05",
      agentId: "7",
      source: "all" as const,
    };
    expect(readFilters(writeFilters(f))).toEqual(f);
  });
});

describe("the window and the period before it", () => {
  const now = new Date(2026, 9, 6, 15, 30);

  test("seven days ends today, local days", () => {
    const w = windowOf({ ...DEFAULT_FILTERS, range: "7d" }, now);
    expect(w.firstDay).toBe("2026-09-30");
    expect(w.lastDay).toBe("2026-10-06");
    expect(daysOf(w)).toHaveLength(7);
    expect(w.until.getTime()).toBe(new Date(2026, 9, 7).getTime());
  });

  test("the previous period is as long and ends where this one starts", () => {
    const w = windowOf({ ...DEFAULT_FILTERS, range: "7d" }, now);
    const p = previousWindow(w);
    expect(p?.firstDay).toBe("2026-09-23");
    expect(p?.lastDay).toBe("2026-09-29");
    expect(p?.until.getTime()).toBe(w.since?.getTime());
  });

  test("a custom range covers both days; a one-day range is one day", () => {
    const w = windowOf(
      {
        ...DEFAULT_FILTERS,
        range: "custom",
        from: "2026-10-04",
        to: "2026-10-04",
      },
      now,
    );
    expect(daysOf(w)).toEqual(["2026-10-04"]);
    expect(w.days).toBe(1);
    expect(previousWindow(w)?.firstDay).toBe("2026-10-03");
  });

  test("all time has no previous period", () => {
    const w = windowOf({ ...DEFAULT_FILTERS, range: "all" }, now);
    expect(w.since).toBeNull();
    expect(previousWindow(w)).toBeNull();
    expect(daysOf(w, "2026-10-04")).toEqual([
      "2026-10-04",
      "2026-10-05",
      "2026-10-06",
    ]);
  });

  test("a day key is the browser's day", () => {
    expect(localDayKey(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
  });
});

describe("the drill-down link", () => {
  test("carries the window, the outcome and the view's agent and inbox", () => {
    const href = drillDownHref(
      { ...DEFAULT_FILTERS, agentId: "4", inboxId: "9" },
      {
        since: new Date("2026-10-04T03:00:00Z"),
        until: new Date("2026-10-05T03:00:00Z"),
      },
      "handoff",
    );
    const url = new URL(href, "http://x");
    expect(url.pathname).toBe("/conversations");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      createdSince: "2026-10-04T03:00:00.000Z",
      createdUntil: "2026-10-05T03:00:00.000Z",
      outcome: "handoff",
      agentId: "4",
      inboxId: "9",
    });
  });
});

describe("a point of the funnel over time", () => {
  const q = (href: string) =>
    Object.fromEntries(new URL(href, "http://x").searchParams);

  test("on the total chart, the line hit names the outcome; between lines, the whole day", () => {
    expect(
      q(
        trendPointHref(
          DEFAULT_FILTERS,
          "2026-10-04",
          "none",
          "resolution",
          "handoff",
        ),
      ).outcome,
    ).toBe("handoff");
    expect(
      q(
        trendPointHref(
          DEFAULT_FILTERS,
          "2026-10-04",
          "none",
          "resolution",
          "involvement",
        ),
      ).outcome,
    ).toBe("involved");
    expect(
      q(trendPointHref(DEFAULT_FILTERS, "2026-10-04", "none", "resolution"))
        .outcome,
    ).toBe("all");
  });

  test("on a split chart, the line hit narrows to its agent or inbox, and the rate names the outcome", () => {
    const byAgent = q(
      trendPointHref(
        { ...DEFAULT_FILTERS, inboxId: "3" },
        "2026-10-04",
        "agent",
        "handoff",
        "s12",
      ),
    );
    expect(byAgent).toMatchObject({
      outcome: "handoff",
      agentId: "12",
      inboxId: "3",
    });
    const byInbox = q(
      trendPointHref(
        DEFAULT_FILTERS,
        "2026-10-04",
        "inbox",
        "automation",
        "s9",
      ),
    );
    expect(byInbox).toMatchObject({
      outcome: "resolved_by_agent",
      inboxId: "9",
    });
    expect(byInbox.agentId).toBeUndefined();
    const between = q(
      trendPointHref(
        { ...DEFAULT_FILTERS, agentId: "4" },
        "2026-10-04",
        "agent",
        "involvement",
      ),
    );
    expect(between).toMatchObject({ outcome: "involved", agentId: "4" });
  });
});

describe("a block's CSV", () => {
  test("numbers raw, empties empty, and a cell with a comma or quote quoted", () => {
    expect(
      toCsv(
        ["Agent", "Cost", "Rate"],
        [
          ["Ana, SAC", 1.5, 0.25],
          ['O "bot"', null, Number.NaN],
        ],
      ),
    ).toBe('Agent,Cost,Rate\r\n"Ana, SAC",1.5,0.25\r\n"O ""bot""",,');
  });

  test("a header alone is a valid file", () => {
    expect(toCsv(["Day", "Cost"], [])).toBe("Day,Cost");
  });
});
