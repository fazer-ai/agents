// Per-agent observability knobs, read from `agent.settings.observability` (Json, additive), like
// readLimitsConfig / readDebounceConfig.
//
// `logToolValues` OFF (the default) stores each tool argument and result as its SHAPE (shape.ts),
// which keeps `ExecutionLog.detail` free of message text and PII; ON stores the values. Per agent
// so the blast radius is the agent being debugged, and not gated by edition, since it is the only
// way to see what the model passed to a tool. `fullDetailUntil` (how much of an allowed string
// survives) is a separate knob, deliberately not merged with the PII one.

// How far ahead the debug mode may be armed: without a bound the automatic expiry is advisory (arm
// it until 2099). A day fits one debugging sitting and caps a forgotten mode at a day of full-size
// rows. It lives here, not beside its schema, because the console renders it and settings-schema.ts
// reaches server-only modules (`tests/client/bundle-boundary.test.ts` refuses that import).
export const FULL_DETAIL_MAX_HOURS = 24;

// What the console arms, deliberately SHORTER than the ceiling: the deadline is chosen in the
// browser and judged on the server's clock, and a value past the bound is silently refused. Half
// the ceiling absorbs header resolution, transfer time and drift (`src/client/lib/serverClock.ts`)
// at no real cost.
export const FULL_DETAIL_ARM_HOURS = FULL_DETAIL_MAX_HOURS / 2;

export interface ObservabilityConfig {
  logToolValues: boolean;
  // The debug mode: while on, this agent's flow lines keep their `detail` strings whole instead of
  // cutting them at `MAX_STRING`. Derived, never stored; see `fullDetailUntil` below.
  fullDetail: boolean;
  // When the mode ends, as stored. Kept on the config (rather than collapsed into the boolean) so a
  // reader can SAY when it expires: the console's warning and the MCP surface both need the instant,
  // not just the flag, and an operator who is told "on until 14:30" does not have to guess.
  // Null whenever the mode is off, whatever the reason (absent, malformed, or already past).
  fullDetailUntil: Date | null;
}

// The debug mode is stored as the INSTANT IT ENDS, not a boolean with an expiry: no state is on
// without an end, and a process that was down when the window closed comes back with it off. `now`
// is injected so a caller reuses the turn's instant for every read, and so the boundary is
// testable.
export function readObservabilityConfig(
  settings: unknown,
  now: Date = new Date(),
): ObservabilityConfig {
  const def: ObservabilityConfig = {
    logToolValues: false,
    fullDetail: false,
    fullDetailUntil: null,
  };
  if (!settings || typeof settings !== "object") return def;
  const o = (settings as Record<string, unknown>).observability;
  if (!o || typeof o !== "object") return def;
  const until = parseIsoInstant((o as Record<string, unknown>).fullDetailUntil);
  const on = isFullDetailWindowOpen(until, now);
  return {
    logToolValues:
      (o as Record<string, unknown>).logToolValues === true ||
      (o as Record<string, unknown>).logToolValues === "true",
    fullDetail: on,
    fullDetailUntil: on ? until : null,
  };
}

// Whether a stored deadline is a window open right now; shared with `debugModesFrom` so the rule
// does not fork. Strictly greater on the near side (an instant that has arrived is spent). On the
// far side a deadline beyond `FULL_DETAIL_MAX_HOURS` from now reads as OFF: `settings` arrives
// unvalidated over REST, import and the database, and clamping instead would renew the window on
// every read.
export function isFullDetailWindowOpen(until: Date | null, now: Date): boolean {
  return (
    until !== null &&
    until.getTime() > now.getTime() &&
    until.getTime() <= now.getTime() + FULL_DETAIL_MAX_HOURS * 3_600_000
  );
}

// What the block looks like GOING BACK INTO THE BAG, which is not what it looks like coming out.
//
// `fullDetail` is derived from `fullDetailUntil` on every read, so persisting it would store a value
// nothing consults and let the two disagree — a bag saying `fullDetail: true` an hour after the
// window closed reads as armed to a human and as off to the code. Every writer of this block goes
// through here for that reason: the behavior-settings merge, which re-reads each block through its
// typed reader and writes the result back, and the console's form pair.
export interface StorableObservability {
  logToolValues: boolean;
  fullDetailUntil: string | null;
}

export function storableObservability(
  cfg: ObservabilityConfig,
): StorableObservability {
  return {
    logToolValues: cfg.logToolValues,
    fullDetailUntil: cfg.fullDetailUntil?.toISOString() ?? null,
  };
}

// An ISO 8601 instant that NAMES ITS OFFSET: `Date.parse` resolves an offset-less value against the
// server's timezone, and it coerces (a one-element array parses as its element), so the shape is
// checked before the parse.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// What an IMPORTED bag's observability block has to look like: the debug mode disarmed.
//
// An import arrives disabled and in test mode precisely so the operator reviews it before it serves
// anyone, and a mode that widens what is recorded is not something a bundle gets to arm on their
// behalf — they did not choose the window and would not know it was running. Cleared rather than
// refused, because an import is a bulk restore and failing the whole thing over a switch would be
// the wrong trade; the same call is what the text caps make on this path (`text-caps.ts`).
export function disarmFullDetail(settings: unknown): unknown {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return settings;
  }
  const bag = settings as Record<string, unknown>;
  const o = bag.observability;
  if (!o || typeof o !== "object") return settings;
  if (!("fullDetailUntil" in (o as Record<string, unknown>))) return settings;
  return { ...bag, observability: { ...o, fullDetailUntil: null } };
}

// A stored instant, or null for anything this reader cannot turn into one. A bag written by an older
// build or edited by hand can hold anything here, and the fail-safe direction is unambiguous: a value
// that cannot be read as a future instant leaves the mode OFF, which is the default the column's
// documented promise is written against.
export function parseIsoInstant(value: unknown): Date | null {
  // NOTE: the `typeof` half no longer changes any ANSWER — the round-trip check below refuses the
  // one JSON value that gets past a regex on a non-string (`["<iso>"]`, which `test` coerces to its
  // element) because `Array.prototype.slice` returns an array and an array never equals a string.
  // It stays because it is what makes the `.slice` on `value` type-safe: removing it compiles only
  // with a cast, and a cast is a claim about a value this function exists to be unsure of.
  if (typeof value !== "string" || !ISO_INSTANT.test(value)) return null;
  const t = Date.parse(value);
  if (Number.isNaN(t)) return null;
  // `Date.parse` NORMALISES a date that does not exist rather than refusing it: `2026-02-30` comes
  // back as March 2, and the shape check above cannot see it — February has thirty days as far as a
  // regex is concerned. So the calendar is checked on the STRING's own components, never against
  // the parsed instant's UTC date: `2026-08-25T23:00:00-03:00` is a perfectly valid instant whose
  // UTC day is the 26th, and comparing the two would refuse every offset that crosses midnight.
  const [y, m, d] = value.slice(0, 10).split("-").map(Number);
  if (y === undefined || m === undefined || d === undefined) return null;
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m < 1 || m > 12 || d < 1 || d > days) return null;
  return new Date(t);
}
