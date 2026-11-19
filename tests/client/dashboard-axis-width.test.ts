import { describe, expect, test } from "bun:test";
import { axisWidth } from "@/client/pages/dashboard/charts";

const brl = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "USD",
});
const usd = (v: number) => brl.format(v);
const count = (v: number) => String(v);
const rows = (values: number[][]) =>
  values.map((vs, i) => ({
    day: `2026-03-${String(i + 1).padStart(2, "0")}`,
    a: vs[0] ?? null,
    b: vs[1] ?? null,
  }));

describe("the value axis's width", () => {
  test("a short label keeps the axis's own width", () => {
    expect(axisWidth(rows([[3], [7]]), ["a"], false, count)).toBe(64);
  });

  test("a cost past US$ 100 widens the axis to fit its top label", () => {
    const w = axisWidth(rows([[120], [480]]), ["a"], false, usd);
    // NOTE: the top is the scale's, US$ 500,00, ten characters at 11 px.
    expect(usd(500)).toHaveLength(10);
    expect(w).toBeGreaterThan(64);
    expect(w).toBeGreaterThanOrEqual(10 * 6.4 + 10);
  });

  test("a stacked chart sizes the axis by its highest stack, not its highest segment", () => {
    const one = axisWidth(rows([[4, 5]]), ["a", "b"], false, usd);
    const stacked = axisWidth(rows([[4, 5]]), ["a", "b"], true, usd);
    expect(stacked).toBeGreaterThan(one);
  });

  test("a day with no value and an empty chart still get the axis's own width", () => {
    expect(axisWidth(rows([[], []]), ["a"], true, count)).toBe(64);
    expect(axisWidth([], ["a"], false, count)).toBe(64);
  });
});
