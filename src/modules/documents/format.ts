import type { DocumentStyle } from "./blocks";
import { unprintableCharacters } from "./printable";
import { displayedMoney } from "./totals";

// Locale-aware formatting for the values a document prints. Bun ships full ICU, so Intl is the right
// tool here — the old quote renderer avoided it and printed "1299.90 BRL", which is not how a price
// is written anywhere.
//
// NOTE: pt-BR currency output contains U+00A0 (a non-breaking space) between the symbol and the
// number, not a plain space. That is correct typography and is kept; a test that compares against a
// normal space fails, and a test that strips whitespace to make it pass stops testing anything.

export function formatMoney(
  value: number,
  locale: DocumentStyle["locale"],
  currency: string,
): string {
  // Quantized HERE, once, with the same decimal rounding the totals use — before any formatter sees
  // it. Both paths below round to two places on their own, and neither rounds the way this project
  // does: `Intl` and `toFixed` both work on the binary double, so 1.005 comes out "1,00" from them
  // and 1,01 from `displayedMoney`. A document whose line prints one cent away from the total it was
  // added into is the error a customer photographs, and it does not have to be reachable through
  // one code path to be worth removing from all of them.
  const amount = displayedMoney(value);
  try {
    const formatted = new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
    // The SYMBOL is chosen by Intl, not by anyone this code can refuse: INR, KRW, THB, VND and ILS
    // are perfectly valid codes whose symbols (₹ ₩ ฿ ₫ ₪) the standard 14 PDF fonts cannot encode,
    // and the renderer would draw a different character beside every amount on the page. Measured:
    // BRL, USD, EUR, GBP and JPY all come back printable; those five do not.
    //
    // So the check belongs HERE, at the only place that knows what the symbol turned out to be. The
    // fallback is the same one an unknown code already gets — the amount followed by its code — and
    // "1299,90 INR" is a price a reader can act on, which "1299,90 -" is not.
    return unprintableCharacters(formatted).length === 0
      ? formatted
      : `${amount.toFixed(2)} ${currency}`;
  } catch {
    // An unknown currency code throws rather than degrading. The document still has to render, and
    // "1299.90 XYZ" is legible; refusing to produce the PDF is not.
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatNumber(
  value: number,
  locale: DocumentStyle["locale"],
): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(
    value,
  );
}

// Takes the ISO date the value schema enforces and prints it in the document's locale. Parsed as
// UTC noon rather than midnight: a date-only string parsed as UTC midnight and formatted in a
// western timezone lands on the previous day, which is how a validity date silently loses 24 hours.
export function formatDate(
  iso: string,
  locale: DocumentStyle["locale"],
): string {
  const parsed = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "UTC",
  }).format(parsed);
}

// The document's own number, as printed: the template's prefix plus the counter, zero-padded so a
// list of them sorts and lines up.
export function formatDocumentNumber(
  n: number | null | undefined,
  prefix: string | null | undefined,
): string {
  if (n === null || n === undefined) return "";
  return `${prefix ?? ""}${String(n).padStart(4, "0")}`;
}
