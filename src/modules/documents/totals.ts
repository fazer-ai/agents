import type { LineItemValue } from "./validate";

// Document arithmetic, in integer cents. Floats accumulate: 3 × 0,10 summed as floats is
// 0.30000000000000004, and a document that prints a total one cent off the sum of its own lines is
// the kind of error a customer photographs.
//
// The renderer computes this; the model never does. A model asked to add up its own line items will
// eventually get it wrong in front of a customer, and the number it got wrong is a price.

export interface DocumentTotals {
  subtotal: number;
  // The discount AS APPLIED, which is not always the discount that was supplied — see below.
  discount: number;
  tax: number;
  total: number;
}

// Rounds the way the RENDERER rounds, which is the only definition that matters here: whatever the
// document prints has to be what it computed with.
//
// `Math.round(value * 100)` is not that. The multiplication happens in binary floating point, so
// 1.005 becomes 100.49999999999999 and rounds DOWN to R$ 1,00 — while Intl prints R$ 1,01, because
// it rounds the decimal the double is written as, not the product of a lossy multiplication. That is
// the same contradiction the quantization was added to remove, one layer further down.
//
// Shifting through the string representation is what matches: `${1.005}e2` parses as exactly 100.5.
// Measured against Intl over 200,000 random values across nine magnitudes, positive and negative:
// zero mismatches. The sign is taken out first because Math.round breaks ties toward +∞ while the
// formatter breaks them away from zero.
// Moves the decimal point by adjusting the EXPONENT rather than by pasting one on. JavaScript
// stringifies small and large magnitudes in exponent form — `(1e-7).toString()` is "1e-7" — so
// appending "e2" produced "1e-7e2", which is not a number at all: `cents()` returned NaN and the
// customer's PDF printed NaN where its total belongs. Splitting the mantissa from the exponent
// first handles both forms with one rule.
function shiftDecimal(value: number, by: number): number {
  const [mantissa, exponent] = value.toString().split("e");
  return Number(`${mantissa}e${(exponent ? Number(exponent) : 0) + by}`);
}

export function roundDecimal(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value;
  const sign = value < 0 ? -1 : 1;
  const shifted = shiftDecimal(Math.abs(value), decimals);
  if (!Number.isFinite(shifted)) return value;
  return sign * shiftDecimal(Math.round(shifted), -decimals);
}

// Shifted through the string again rather than multiplied: `1.01 * 100` is 101.00000000000001, and
// a non-integer here would travel through every sum and back out as a total that is not a whole
// number of cents.
function cents(value: number): number {
  return shiftDecimal(roundDecimal(value, 2), 2);
}

// The factors are QUANTIZED to the precision the document prints them at, before they are
// multiplied. A unit price of 0.105 renders as "R$ 0,11" and multiplied raw gives 3 × 0.105 = 0.315
// → 32 cents, so the customer reads "3 × R$ 0,11 = R$ 0,32" and cannot make those three numbers
// agree. Whatever the document shows has to be what it computed with; hidden digits are precisely
// the kind of discrepancy someone photographs.
//
// The precisions are the renderer's own: money at 2 decimals (formatMoney) and quantity at up to 4
// (formatNumber). They live here as the numbers those two formatters use, and a change on either
// side has to move both.
const QUANTITY_DECIMALS = 4;
const MONEY_DECIMALS = 2;

const quantize = roundDecimal;

export function displayedQuantity(value: number): number {
  return quantize(value, QUANTITY_DECIMALS);
}

export function displayedMoney(value: number): number {
  return quantize(value, MONEY_DECIMALS);
}

// `tax` is an AMOUNT, not a rate, because the field that feeds it is declared `currency`. That
// settles the question a rate would open — whether it applies to the gross or to the discounted
// subtotal — by never asking it.
export function computeTotals(
  items: LineItemValue[],
  opts: { discount?: number; tax?: number } = {},
): DocumentTotals {
  // Through lineTotal, so the subtotal is the sum of the lines the customer READS rather than of a
  // parallel calculation that happens to be near them.
  const subtotalCents = items.reduce(
    (acc, item) => acc + cents(lineTotal(item)),
    0,
  );
  // NOT quantized on the way in, and that is not an oversight: `cents()` IS the money quantization,
  // so a lone amount needs nothing more — measured, by removing a displayedMoney() here and finding
  // no test could tell. The factors below are different, because there a PRODUCT is taken before the
  // rounding, and the digits the document never showed survive into it.
  const requestedDiscount = Math.max(0, cents(opts.discount ?? 0));
  // NOTE: clamped to the subtotal, and the CLAMPED value is what comes back, so the rows the
  // renderer prints add up to the total it prints. A discount larger than the subtotal is somebody's
  // mistake either way; a document whose own three numbers contradict each other is the worse way
  // for the customer to find out.
  const discountCents = Math.min(requestedDiscount, subtotalCents);
  const taxCents = Math.max(0, cents(opts.tax ?? 0));
  const totalCents = subtotalCents - discountCents + taxCents;
  return {
    subtotal: subtotalCents / 100,
    discount: discountCents / 100,
    tax: taxCents / 100,
    total: totalCents / 100,
  };
}

export function lineTotal(item: LineItemValue): number {
  return (
    cents(displayedQuantity(item.quantity) * displayedMoney(item.unitPrice)) /
    100
  );
}
