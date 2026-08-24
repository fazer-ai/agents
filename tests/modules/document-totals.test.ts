import { describe, expect, test } from "bun:test";
import {
  formatDate,
  formatDocumentNumber,
  formatMoney,
  formatNumber,
} from "@/modules/documents/format";
import {
  computeTotals,
  displayedMoney,
  lineTotal,
} from "@/modules/documents/totals";

// The arithmetic as a table. The property that matters is not "the total is right" in the abstract:
// it is that the numbers the renderer PRINTS add up to each other, because a customer reading three
// lines that contradict themselves is the failure this file exists to stop.

const item = (quantity: number, unitPrice: number) => ({
  description: "x",
  quantity,
  unitPrice,
});

describe("computeTotals", () => {
  test("sums in cents, so a float artefact never reaches the page", () => {
    // 3 × 0.1 is 0.30000000000000004 as a float; a document that prints a total one cent off the sum
    // of its own lines is the kind of error a customer photographs.
    expect(computeTotals([item(3, 0.1)]).subtotal).toBe(0.3);
    expect(lineTotal(item(3, 0.1))).toBe(0.3);
    const many = computeTotals(Array.from({ length: 10 }, () => item(1, 0.1)));
    expect(many.subtotal).toBe(1);
  });

  test("an empty document totals zero rather than NaN", () => {
    expect(computeTotals([])).toEqual({
      subtotal: 0,
      discount: 0,
      tax: 0,
      total: 0,
    });
  });

  test("subtracts the discount and adds the tax, which is an amount not a rate", () => {
    const t = computeTotals([item(2, 100)], { discount: 30, tax: 12.5 });
    expect(t).toEqual({ subtotal: 200, discount: 30, tax: 12.5, total: 182.5 });
  });

  // The clamped discount is what comes back, so the printed rows still add up. A discount larger
  // than the subtotal is somebody's mistake either way; a document whose own three numbers
  // contradict each other is the worse way for the customer to find out.
  test("clamps a discount larger than the subtotal, and reports the clamped value", () => {
    const t = computeTotals([item(1, 50)], { discount: 500 });
    expect(t.discount).toBe(50);
    expect(t.total).toBe(0);
    expect(t.subtotal - t.discount + t.tax).toBe(t.total);
  });

  test("ignores a negative discount or tax instead of inflating the total", () => {
    const t = computeTotals([item(1, 100)], { discount: -10, tax: -10 });
    expect(t).toEqual({ subtotal: 100, discount: 0, tax: 0, total: 100 });
  });

  test("the printed rows always add up", () => {
    for (const [q, p, d, x] of [
      [1, 0.01, 0, 0],
      [7, 13.37, 5.05, 1.11],
      [3, 0.1, 0.3, 0],
      [100, 99.99, 1000, 250],
    ] as const) {
      const t = computeTotals([item(q, p)], { discount: d, tax: x });
      expect(t.subtotal - t.discount + t.tax).toBeCloseTo(t.total, 10);
    }
  });
});

describe("format", () => {
  // pt-BR currency output separates the symbol from the number with U+00A0, not a plain space. That
  // is correct typography and is kept; asserting it in CODEPOINTS is what stops a future test from
  // "fixing" it by stripping whitespace, which would stop testing anything.
  test("formats currency in the document's locale, non-breaking space included", () => {
    const brl = formatMoney(1299.9, "pt-BR", "BRL");
    expect([...brl].map((c) => c.codePointAt(0))).toEqual([
      0x52, 0x24, 0x00a0, 0x31, 0x2e, 0x32, 0x39, 0x39, 0x2c, 0x39, 0x30,
    ]);
    expect(formatMoney(1299.9, "en-US", "USD")).toBe("$1,299.90");
    expect(formatMoney(0, "pt-BR", "BRL")).toContain("0,00");
  });

  // The document still has to render. Refusing to produce the PDF over a currency code is worse for
  // the customer than a legible fallback.
  //
  // NOTE: an UNKNOWN three-letter code does not throw — Intl prints it as-is — so the fallback is
  // reached only by a code that is three characters and not three LETTERS, which the style schema
  // (length 3, no character class, per "type and choice, never size") does let through.
  test("prints an unknown currency code, and falls back on a malformed one", () => {
    expect(formatMoney(12.3, "pt-BR", "XYZ")).toBe("XYZ\u00a012,30");
    expect(formatMoney(12.3, "pt-BR", "1BR")).toBe("12.30 1BR");
  });

  // Parsed as UTC noon: a date-only string parsed as UTC midnight and formatted in a western zone
  // lands on the previous day, which is how a validity date silently loses 24 hours.
  test("formats a date without slipping a day", () => {
    expect(formatDate("2026-09-05", "pt-BR")).toBe("05/09/2026");
    expect(formatDate("2026-09-05", "en-US")).toBe("09/05/2026");
    expect(formatDate("not-a-date", "pt-BR")).toBe("not-a-date");
  });

  test("pads the document number and prefixes it", () => {
    expect(formatDocumentNumber(42, "ORC-")).toBe("ORC-0042");
    expect(formatDocumentNumber(12345, null)).toBe("12345");
    expect(formatDocumentNumber(null, "ORC-")).toBe("");
  });

  test("formats a plain number in the locale", () => {
    expect(formatNumber(1500.5, "pt-BR")).toBe("1.500,5");
    expect(formatNumber(1500.5, "en-US")).toBe("1,500.5");
  });
});

// What the customer can add up. A unit price of 0.105 PRINTS as R$ 0,11, so a line of three of them
// has to print R$ 0,33 — multiplying the hidden 0.105 gives 0.315, rounds to R$ 0,32, and leaves the
// customer holding three numbers that do not agree. This is the exact failure the module's header
// names, one level below where it was being checked.
describe("what is printed is what is computed", () => {
  // The case the naive `Math.round(v * 100)` gets wrong, and the reason the rounding is done through
  // the decimal representation: the multiplication is binary, so 1.005 * 100 is 100.49999999999999
  // and rounds DOWN — while the renderer prints R$ 1,01. The document would contradict itself.
  test("rounds the way the renderer rounds, ties included", () => {
    const money = (v: number) =>
      new Intl.NumberFormat("pt-BR", {
        style: "currency",
        currency: "BRL",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(v);
    for (const unitPrice of [1.005, 2.675, 1.115, 0.615, 1.1 * 1.15]) {
      const total = lineTotal({ description: "x", quantity: 1, unitPrice });
      expect(money(total)).toBe(money(unitPrice));
    }
  });

  // JavaScript writes small magnitudes in EXPONENT form, so a value like 1e-7 stringifies as "1e-7"
  // and appending "e2" gives "1e-7e2" — not a number. The arithmetic then produced NaN and the
  // customer's PDF printed NaN where its total belongs, for an amount that is simply zero cents.
  test("handles amounts JavaScript writes in exponent notation", () => {
    for (const unitPrice of [1e-7, 9e-7, 1e-21]) {
      const total = lineTotal({ description: "x", quantity: 1, unitPrice });
      expect(Number.isNaN(total)).toBe(false);
      expect(total).toBe(0);
    }
    const totals = computeTotals(
      [{ description: "x", quantity: 1, unitPrice: 10 }],
      { discount: 1e-7, tax: 9e-7 },
    );
    for (const v of [
      totals.subtotal,
      totals.discount,
      totals.tax,
      totals.total,
    ]) {
      expect(Number.isNaN(v)).toBe(false);
    }
    expect(totals.total).toBe(10);
    // …and the large end, which stringifies as "1e+21".
    expect(
      Number.isNaN(
        lineTotal({ description: "x", quantity: 1, unitPrice: 1e21 }),
      ),
    ).toBe(false);
  });

  // Every intermediate stays a whole number of cents. `1.01 * 100` is 101.00000000000001, and a
  // fraction here would travel through the sums and back out as a total that is not a cent amount.
  test("keeps the arithmetic on whole cents", () => {
    const items = [
      { description: "a", quantity: 3, unitPrice: 1.005 },
      { description: "b", quantity: 7, unitPrice: 2.675 },
    ];
    // Compared with a tolerance, not with Number.isInteger: 3.03 is a whole number of cents and
    // `3.03 * 100` is still 302.99999999999994, which says something about the multiplication in the
    // assertion rather than about the value being asserted.
    for (const item of items) {
      const v = lineTotal(item);
      expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
    }
    // And exactly, not nearly. `0.07 * 100` is 7.000000000000001, so a cents() that MULTIPLIES
    // instead of shifting through the decimal hands back 0.07000000000000002 — a number that is not
    // an amount of money, and that every later sum carries. (0.07, 0.14, 0.28, 0.29, 0.55 and 0.56
    // are the first six two-decimal values with that property; most do multiply exactly, which is
    // why an arbitrary example proves nothing here.)
    // …and exactly across a whole document, which is where it becomes visible. `0.07 * 100` is
    // 7.000000000000001, and one line absorbs that on the way back through /100 — a hundred lines do
    // not. The subtotal is also returned to REST and MCP callers, so it has to BE the number, not
    // print like it.
    const many = Array.from({ length: 100 }, () => ({
      description: "x",
      quantity: 1,
      unitPrice: 0.07,
    }));
    expect(computeTotals(many).subtotal).toBe(7);

    const totals = computeTotals(items, { discount: 1.005, tax: 2.675 });
    for (const v of [
      totals.subtotal,
      totals.discount,
      totals.tax,
      totals.total,
    ]) {
      expect(Math.abs(v * 100 - Math.round(v * 100))).toBeLessThan(1e-6);
    }
  });

  test("multiplies the factors at the precision the document shows them", () => {
    const item = { description: "x", quantity: 3, unitPrice: 0.105 };
    expect(lineTotal(item)).toBe(0.33);
    expect(computeTotals([item]).subtotal).toBe(0.33);
  });

  test("quantizes the quantity at the precision the document shows it", () => {
    // formatNumber prints up to 4 decimals, so 1.000004 reads as "1" and must multiply as 1.
    expect(
      lineTotal({ description: "x", quantity: 1.000004, unitPrice: 100 }),
    ).toBe(100);
    // …and a fifth decimal that rounds UP is shown, so it must be multiplied: 1.00005 prints as
    // "1,0001". The rule is the displayed value, not a truncation of it. At a unit price of 1000 the
    // two readings part company — 1000,05 against the 1000,10 the printed factors give — which is
    // the price at which this rule starts deciding anything.
    expect(
      lineTotal({ description: "x", quantity: 1.00005, unitPrice: 1000 }),
    ).toBe(1000.1);
  });

  // Not "quantized the same way": a lone money amount is already quantized by the cent conversion
  // itself. The row is here because the PRINTED discount and the SUBTRACTED discount must be the
  // same number, which is the property, not the mechanism.
  test("subtracts the discount the document prints", () => {
    const totals = computeTotals(
      [{ description: "x", quantity: 1, unitPrice: 10 }],
      { discount: 0.105, tax: 0.105 },
    );
    expect(totals.discount).toBe(0.11);
    expect(totals.tax).toBe(0.11);
    expect(totals.total).toBe(10);
  });

  // The property the whole module exists for, stated directly: the printed lines add up to the
  // printed subtotal, for values chosen to have hidden digits.
  test("the printed lines sum to the printed subtotal", () => {
    const items = [
      { description: "a", quantity: 3, unitPrice: 0.105 },
      { description: "b", quantity: 7, unitPrice: 1.005 },
      { description: "c", quantity: 1.5, unitPrice: 19.999 },
    ];
    const printed = items.reduce((acc, i) => acc + lineTotal(i), 0);
    expect(computeTotals(items).subtotal).toBeCloseTo(printed, 10);
  });
});

// What the document PRINTS has to be what it COMPUTED with, and the formatter is the last place
// that can break that. Neither `Intl` nor `toFixed` rounds the way this project does — both work on
// the binary double, so 1.005 comes back "1,00" from them and 1,01 from `displayedMoney`. A line
// printing one cent away from the total it was added into is the error a customer photographs.
describe("formatMoney prints the quantized amount", () => {
  // Values where binary and decimal rounding genuinely disagree.
  const AMBIGUOUS = [1.005, 2.675, 0.145, 1299.905, 8.615];

  test("agrees with displayedMoney, symbol or fallback", () => {
    for (const value of AMBIGUOUS) {
      const cents = Math.round(displayedMoney(value) * 100);
      // A currency whose symbol the fonts can draw, and one whose symbol they cannot (so the code
      // falls back). Both have to print the same number.
      const withSymbol = formatMoney(value, "pt-BR", "BRL");
      const fallback = formatMoney(value, "pt-BR", "INR");
      const expected = (cents / 100).toFixed(2);
      expect(fallback).toBe(`${expected} INR`);
      expect(withSymbol.replace(/[^0-9,]/g, "").replace(",", ".")).toBe(
        expected,
      );
    }
  });

  // The one that matters end to end: a line total and the amount printed for it are the same
  // number, whichever currency the template is set to.
  test("a line total prints as the value it computed", () => {
    const total = lineTotal({
      description: "x",
      quantity: 1,
      unitPrice: 1.005,
    });
    expect(total).toBe(1.01);
    expect(formatMoney(total, "pt-BR", "INR")).toBe("1.01 INR");
    expect(formatMoney(1.005, "pt-BR", "INR")).toBe("1.01 INR");
  });
});
