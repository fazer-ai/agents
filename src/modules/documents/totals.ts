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

// Moves the decimal point through the string representation, adjusting the EXPONENT so that
// exponent-form values like "1e-7" work too. This is how rounding matches the RENDERER (Intl rounds
// the decimal the double is written as): `Math.round(1.005 * 100)` gives 100, while Intl prints 1,01.
function shiftDecimal(value: number, by: number): number {
  const [mantissa, exponent] = value.toString().split("e");
  return Number(`${mantissa}e${(exponent ? Number(exponent) : 0) + by}`);
}

// Rounds the way the RENDERER rounds: whatever the document prints has to be what it computed with.
// The sign is taken out first because Math.round breaks ties toward +Infinity while the formatter
// breaks them away from zero.
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

// The factors are QUANTIZED to the precision the document prints them at before multiplying, so
// "3 x R$ 0,11" never totals R$ 0,32. The precisions are formatMoney's and formatNumber's: a change
// on either side has to move both.
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
  // NOTE: NOT quantized on the way in: `cents()` IS the money quantization, so a lone amount needs
  // nothing more. The factors below differ because there a PRODUCT is taken before the rounding.
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
