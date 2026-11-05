import { clipText } from "@/lib/text";

// A line that names WHAT is behind a signal's value, appended to its firing alert: the statement
// and the work that timed out, the statement that drifted. The number alone says that something is
// slow; this says which, so the operator does not have to open the screen to know what broke
// (docs/logs.md, "Database"). Set by whoever samples the signal, cleared with null.

const KEY = Symbol.for("fazerai.instanceHealth.details");

function details(): Map<string, string> {
  const g = globalThis as unknown as Record<symbol, Map<string, string>>;
  g[KEY] ??= new Map();
  return g[KEY];
}

export function setSignalDetail(signal: string, detail: string | null): void {
  if (detail) details().set(signal, detail);
  else details().delete(signal);
}

export function signalDetail(signal: string): string | null {
  return details().get(signal) ?? null;
}

// A statement in one line an alert can carry: whitespace collapsed, cut at a length a chat message
// keeps readable.
export function statementLine(sql: string, max = 200): string {
  const one = sql.replace(/\s+/g, " ").trim();
  return one.length > max ? `${clipText(one, max - 1)}…` : one;
}
