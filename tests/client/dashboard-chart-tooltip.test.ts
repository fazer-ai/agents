/// <reference lib="dom" />

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { createElement } from "react";
import { I18nextProvider } from "react-i18next";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import clientEn from "@/client/locales/en.json";
import clientPt from "@/client/locales/pt-BR.json";
import {
  type ChartRow,
  LineTrend,
  StackedBars,
} from "@/client/pages/dashboard/charts";

// A CHART WITH MORE SERIES THAN COLOURS. Eleven segments a day: the legend names at most eight
// entries, each in a colour no other entry has, and the tooltip lists the largest rows of the day
// with the rest summed in one line, drawn above the legend.

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
    ...container.querySelectorAll<HTMLElement>(".recharts-legend-item"),
  ].map((li) => ({
    text: li.textContent ?? "",
    color: (() => {
      const icon = li.querySelector("path");
      const fill = icon?.getAttribute("fill");
      return fill && fill !== "none"
        ? fill
        : (icon?.getAttribute("stroke") ?? "");
    })(),
  }));
}

function renderChart(
  el: typeof StackedBars | typeof LineTrend,
  props: Parameters<typeof StackedBars>[0],
) {
  return render(
    createElement(
      I18nextProvider,
      { i18n },
      createElement(ThemeProvider, null, createElement(el, props)),
    ),
  );
}

describe("a stacked chart with more series than colours", () => {
  for (const theme of ["dark", "light"] as const)
    test(`folds the smallest into one Other and gives every entry a colour of its own (${theme})`, async () => {
      setTheme(theme);
      const { container } = renderChart(StackedBars, {
        data,
        series,
        lang: "en",
        format: String,
      });
      const items = await waitFor(() => {
        const l = legend(container);
        if (l.length === 0) throw new Error("no legend yet");
        return l;
      });
      // The legend follows the stack, with Other last.
      expect(items.map((i) => i.text)).toEqual([
        "Node 4",
        "Node 5",
        "Node 6",
        "Node 7",
        "Node 8",
        "Node 9",
        "Node 10",
        "Other",
      ]);
      expect(new Set(items.map((i) => i.color)).size).toBe(items.length);
      // "Other" has no identity: it takes the neutral ink, not a ninth hue.
      expect(items.at(-1)?.color).toBe(
        document.documentElement.style.getPropertyValue("--color-text-muted"),
      );
    });

  test("lists the day's largest rows, the rest in one line, and the total", async () => {
    const { container } = renderChart(StackedBars, {
      data,
      series,
      lang: "en",
      format: String,
    });
    const tip = await hover(container, 1, 2);
    const rows = [...tip.querySelectorAll("li")].map((li) => li.textContent);
    // Other (1+2+3+4 = 10) ties Node 9 and sits after it; Node 6..4 (7..5) are summed away.
    expect(rows).toEqual([
      "Node 1011",
      "Node 910",
      "Other10",
      "Node 89",
      "Node 78",
    ]);
    expect(tip.textContent).toContain("+3 more · 18");
    expect(tip.textContent).toContain(
      `Day total ${11 + 10 + 9 + 8 + 7 + 6 + 5 + 10}`,
    );
    expect(tip.style.zIndex).toBe("10");
  });

  test("a day with a series at zero leaves it out of the tooltip", async () => {
    const few = series.slice(0, 4);
    const { container } = renderChart(StackedBars, {
      data,
      series: few,
      lang: "en",
      format: String,
    });
    const tip = await hover(container, 0, 2);
    const rows = [...tip.querySelectorAll("li")].map((li) => li.textContent);
    expect(rows).toEqual(["Node 23", "Node 12", "Node 01"]);
    expect(tip.textContent).not.toContain("more");
  });
});

describe("a line chart with more series than colours", () => {
  test("draws the lines past the palette as one unnamed group, and does not add them up", async () => {
    const { container } = renderChart(LineTrend, {
      data,
      series: series.slice(0, 10),
      lang: "en",
      format: String,
    });
    const items = await waitFor(() => {
      const l = legend(container);
      if (l.length === 0) throw new Error("no legend yet");
      return l;
    });
    expect(items.map((i) => i.text)).toEqual([
      ...series.slice(0, 8).map((s) => s.label),
      "Others (2)",
    ]);
    expect(new Set(items.map((i) => i.color)).size).toBe(items.length);
    const tip = await hover(container, 1, 2);
    expect(tip.querySelectorAll("li")).toHaveLength(5);
    expect(tip.textContent).toContain("+5 more");
    expect(tip.textContent).not.toContain("·");
    expect(tip.textContent).not.toContain("Total");
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
    expect(tip.querySelectorAll("li")).toHaveLength(5);
    expect(tip.textContent).toContain("+3 more");
    expect(tip.textContent).not.toContain("·");
  });
});
