// Per-agent observability knobs, read from `agent.settings.observability` (Json, additive).
// Mirrors readLimitsConfig / readDebounceConfig.
//
// `logToolValues` decides what a tool call leaves in `ExecutionLog.detail`: OFF (the default) stores
// each argument and result as its SHAPE (`{ cpf: "string(11)" }`, see shape.ts), which is what keeps
// that column's documented promise of carrying no message text or PII; ON stores the values the model
// actually sent.
//
// It is per AGENT rather than per instance because that matches how it gets used: turn it on for the
// one agent whose tool calls are misbehaving, reproduce, turn it off. The blast radius is that
// agent's log lines instead of every conversation in the deployment.
//
// The default is what the promise requires, and the switch is not gated by edition: taking the values
// away by default and then charging to see them again would leave the Free edition with no way at all
// to find out what the model passed to a tool, which the conversation does not show either.
//
// `fullDetailUntil` is a SECOND, independent knob, and the two are deliberately not merged. They
// answer different questions: `logToolValues` decides whether the customer's PII is stored at all,
// and `fullDetailUntil` decides how much of a string that was already allowed to be stored survives
// the write. Merging them would mean an operator asking "was my attribute block injected?" starts
// storing CPFs as a side effect, which is the opposite of what they asked for (issue #58).

// How far ahead the debug mode may be armed. It is a bound on what a caller may SEND, and it is the
// whole reason the expiry is automatic rather than advisory: without it an operator arms the mode
// for the year 2099 and the "expiry" never arrives. A day is the size of the thing being debugged —
// an operator reproduces, reads and turns it off inside one sitting — and it bounds the damage of
// forgetting to one day of full-size rows inside the 30-day retention window
// (`src/modules/flowlog/retention.ts`).
//
// It lives HERE rather than beside the schema that enforces it because the console renders the
// number too, and `src/modules/agents/settings-schema.ts` reaches server-only modules: importing it
// from a component pulls `tts/providers.ts` into the browser bundle, which
// `tests/client/bundle-boundary.test.ts` refuses.
export const FULL_DETAIL_MAX_HOURS = 24;

// What the console actually arms, which is deliberately SHORTER than the ceiling. The deadline is
// chosen in the browser and judged against the server's clock, so arming for exactly the maximum
// makes any forward disagreement at all push the value past the bound — and the reader then refuses
// it silently, as a switch that turns on in the browser and never arms anything. The console takes
// the server's clock for this (`src/client/lib/serverClock.ts`, read off the `Date` header of
// responses the page already makes), so what the gap absorbs is what that leaves: one-second header
// resolution, the transfer time, and whatever the machine drifts while the editor stays open. Half
// the ceiling is far more than any of those and still leaves a debugging window longer than any
// sitting, so the margin costs nothing worth reclaiming.
export const FULL_DETAIL_ARM_HOURS = FULL_DETAIL_MAX_HOURS / 2;

export interface ObservabilityConfig {
  logToolValues: boolean;
  // The debug mode of issue #58: while on, this agent's flow lines keep their `detail` strings whole
  // instead of cutting them at `MAX_STRING`. Derived, never stored — see `fullDetailUntil` below.
  fullDetail: boolean;
  // When the mode ends, as stored. Kept on the config (rather than collapsed into the boolean) so a
  // reader can SAY when it expires: the console's warning and the MCP surface both need the instant,
  // not just the flag, and an operator who is told "on until 14:30" does not have to guess.
  // Null whenever the mode is off, whatever the reason (absent, malformed, or already past).
  fullDetailUntil: Date | null;
}

// The debug mode is stored as the INSTANT IT ENDS, not as a boolean with an expiry beside it. That
// is what makes the automatic expiry of #58 real rather than advisory: there is no representable
// state where the mode is on and nobody said when it stops, no writer can turn it on without
// declaring the end, and a process that was down when the window closed comes back with the mode
// already off, because nothing had to run for it to expire. The cost is that the value has to be
// re-armed to keep debugging, which is the behaviour the issue asked for ("warning does not stop
// anyone from forgetting").
//
// `now` is injected rather than read here so a caller that already has the turn's instant uses the
// same one for every read of it, and so the boundary is testable at all.
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

// WHETHER A STORED DEADLINE IS A WINDOW THAT IS OPEN RIGHT NOW.
//
// One function because there are two callers and the rule must not fork: this reader, and
// `debugModesFrom`, which re-judges an already-read config against a later instant so the console's
// warning stops claiming the mode is on the moment the window closes under an open editor.
//
// TWO comparisons, and the second is the one that makes the bound real.
//
// Strictly greater on the near side: an instant that has arrived is spent. The comparison is on
// the stored end, so a clock that jumps forward closes the window early and never extends it.
//
// And the far side, because a schema can only bound what a CALLER SENDS. `settings` is an
// arbitrary bag over REST, over the import path, and in the database itself, so a value the
// schema would refuse still lands there — and `2099-01-01` would then arm the mode forever,
// which is precisely the state the automatic expiry exists to make unreachable. A deadline
// further out than the longest window that may be armed is not a deadline anyone could have set,
// so it reads as OFF, like every other value this reader cannot make sense of. Note it is
// deliberately not CLAMPED to `now + FULL_DETAIL_MAX_HOURS`: clamping would renew the window on
// every read, turning "too far ahead" into "permanently on" — the opposite of the refusal.
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

// An ISO 8601 instant that NAMES ITS OFFSET. Both halves are load-bearing:
//
// - the offset, because the same text otherwise means different moments in different deployments.
//   `Date.parse` accepts `08/26/2026 10:00` and resolves it against the SERVER's local timezone, so
//   one value armed from one console would land hours apart on two installations. The field is
//   documented as an ISO instant; this is what makes the documentation true rather than hopeful.
// - the shape check before the parse, because `Date.parse` COERCES. A one-element array coerces to
//   its element, so `["2026-08-26T10:00:00Z"]` parses to a perfectly ordinary instant and would arm
//   the mode from a value nothing in the system ever writes.
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
