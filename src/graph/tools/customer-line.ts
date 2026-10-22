// A line the model writes for the CUSTOMER, as the tool that delivers it reads it: trimmed, and empty
// when what is left is a placeholder. A model that weighed a message and decided against it fills the
// required argument with "EMPTY" or "N/A" as often as with nothing, and sent as written the customer
// reads that word. Exact matches on a closed list, never a guess about a sentence: no real reply to a
// person is one of these words on its own.
const PLACEHOLDERS = new Set([
  "empty",
  "n/a",
  "na",
  "none",
  "null",
  "nil",
  "undefined",
  "not applicable",
  "-",
]);

export function customerLine(raw: string | null | undefined): string {
  const line = raw?.trim() ?? "";
  return PLACEHOLDERS.has(line.toLowerCase()) ? "" : line;
}
