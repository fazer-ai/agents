/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { Coins } from "lucide-react";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import { Block } from "@/client/pages/dashboard/Block";
import {
  type ChartRow,
  LineTrend,
  StackedBars,
} from "@/client/pages/dashboard/charts";

// A CHART WITH MORE SERIES THAN COLOURS. Eleven segments a day: the legend names at most eight
// entries, each in a colour no other entry has, in the order of the stack; the tooltip summarises
// the day top to bottom as drawn, with one "Others" line; a click opens the day's every series.

const WIDTH = 600;
const HEIGHT = 260;

const i18n = i18next.createInstance();
const css = await Bun.file("public/index.css").text();

// happy-dom loads no stylesheet: a theme's colour tokens are set on the root, as the page's own
// stylesheet would.
function setTheme(theme: "dark" | "light") {
  const block =
    theme === "dark"
      ? css.slice(css.indexOf("@theme static"), css.indexOf("body {"))
      : css.slice(css.indexOf('html[data-theme="light"]'));
  const end = theme === "dark" ? block.length : block.indexOf("\n}");
  for (const m of block.slice(0, end).matchAll(/(--color-[\w-]+):\s*([^;]+);/g))
    document.documentElement.style.setProperty(m[1] ?? "", m[2] ?? "");
}
const measure = HTMLElement.prototype.getBoundingClientRect;
beforeAll(async () => {
  setTheme("dark");
  await i18n.init({
    lng: "en",
    resources: {
      en: { translation: clientEn },
      "pt-BR": { translation: clientPt },
    },
    interpolation: { escapeValue: false },
  });
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return this.classList.contains("recharts-responsive-container") ||
      this.classList.contains("recharts-wrapper")
      ? DOMRect.fromRect({ x: 0, y: 0, width: WIDTH, height: HEIGHT })
      : measure.call(this);
  };
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = measure;
});
afterEach(() => {
  cleanup();
  setTheme("dark");
});

const N = 11;
const series = Array.from({ length: N }, (_, i) => ({
  key: `n${i}`,
  label: `Node ${i}`,
}));
// Node i costs i+1 on each day, except Node 3, at zero on the first day.
const data: ChartRow[] = ["2026-01-01", "2026-01-02"].map((day, d) => ({
  day,
  state: "ready",
  ...Object.fromEntries(
    series.map((s, i) => [s.key, d === 0 && i === 3 ? 0 : i + 1]),
  ),
}));

function centerOf(i: number, days: number): number {
  const band = (WIDTH - 64 - 12) / days;
  return 64 + band * (i + 0.5);
}

async function hover(container: HTMLElement, i: number, days: number) {
  const wrapper = await waitFor(() => {
    const w = container.querySelector(".recharts-wrapper");
    if (!w || !container.querySelector(".recharts-surface"))
      throw new Error("no chart yet");
    return w;
  });
  fireEvent.mouseMove(wrapper, {
    clientX: centerOf(i, days),
    clientY: HEIGHT / 2,
  });
  return waitFor(() => {
    const shown = container.querySelector<HTMLElement>(
      ".recharts-tooltip-wrapper",
    );
    if (!shown?.querySelector("li") || shown.style.visibility === "hidden")
      throw new Error("no tooltip shown");
    return shown;
  });
}

function legend(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>(
      '[data-testid="chart-legend"] > li',
    ),
  ].map((li) => ({
    key: li.dataset.seriesKey ?? "",
    text: li.textContent ?? "",
    color:
      li.querySelector<HTMLElement>("[data-legend-key]")?.style.background ??
      "",
    ink: li.querySelector<HTMLElement>("[data-legend-key] + span")?.style.color,
  }));
}

async function legendOf(container: HTMLElement) {
  return waitFor(() => {
    const l = legend(container);
    if (l.length === 0) throw new Error("no legend yet");
    return l;
  });
}

const token = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

// The names wear text ink; only the keys carry the series colours.
function expectTextInkNames(items: ReturnType<typeof legend>) {
  expect(new Set(items.map((i) => i.ink))).toEqual(
    new Set([token("--color-text-secondary")]),
  );
}

const lines = (root: Element) =>
  [...root.querySelectorAll("li")].map((li) => li.textContent);

function renderChart(
  el: typeof StackedBars | typeof LineTrend,
  props: Parameters<typeof LineTrend>[0],
) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(
        ThemeProvider,
        null,
        createElement(
          TooltipProvider,
          null,
          createElement(el as typeof LineTrend, props),
        ),
      ),
    ),
  );
}

const stacked = { data, series, lang: "en", format: String };

describe("a stacked chart with more series than colours", () => {
  for (const theme of ["dark", "light"] as const)
    test(`reads its legend from the base of the stack, Others last, each entry in a colour of its own (${theme})`, async () => {
      setTheme(theme);
      const { container } = renderChart(StackedBars, stacked);
      const items = await legendOf(container);
      expect(items.map((i) => i.text)).toEqual([
        "Node 10",
        "Node 9",
        "Node 8",
        "Node 7",
        "Node 6",
        "Node 5",
        "Node 4",
        "Others (4)",
      ]);
      expect(new Set(items.map((i) => i.color)).size).toBe(items.length);
      expectTextInkNames(items);
      // "Others" has no identity: it takes the neutral ink, not a ninth hue.
      expect(items.at(-1)?.color).toBe(token("--color-text-muted"));
      // The colour follows the series, not its rank: Node 4 comes first among the kept in the
      // caller's order, so it wears the first colour though it sits last in the legend.
      expect(items[6]?.color).toBe(token("--color-chart-1"));
      expect(items[0]?.color).toBe(token("--color-chart-7"));
    });

  test("summarises the day top to bottom as drawn, with one Others line on top and the total in the header", async () => {
    const { container } = renderChart(StackedBars, stacked);
    const tip = await hover(container, 1, 2);
    // Node 4 and Node 5 (5 and 6) join the group (1+2+3+4 = 10), which sits right above them.
    expect(lines(tip)).toEqual([
      "Others (6)21",
      "Node 67",
      "Node 78",
      "Node 89",
      "Node 910",
      "Node 1011",
    ]);
    expect(tip.textContent).toContain("Day total 66");
    expect(tip.textContent).toContain("Click to see every series");
    expect(tip.textContent).not.toContain("more");
    expect(tip.style.zIndex).toBe("10");
  });

  test("keeps the same order on every day, whatever that day's values", async () => {
    // B outweighs A on the first day, A outweighs B over the window: A is the base on both days.
    const skewed: ChartRow[] = data.map((r, d) => ({
      day: r.day,
      state: "ready",
      a: d === 0 ? 1 : 10,
      b: d === 0 ? 5 : 1,
    }));
    const { container } = renderChart(StackedBars, {
      ...stacked,
      data: skewed,
      series: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
    });
    expect((await legendOf(container)).map((i) => i.text)).toEqual(["A", "B"]);
    expect(lines(await hover(container, 0, 2))).toEqual(["B5", "A1"]);
    expect(lines(await hover(container, 1, 2))).toEqual(["B1", "A10"]);
  });

  test("a day with a series at zero leaves it out of the tooltip", async () => {
    const { container } = renderChart(StackedBars, {
      ...stacked,
      series: series.slice(0, 4),
    });
    const tip = await hover(container, 0, 2);
    expect(lines(tip)).toEqual(["Node 01", "Node 12", "Node 23"]);
    expect(tip.textContent).not.toContain("Others");
  });

  test("a click opens the day's every series, the group's members included, with shares, and closes", async () => {
    const { container } = renderChart(StackedBars, stacked);
    await hover(container, 1, 2);
    const wrapper = container.querySelector(".recharts-wrapper") as Element;
    fireEvent.click(wrapper, { clientX: centerOf(1, 2), clientY: HEIGHT / 2 });
    const detail = await waitFor(() => {
      const d = container.querySelector('[data-testid="chart-day-detail"]');
      if (!d) throw new Error("no detail yet");
      return d;
    });
    const keys = [...detail.querySelectorAll("li")].map(
      (li) => (li as HTMLElement).dataset.seriesKey,
    );
    expect(keys).toEqual([
      "__other",
      "n0",
      "n3",
      "n1",
      "n2",
      "n4",
      "n5",
      "n6",
      "n7",
      "n8",
      "n9",
      "n10",
    ]);
    expect(lines(detail)[0]).toBe("Others (4)1015.2%");
    expect(lines(detail).at(-1)).toBe("Node 101116.7%");
    expect(detail.textContent).toContain("Day total 66");
    fireEvent.click(
      detail.querySelector(
        'button[aria-label="Close the day\'s detail"]',
      ) as Element,
    );
    await waitFor(() => {
      if (container.querySelector('[data-testid="chart-day-detail"]'))
        throw new Error("still open");
    });
  });

  test("Escape closes the detail from wherever the focus is after the click", async () => {
    const { container } = renderChart(StackedBars, stacked);
    await hover(container, 1, 2);
    const wrapper = container.querySelector(".recharts-wrapper") as Element;
    fireEvent.click(wrapper, { clientX: centerOf(1, 2), clientY: HEIGHT / 2 });
    await waitFor(() => {
      if (!container.querySelector('[data-testid="chart-day-detail"]'))
        throw new Error("no detail yet");
    });
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await waitFor(() => {
      if (container.querySelector('[data-testid="chart-day-detail"]'))
        throw new Error("still open");
    });
  });

  test("a series falling into Others leaves every other series in its colour", async () => {
    const { container, rerender } = renderChart(StackedBars, stacked);
    const before = new Map(
      (await legendOf(container)).map((i) => [i.key, i.color]),
    );
    // Node 7 drops to nothing and joins the group; Node 2, the largest of the group, takes its place.
    // Node 2 comes first in the caller's order, so a fresh assignment would shift every colour.
    const shifted: ChartRow[] = data.map((r) => ({ ...r, n7: 0 }));
    rerender(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          ThemeProvider,
          null,
          createElement(
            TooltipProvider,
            null,
            createElement(StackedBars, { ...stacked, data: shifted }),
          ),
        ),
      ),
    );
    const after = await waitFor(() => {
      const l = legend(container);
      if (!l.some((i) => i.key === "n2")) throw new Error("not re-ranked yet");
      return new Map(l.map((i) => [i.key, i.color]));
    });
    expect(after.has("n7")).toBe(false);
    for (const key of ["n4", "n5", "n6", "n8", "n9", "n10"])
      expect(after.get(key)).toBe(before.get(key));
    expect(after.get("n2")).toBe(before.get("n7"));
  });

  test("the Others legend entry names its members on a click, which a tap and Enter also are", async () => {
    const { container } = renderChart(StackedBars, stacked);
    await legendOf(container);
    const other = container.querySelector(
      '[data-testid="chart-legend"] > li[data-series-key="__other"] button',
    ) as HTMLElement;
    fireEvent.click(other);
    const members = await waitFor(() => {
      const m = document.querySelector('[data-testid="chart-legend-members"]');
      if (!m) throw new Error("no members yet");
      return m;
    });
    // Top to bottom, as the group's members would stack: the smallest first, like the day detail.
    expect(lines(members)).toEqual(["Node 0", "Node 3", "Node 1", "Node 2"]);
    // A long group scrolls inside the room the screen has.
    expect(members.closest(".overflow-y-auto")).not.toBeNull();
  });

  test("hides only the drawing from a screen reader: the legend and the day detail stay reachable", async () => {
    const { container } = render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(
          ThemeProvider,
          null,
          createElement(
            TooltipProvider,
            null,
            createElement(
              Block,
              {
                icon: Coins,
                title: "Daily cost",
                chart: true,
              } as Parameters<typeof Block>[0],
              createElement(StackedBars, stacked),
            ),
          ),
        ),
      ),
    );
    await hover(container, 1, 2);
    fireEvent.click(container.querySelector(".recharts-wrapper") as Element, {
      clientX: centerOf(1, 2),
      clientY: HEIGHT / 2,
    });
    const detail = await waitFor(() => {
      const d = container.querySelector('[data-testid="chart-day-detail"]');
      if (!d) throw new Error("no detail yet");
      return d;
    });
    expect(
      container
        .querySelector(".recharts-wrapper")
        ?.closest("[aria-hidden='true']"),
    ).not.toBeNull();
    expect(detail.closest("[aria-hidden='true']")).toBeNull();
    expect(document.activeElement).toBe(detail);
    expect(
      container
        .querySelector('[data-testid="chart-legend"]')
        ?.closest("[aria-hidden='true']"),
    ).toBeNull();
  });
});

describe("a line chart with more series than colours", () => {
  test("draws the lines past the palette as one group, last in the legend, and does not add them up", async () => {
    const { container } = renderChart(LineTrend, {
      data,
      series: series.slice(0, 10),
      lang: "en",
      format: String,
    });
    const items = await legendOf(container);
    expect(items.map((i) => i.text)).toEqual([
      "Node 9",
      "Node 8",
      "Node 7",
      "Node 6",
      "Node 5",
      "Node 4",
      "Node 2",
      "Others (3)",
    ]);
    expect(new Set(items.map((i) => i.color)).size).toBe(items.length);
    expectTextInkNames(items);
    const tip = await hover(container, 1, 2);
    // The day's highest first, as the lines sit; what does not fit joins the group, last.
    expect(lines(tip)).toEqual([
      "Node 910",
      "Node 89",
      "Node 78",
      "Node 67",
      "Node 56",
      "Others (5)",
    ]);
    expect(tip.textContent).not.toContain("·");
    expect(tip.textContent).not.toContain("Total");
    expect(tip.textContent).not.toContain("Click");
  });

  test("lists a day by that day's values, so the order follows the lines where they cross", async () => {
    const crossing: ChartRow[] = data.map((r, d) => ({
      day: r.day,
      state: "ready",
      a: d === 0 ? 0.9 : 0.1,
      b: d === 0 ? 0.2 : 0.8,
    }));
    const { container } = renderChart(LineTrend, {
      data: crossing,
      series: [
        { key: "a", label: "A" },
        { key: "b", label: "B" },
      ],
      lang: "en",
      format: String,
    });
    expect((await legendOf(container)).map((i) => i.text)).toEqual(["A", "B"]);
    expect(lines(await hover(container, 0, 2))).toEqual(["A0.9", "B0.2"]);
    expect(lines(await hover(container, 1, 2))).toEqual(["B0.8", "A0.1"]);
  });

  test("a click on a point opens no day detail", async () => {
    const { container } = renderChart(LineTrend, {
      data,
      series: series.slice(0, 3),
      lang: "en",
      format: String,
    });
    await hover(container, 1, 2);
    fireEvent.click(container.querySelector(".recharts-wrapper") as Element, {
      clientX: centerOf(1, 2),
      clientY: HEIGHT / 2,
    });
    expect(
      container.querySelector('[data-testid="chart-day-detail"]'),
    ).toBeNull();
  });
});

describe("a context line with a single value", () => {
  test("still marks the value", async () => {
    // Node 9 is a context line with a small value on the first day only: no segment to draw.
    const lone: ChartRow[] = data.map((r, d) => ({
      ...r,
      n9: d === 0 ? 0.5 : null,
    }));
    const { container } = renderChart(LineTrend, {
      data: lone,
      series: series.slice(0, 10),
      lang: "en",
      format: String,
    });
    const dots = await waitFor(() => {
      const groups = container.querySelectorAll(".recharts-line-dots");
      if (groups.length < 10) throw new Error("dots not drawn yet");
      // The context lines are drawn first, under the kept ones, smallest last.
      return groups[2]?.querySelectorAll("circle") ?? [];
    });
    expect(dots.length).toBe(1);
  });
});

describe("a line at zero", () => {
  test("shows the zero with its previous-period value", async () => {
    const rows: ChartRow[] = data.map((r) => ({
      day: r.day,
      state: "ready",
      rate: 0,
      ratePrev: 0.8,
    }));
    const { container } = renderChart(LineTrend, {
      data: rows,
      series: [{ key: "rate", label: "Resolution" }],
      lang: "en",
      format: String,
      compare: { rate: "ratePrev" },
      compareLabel: "previous",
    });
    const tip = await hover(container, 1, 2);
    expect(lines(tip)).toEqual(["Resolution0 (previous: 0.8)"]);
  });
});

describe("a stacked day with no cost", () => {
  test("reads as the day and a zero total, with no rows", async () => {
    const empty: ChartRow[] = data.map((r, d) =>
      d === 0
        ? {
            day: r.day,
            state: "ready",
            ...Object.fromEntries(series.slice(0, 3).map((s) => [s.key, 0])),
          }
        : r,
    );
    const { container } = renderChart(StackedBars, {
      data: empty,
      series: series.slice(0, 3),
      lang: "en",
      format: String,
    });
    const wrapper = await waitFor(() => {
      const w = container.querySelector(".recharts-wrapper");
      if (!w || !container.querySelector(".recharts-surface"))
        throw new Error("no chart yet");
      return w;
    });
    fireEvent.mouseMove(wrapper, {
      clientX: centerOf(0, 2),
      clientY: HEIGHT / 2,
    });
    const tip = await waitFor(() => {
      const shown = container.querySelector<HTMLElement>(
        ".recharts-tooltip-wrapper",
      );
      if (!shown?.textContent?.includes("Day total"))
        throw new Error("no total shown");
      return shown;
    });
    expect(tip.textContent).toContain("Day total 0");
    expect(tip.querySelectorAll("li")).toHaveLength(0);
  });
});

describe("the context lines of a line chart", () => {
  test("all go by the one Others name, never their own", async () => {
    const { container } = renderChart(LineTrend, {
      data,
      series: series.slice(0, 11),
      lang: "en",
      format: String,
    });
    const names = await waitFor(() => {
      const curves = [...container.querySelectorAll(".recharts-line-curve")];
      if (curves.length < 11) throw new Error("lines not drawn yet");
      return curves.map((l) => l.getAttribute("name"));
    });
    expect(names.slice(0, 4)).toEqual([
      "Others (4)",
      "Others (4)",
      "Others (4)",
      "Others (4)",
    ]);
  });
});

describe("a line chart within the palette", () => {
  test("names how many rows it leaves out, without adding rates", async () => {
    const { container } = renderChart(LineTrend, {
      data,
      series: series.slice(0, 8),
      lang: "en",
      format: String,
    });
    const tip = await hover(container, 1, 2);
    expect(lines(tip)).toHaveLength(6);
    expect(lines(tip).at(-1)).toBe("Others (3)");
    expect(tip.textContent).not.toContain("·");
  });
});

// WCAG relative luminance, for the 3:1 a chart mark needs against the card it sits on.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

describe("the chart colours", () => {
  for (const theme of ["dark", "light"] as const)
    test(`clear 3:1 against the card surface (${theme})`, () => {
      setTheme(theme);
      const card = luminance(token("--color-bg-secondary").trim());
      const low = Array.from({ length: 8 }, (_, i) =>
        token(`--color-chart-${i + 1}`).trim(),
      ).filter((c) => {
        const [hi, lo] = [luminance(c), card].sort((a, b) => b - a);
        return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05) < 3;
      });
      expect(low).toEqual([]);
    });
});
