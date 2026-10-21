// WHAT A CHATWOOT ATTRIBUTE DEFINITION ACCEPTS, applied by `set_custom_attribute` before it writes.
// The definition is the operator's statement of what the field holds (a list of options, a number, a
// date, a pattern), and the dashboard's own editor enforces it on a person's edit; the API does not,
// so a write from the agent went in as whatever string the model passed. The pattern half runs off
// the event loop (attribute-pattern.ts).
import { type PatternVerdict, testAttributePattern } from "./attribute-pattern";

// The slice of a definition the rule reads. `CustomAttributeDef` (client.ts) carries it whole.
export interface AttributeRuleDef {
  key: string;
  displayType: string;
  values: string[];
  regexPattern: string | null;
  regexCue: string | null;
}

// The rule a refused value broke, as an enum: it goes on the flowlog line and in the test names,
// never the value itself (customer data, docs/logs.md).
export type AttributeRule =
  | "empty"
  | "list"
  | "number"
  | "date"
  | "checkbox"
  | "link"
  | "pattern"
  | "pattern_timeout";

export type AttributeCheck =
  | { ok: true; value: string }
  | { ok: false; rule: AttributeRule };

// Chatwoot's numeric display types. Currency and percent are numbers with a different rendering.
const NUMERIC = new Set(["number", "currency", "percent"]);
const NUMBER_RE = /^[+-]?\d+(\.\d+)?$/;
// A calendar date, or the ISO timestamp the dashboard itself stores for a date attribute.
const DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-](\d{2}):?(\d{2}))?)?$/;

// Every part in range: the calendar day exists, and a timestamp's time and offset are real ones.
function validDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d
  )
    return false;
  const within = (part: string | undefined, max: number) =>
    part === undefined || Number(part) <= max;
  return (
    within(m[4], 23) &&
    within(m[5], 59) &&
    within(m[6], 59) &&
    within(m[8], 14) &&
    within(m[9], 59)
  );
}

// The scheme and both slashes spelled out: `https:exemplo.com` parses with a host, but the string is
// what gets written, and a browser resolves it against the page it is shown on.
function validLink(v: string): boolean {
  if (!/^https?:\/\//i.test(v)) return false;
  try {
    const u = new URL(v);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.host;
  } catch {
    return false;
  }
}

// The value to write, trimmed, or the rule it broke. A blank value is refused here whatever the
// definition says: clearing a field is its own call (`clear`), so an empty string the model passed
// by accident never reads as "the customer answered nothing". With no definition only that rule
// applies: Chatwoot accepts a key it has no definition for, and so does the tool. `testPattern` is
// injectable for tests; a pattern check that runs out of time refuses (`pattern_timeout`).
export async function checkAttributeValue(
  def: AttributeRuleDef | undefined,
  raw: string,
  testPattern: (
    pattern: string,
    value: string,
  ) => Promise<PatternVerdict> = testAttributePattern,
): Promise<AttributeCheck> {
  let value = raw.trim();
  if (value === "") return { ok: false, rule: "empty" };
  if (!def) return { ok: true, value };
  const type = def.displayType;
  if (type === "list") {
    // NOTE: exact, as the dashboard's dropdown can only produce one of the options.
    if (def.values.length > 0 && !def.values.includes(value))
      return { ok: false, rule: "list" };
  } else if (NUMERIC.has(type)) {
    if (!NUMBER_RE.test(value)) return { ok: false, rule: "number" };
  } else if (type === "date") {
    if (!validDate(value)) return { ok: false, rule: "date" };
  } else if (type === "checkbox") {
    // NOTE: the dashboard renders the string "false" as unchecked and any other value as checked, so
    // the two spellings it understands are the only two written, and the pattern sees the written one.
    value = value.toLowerCase();
    if (value !== "true" && value !== "false")
      return { ok: false, rule: "checkbox" };
  } else if (type === "link") {
    // NOTE: the dashboard checks a link with its URL validator and skips the pattern, and so does this.
    return validLink(value) ? { ok: true, value } : { ok: false, rule: "link" };
  }
  if (def.regexPattern) {
    const verdict = await testPattern(def.regexPattern, value);
    if (verdict === "timeout") return { ok: false, rule: "pattern_timeout" };
    if (verdict === "no_match") return { ok: false, rule: "pattern" };
  }
  return { ok: true, value };
}

// Why `set_custom_attribute` refused a write: outside the agent's list, a value its definition does
// not accept, a clear that also carried a value, or definitions that could not be read to check it.
// `key` is present only when it is operator vocabulary (in the list, or defined in Chatwoot): without
// a list the model names any key it likes.
export interface AttributeRefusal {
  scope: "conversation" | "contact" | "task";
  rule:
    | AttributeRule
    | "not_allowed"
    | "clear_with_value"
    | "definitions_unavailable";
  key?: string;
}
export type AttributeRefusalReporter = (refusal: AttributeRefusal) => void;
