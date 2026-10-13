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
import { createElement } from "react";
import { ThemeProvider } from "@/client/contexts/ThemeContext";
import {
  type ChartRow,
  LineTrend,
  StackedBars,
} from "@/client/pages/dashboard/charts";

// A DAY UNDER A BAND STILL EXPLAINS ITSELF ON HOVER. Every series is null on a day still loading and
// on a day retention emptied, and the tooltip is where the chart says which of the two it is.

const WIDTH = 600;
const HEIGHT = 260;

// happy-dom has no layout: the chart's container and wrapper are given a size, so the pointer maps
// onto the axis; nothing else is.
const measure = HTMLElement.prototype.getBoundingClientRect;
beforeAll(() => {
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

afterEach(() => cleanup());

const data: ChartRow[] = [
  { day: "2026-01-01", turns: 1, state: "ready" },
  { day: "2026-01-02", turns: null, state: "loading" },
  { day: "2026-01-03", turns: null, state: "noData" },
  { day: "2026-01-04", turns: 4, state: "ready" },
];

// The plot starts after the Y axis (64 px) and ends before the right margin (12 px); four bands.
function centerOf(i: number): number {
  const band = (WIDTH - 64 - 12) / data.length;
  return 64 + band * (i + 0.5);
}

async function tooltipAt(container: HTMLElement, i: number): Promise<string> {
  const wrapper = await waitFor(() => {
    const w = container.querySelector(".recharts-wrapper");
    if (!w || !container.querySelector(".recharts-surface"))
      throw new Error("no chart yet");
    return w;
  });
  // Off the chart first, so the tooltip of the previous hover is not read as this one's.
  fireEvent.mouseLeave(wrapper);
  await waitFor(() => {
    const prev = container.querySelector<HTMLElement>(
      ".recharts-tooltip-wrapper",
    );
    if (prev && prev.style.visibility !== "hidden")
      throw new Error("previous tooltip still shown");
  });
  fireEvent.mouseMove(wrapper, { clientX: centerOf(i), clientY: HEIGHT / 2 });
  return waitFor(() => {
    const shown = container.querySelector<HTMLElement>(
      ".recharts-tooltip-wrapper",
    );
    const label = shown?.querySelector(".recharts-tooltip-label");
    // Recharts keeps the last tooltip in the DOM and hides it, so a tooltip is only one shown.
    if (!label?.textContent || shown?.style.visibility === "hidden")
      throw new Error(`no tooltip shown (${label?.textContent ?? "none"})`);
    return label.textContent;
  });
}

const charts = [
  ["the line chart", LineTrend],
  ["the bar chart", StackedBars],
] as const;

describe("a day under a band", () => {
  for (const [name, Chart] of charts) {
    test(`${name} says on hover that a day is still loading, and that one has no data`, async () => {
      const { container } = render(
        createElement(
          ThemeProvider,
          null,
          createElement(Chart, {
            data,
            series: [{ key: "turns", label: "Turns" }],
            lang: "en",
            format: String,
          }),
        ),
      );
      // A day with its figure reads as the day alone.
      expect(await tooltipAt(container, 0)).toBe("Jan 1");
      expect(await tooltipAt(container, 1)).toContain("computing");
      expect(await tooltipAt(container, 2)).toContain("no data");
    });
  }
});
