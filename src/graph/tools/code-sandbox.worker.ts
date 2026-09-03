// The thread that runs ONE operator-authored code tool body and exits. Spawned per call by
// code-sandbox.ts, which explains why a thread and why a fresh one; this file is the interpreter
// side of that contract and knows nothing about the tool.
//
// The interpreter is QuickJS compiled to WebAssembly (quickjs-emscripten): a real JavaScript engine
// with no ambient authority. Its global object has exactly what ECMAScript defines plus the
// `console` installed below — no fetch, no process, no require, no timers, no way to reach this
// thread's globals — and the runtime enforces a CPU deadline (the interrupt handler), a heap
// ceiling and a stack ceiling. Measured before the design was settled: a `while(true)` returns
// "interrupted" at the deadline, an unbounded `push` returns "out of memory", `/(a+)+$/` on 28
// characters is interrupted rather than run to completion, and `Object.getOwnPropertyNames(
// globalThis)` lists the standard constructors and nothing else.
import variant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  shouldInterruptAfterDeadline,
} from "quickjs-emscripten-core";
import { clipText, makeStorable } from "@/lib/text";
import { zoneFormatter, zoneOffsetSeconds } from "./zone-offset";

declare var self: Worker;

export interface SandboxRequest {
  code: string;
  timeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  // Cap on the rendered result and on the captured console output, each. Applied HERE so the
  // message back to the host is bounded by construction, whatever the snippet built.
  maxChars: number;
  // The agent's clock: `timezone` is what `Date` runs in (see DATE_SHIM_SOURCE) and what `TIMEZONE`
  // says, `nowLocal` is `NOW_LOCAL`. The interpreter's own clock is UTC and it has no Intl, so
  // without these "today" is tomorrow's date every evening in Brazil. The zone arrives RESOLVED:
  // the host already fell back to UTC for one Intl does not know.
  clock: { timezone: string; nowLocal: string };
  // Present for a code tool's call: the body runs as `function (input, context)` and answers with
  // `return`. Absent: the source runs as a bare script (the engine tests' harness).
  call?: SandboxCall;
}

// Both JSON text, produced by the host from the tool's validated arguments and the turn's context.
export interface SandboxCall {
  input: string;
  context: string;
}

export type SandboxReply =
  | { kind: "ready" }
  // The interpreter could not be set up for this request — the runtime, the context, the renderer
  // or a prelude failed before the snippet ran. Ours, not the snippet's: the host reports it as
  // the sandbox being unavailable, where an uncaught error here read as the snippet's abort and
  // told the model to simplify and retry, every turn (round 18).
  | { kind: "unavailable"; reason: string }
  | { kind: "value"; value: string; logs: string[]; ms: number }
  | {
      kind: "error";
      name: string;
      message: string;
      logs: string[];
      ms: number;
      // Set when the error is the interpreter's own limit rather than the snippet's, classified
      // HERE from the raw message, before the source line is appended to it.
      limit?: SandboxLimit;
    };

export type SandboxLimit = "time" | "memory" | "stack";

// The three InternalError messages QuickJS uses for its own limits. Anything else the snippet
// raised is the snippet's error, InternalError included.
function limitOf(e: ThrownValue): SandboxLimit | undefined {
  if (e.name !== "InternalError") return undefined;
  if (e.message === "interrupted") return "time";
  if (e.message === "out of memory") return "memory";
  if (e.message === "stack overflow") return "stack";
  return undefined;
}

const QuickJS = await newQuickJSWASMModuleFromVariant(variant);

// Renders a value the way the model should read it, INSIDE the interpreter: JSON where JSON can say
// it, and a spelling where it cannot. `vm.dump` would not do — it JSON-stringifies inside the VM
// with no replacer, so an object holding a BigInt comes out as "[object Object]", a nested NaN as
// null, a Map as {}. Measured, each of them. The walk carries its ancestors so a cycle is named
// rather than thrown, and stops at a depth no snippet result legitimately reaches.
const RENDER_SOURCE = `(function () {
  // The bindings this walker names, taken now, before any snippet runs: a snippet that writes
  // \`const Date = 1\` shadows the global for everything evaluated after it, this function included,
  // and its verdict came back as "[object Object]" (PR #485, round 7). A prototype the snippet
  // rewrites on purpose is its own result.
  var NativeDate = Date, NativeMap = Map, NativeSet = Set, NativeError = Error;
  var isArray = Array.isArray, arrayFrom = Array.from, objectKeys = Object.keys, objectCreate = Object.create;
  var stringify = JSON.stringify, Str = String, finite = isFinite, nan = isNaN;
  function text(root) {
  function conv(x, stack) {
    if (typeof x === "bigint") return x.toString();
    if (typeof x === "number" && !finite(x)) return Str(x);
    if (typeof x === "function") return "[function]";
    if (typeof x === "symbol") return x.toString();
    if (x === null || typeof x !== "object") return x;
    if (stack.indexOf(x) !== -1) return "[circular]";
    if (stack.length >= 64) return "[nested too deep]";
    if (x instanceof NativeDate) return nan(x.getTime()) ? "Invalid Date" : x.toISOString();
    if (x instanceof NativeError) return { name: x.name, message: x.message };
    if (x instanceof NativeMap || x instanceof NativeSet) x = arrayFrom(x);
    var next = stack.concat([x]);
    if (isArray(x)) return x.map(function (e) { var v = conv(e, next); return v === undefined ? null : v; });
    // No prototype: with one, assigning the key "__proto__" reaches the legacy setter instead of
    // the object, and a parsed document carrying that key (JSON.parse keeps it as a plain own key)
    // rendered without it (PR #485, round 3).
    var out = objectCreate(null);
    var keys = objectKeys(x);
    for (var i = 0; i < keys.length; i++) {
      var v = conv(x[keys[i]], next);
      if (v !== undefined) out[keys[i]] = v;
    }
    return out;
  }
  if (root === undefined) return "undefined";
  if (typeof root === "bigint") return root.toString();
  if (typeof root === "number" && !finite(root)) return Str(root);
  try {
    var s = stringify(conv(root, []));
    return s === undefined ? Str(root) : s;
  } catch (e) {
    return Str(root);
  }
  }
  // One past the budget when a budget is given, so the host still sees the overflow and writes its
  // marker; the console passes none and cuts on its own side of the same boundary.
  return function (root, max) {
    var s = text(root);
    return typeof max === "number" && s.length > max ? s.slice(0, max + 1) : s;
  };
})()`;

const UNCUT_RESULT =
  "[result reached the sandbox boundary uncut and was dropped]";

function makeRenderer(vm: QuickJSContext): {
  render: (value: QuickJSHandle, max: number) => string;
  handle: QuickJSHandle;
  dispose: () => void;
} {
  const fn = vm.unwrapResult(vm.evalCode(RENDER_SOURCE, "render.js"));
  return {
    handle: fn,
    render: (value, max) => {
      const budget = vm.newNumber(max);
      const r = vm.callFunction(fn, vm.undefined, value, budget);
      budget.dispose();
      if (r.error) {
        r.error.dispose();
        return "[value not rendered]";
      }
      // NOTE: The length is read off the VM string without copying it, and a result the VM side did
      // not cut is refused rather than copied — the fence on "bounded before it crosses". Measured
      // before: a 15-million-character result added 101 MB of RSS for one call (PR #485, round 10).
      const lengthHandle = vm.getProp(r.value, "length");
      const length = vm.getNumber(lengthHandle);
      lengthHandle.dispose();
      if (length > max + 1) {
        r.value.dispose();
        return UNCUT_RESULT;
      }
      const s = vm.getString(r.value);
      r.value.dispose();
      return s;
    },
    // NOTE: A handle still alive when the context goes trips an assertion inside JS_FreeRuntime
    // (measured: every call printed it until this line existed). The renderer's function handle is
    // the one that outlives the snippet, so it is released by hand, before the context.
    dispose: () => fn.dispose(),
  };
}

// A NUL or half a character the snippet built (`String.fromCharCode(0)`, a lone surrogate) would
// ride a console line or an error message into the ToolMessage, whose checkpoint is a jsonb write
// Postgres refuses — the turn would fail instead of returning the result (round 20). Repaired here,
// where the strings are made, the way every other third-party writer's text is.
const storable = makeStorable;

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${clipText(s, max)}…[truncated]`;
}

// `console` with the five methods a snippet reaches for, all writing to the same captured list.
// Each argument is rendered like a result would be, so `console.log({a: 1})` reads back as JSON and
// not as "[object Object]". The methods are VM code, and they cut each line to the budget BEFORE
// handing it to the host: a `console.log("x".repeat(15_000_000))` used to cross the boundary whole
// — copied out of the interpreter's 32 MB heap into the host's, where nothing bounds it — and
// measured +75 MB of RSS for one call, +143 MB for eight at once (PR #485, round 8). What reaches
// `emit` is at most one budget's worth, and the budget also caps how many calls reach it at all.
const CONSOLE_SOURCE = `(function (emit, render, maxChars) {
  var total = 0;
  // One past the budget, so the host still sees the overflow and writes its marker.
  function cut(s) {
    // Cut first, repair after, on the bounded text: a NUL is dropped HERE, inside the interpreter,
    // because the host reads a line as a C string and a NUL that crossed ended the line where it
    // stood ("a\\0b" arrived as "a", measured, round 20); half a character is one U+FFFD here,
    // where the host's byte-wise decoding made three of it. The cut itself can leave half a
    // character at the edge, which the same repair covers.
    var c = s.length > maxChars ? s.slice(0, maxChars + 1) : s;
    if (c.indexOf("\\u0000") >= 0) c = c.replace(/\\u0000/g, "");
    if (/[\\uD800-\\uDFFF]/.test(c)) c = c.replace(/[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/g, "\\uFFFD");
    return c;
  }
  function line(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      parts.push(cut(typeof a === "string" ? a : render(a)));
    }
    return cut(parts.join(" "));
  }
  var console = {};
  ["log", "info", "warn", "error", "debug"].forEach(function (name) {
    console[name] = function () {
      if (total >= maxChars) return;
      var l = line(arguments);
      // NOTE: The separator counts, so a bare console.log() in a loop spends the budget too: with
      // only the length counted, a million empty calls built a million-entry list on the host side
      // of the memory ceiling (PR #485, round 2).
      total += l.length + 1;
      emit(l);
    };
  });
  globalThis.console = console;
})`;

const UNCUT_CONSOLE_LINE =
  "[console line reached the sandbox boundary uncut and was dropped]";

function installConsole(
  vm: QuickJSContext,
  render: QuickJSHandle,
  logs: string[],
  maxChars: number,
): void {
  const emit = vm.newFunction("__emit", (line: QuickJSHandle) => {
    // NOTE: The length is read off the VM string without copying it, and a line the VM side did
    // not cut is refused rather than copied: that is the fence on "bounded before it crosses",
    // and what the test for it looks for.
    const lengthHandle = vm.getProp(line, "length");
    const length = vm.getNumber(lengthHandle);
    lengthHandle.dispose();
    if (length > maxChars + 1) {
      logs.push(UNCUT_CONSOLE_LINE);
      return;
    }
    // `clip` is the astral-safe cut and the marker.
    logs.push(clip(vm.getString(line), maxChars));
  });
  const factory = vm.unwrapResult(vm.evalCode(CONSOLE_SOURCE, "console.js"));
  const budget = vm.newNumber(maxChars);
  vm.unwrapResult(
    vm.callFunction(factory, vm.undefined, emit, render, budget),
  ).dispose();
  budget.dispose();
  factory.dispose();
  emit.dispose();
}

// Two validators the snippet can call instead of writing the algorithm. They exist because of a
// measurement, not a guess: with only the generic tool, gpt-4o-mini asked to validate the issue's
// CPF wrote a wrong algorithm in 2 of 6 runs (a `% 11` without the `* 10`, a second digit summed
// over nine positions instead of ten) and each wrong program returned a confident `false` — the
// authorship of the rule is where the model's error moves once the comparison leaves it. A
// check-digit routine that every Brazilian tenant needs is cheaper to ship once than to have
// rewritten per turn. The CNPJ one accepts the alphanumeric format (letters count as their ASCII
// code minus 48, the two check digits stay numeric), verified against the published example
// `12.ABC.345/01DE-35`.
const PRELUDE_SOURCE = `(function () {
  // Taken now, before any snippet: a top-level const named String would otherwise reach these
  // closures and break the advertised helpers (PR #485, round 11).
  var Str = String, Num = Number;
  function checkDigit(chars, weights) {
    var sum = 0;
    for (var i = 0; i < weights.length; i++) sum += (chars.charCodeAt(i) - 48) * weights[i];
    var r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  }
  globalThis.validateCpf = function (input) {
    var d = Str(input == null ? "" : input).replace(/\\D/g, "");
    if (d.length !== 11 || /^(\\d)\\1{10}$/.test(d)) return { valid: false };
    return {
      valid:
        checkDigit(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Num(d[9]) &&
        checkDigit(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Num(d[10]),
    };
  };
  globalThis.validateCnpj = function (input) {
    var s = Str(input == null ? "" : input).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(s) || /^(.)\\1{13}$/.test(s)) return { valid: false };
    return {
      valid:
        checkDigit(s, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Num(s[12]) &&
        checkDigit(s, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Num(s[13]),
    };
  };
})()`;

// `Date` in the agent's zone. The interpreter's own Date follows the HOST's zone (UTC in the
// container), and a Bun worker cannot be given another one (measured: `process.env.TZ` assigned
// inside the worker, or passed as its env, changes nothing) — nor should it, since the process zone
// is shared by every turn in flight. So the zone is applied inside: one host function answers the
// zone's offset at an instant (Intl lives on the host), and this prelude re-defines, on top of it,
// everything in Date that is local — the getters and setters, the component constructor, parsing of
// a date-time with no offset, and toString — while getTime, toISOString and the UTC methods stay the
// engine's. The two wall times without a single answer follow the spec (and Bun, which is where the
// tests' reference values come from): a time inside a spring gap keeps the offset from before it,
// a time that happens twice in autumn is its first occurrence.
const DATE_SHIM_SOURCE = `(function (offsetAt) {
  var NativeDate = Date;
  // Taken now, before any snippet, like the renderer's: a top-level const named isNaN reached
  // every method below and new Date().getDate() threw (PR #485, round 11).
  var Str = String, Num = Number, nan = isNaN;
  var abs = Math.abs, floor = Math.floor, ceil = Math.ceil;
  var defineProperty = Object.defineProperty, objectKeys = Object.keys;
  var proto = NativeDate.prototype;
  var getTime = proto.getTime;
  var setTime = proto.setTime;
  var SECOND = 1000;
  function wall(t) { return t + offsetAt(t) * SECOND; }
  // The wall time is not an instant, so the offset is not read AT it: read a day either side (the
  // true instant lies within 14 h of it, and no zone has two transitions in 48 h), and keep each
  // offset whose instant reads back as that offset. Two survive in an overlap, and the larger one
  // is the earlier instant, the spec's first occurrence; none survives in a gap, and the smaller is
  // the offset from before it, the spec's answer. Reading at the wall time itself (PR #485, round
  // 6) was right for a negative offset and a day late for a positive one: Auckland's 02:30 on the
  // gap morning came back as 01:30 standard time instead of 03:30 daylight time.
  var DAY = 86400000;
  function instant(w) {
    if (nan(w)) return NaN;
    var candidates = [offsetAt(w - DAY), offsetAt(w + DAY)];
    var best;
    var lowest = candidates[0];
    for (var i = 0; i < candidates.length; i++) {
      var o = candidates[i];
      if (o < lowest) lowest = o;
      if (offsetAt(w - o * SECOND) === o && (best === undefined || o > best)) best = o;
    }
    return w - (best === undefined ? lowest : best) * SECOND;
  }
  function define(name, fn) {
    defineProperty(proto, name, { value: fn, writable: true, configurable: true });
  }
  var getters = {
    getFullYear: "getUTCFullYear", getMonth: "getUTCMonth", getDate: "getUTCDate", getDay: "getUTCDay",
    getHours: "getUTCHours", getMinutes: "getUTCMinutes", getSeconds: "getUTCSeconds", getMilliseconds: "getUTCMilliseconds",
  };
  objectKeys(getters).forEach(function (name) {
    var utc = proto[getters[name]];
    define(name, function () {
      var t = getTime.call(this);
      return nan(t) ? NaN : utc.call(new NativeDate(wall(t)));
    });
  });
  define("getYear", function () { var y = this.getFullYear(); return nan(y) ? NaN : y - 1900; });
  define("setYear", function (y) {
    var n = Num(y);
    if (nan(n)) return setTime.call(this, NaN);
    var whole = n < 0 ? ceil(n) : floor(n);
    return this.setFullYear(whole >= 0 && whole <= 99 ? 1900 + whole : n);
  });
  // Whole minutes, cut toward zero like the engines do: −03:06:28 answers 186, +09:18:59 answers
  // −558 (Bun's own values).
  function minutesOf(seconds) { var m = seconds / 60; return m < 0 ? ceil(m) : floor(m); }
  define("getTimezoneOffset", function () {
    var t = getTime.call(this);
    return nan(t) ? NaN : -minutesOf(offsetAt(t));
  });
  var setters = {
    setFullYear: "setUTCFullYear", setMonth: "setUTCMonth", setDate: "setUTCDate", setHours: "setUTCHours",
    setMinutes: "setUTCMinutes", setSeconds: "setUTCSeconds", setMilliseconds: "setUTCMilliseconds",
  };
  objectKeys(setters).forEach(function (name) {
    var utc = proto[setters[name]];
    define(name, function () {
      var t = getTime.call(this);
      if (nan(t) && name !== "setFullYear") return NaN;
      var w = new NativeDate(nan(t) ? 0 : wall(t));
      utc.apply(w, arguments);
      return setTime.call(this, instant(getTime.call(w)));
    });
  });
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad(n, width) {
    var s = Str(abs(n));
    while (s.length < width) s = "0" + s;
    return (n < 0 ? "-" : "") + s;
  }
  function dateText(w) {
    return DAYS[w.getUTCDay()] + " " + MONTHS[w.getUTCMonth()] + " " + pad(w.getUTCDate(), 2) + " " + pad(w.getUTCFullYear(), 4);
  }
  function timeText(w) {
    return pad(w.getUTCHours(), 2) + ":" + pad(w.getUTCMinutes(), 2) + ":" + pad(w.getUTCSeconds(), 2);
  }
  function zoneText(t) {
    var o = offsetAt(t);
    var a = abs(minutesOf(o));
    return "GMT" + (o < 0 ? "-" : "+") + pad(floor(a / 60), 2) + pad(a % 60, 2);
  }
  function isoDate(w) {
    return pad(w.getUTCFullYear(), 4) + "-" + pad(w.getUTCMonth() + 1, 2) + "-" + pad(w.getUTCDate(), 2);
  }
  function local(self, render) {
    var t = getTime.call(self);
    return nan(t) ? "Invalid Date" : render(new NativeDate(wall(t)), t);
  }
  define("toDateString", function () { return local(this, dateText); });
  define("toTimeString", function () { return local(this, function (w, t) { return timeText(w) + " " + zoneText(t); }); });
  define("toString", function () { return local(this, function (w, t) { return dateText(w) + " " + timeText(w) + " " + zoneText(t); }); });
  define("toLocaleDateString", function () { return local(this, isoDate); });
  define("toLocaleTimeString", function () { return local(this, timeText); });
  define("toLocaleString", function () { return local(this, function (w) { return isoDate(w) + " " + timeText(w); }); });
  // The wall clock is what the engine makes of the same text as UTC, so a field out of range is NaN
  // exactly where the engine says so (month 13, minute 60) and normalises exactly where it does
  // (February 30, 24:00): the two spellings of one instant agree field for field. The engine's own
  // ISO form (measured, round 14): an expanded year, a month or a day left out, and a fraction of
  // ANY length after a dot or a comma, not the spec's three digits; a text the pattern missed went
  // to the free-form path below instead, which is the engine's HOST reading.
  var LOCAL = /^\\s*(?:[+-]\\d{6}|\\d{4})(?:-\\d{2}(?:-\\d{2})?)?T\\d{2}:\\d{2}(?::\\d{2}(?:[.,]\\d+)?)?\\s*$/;
  // What carries its own zone, or is a date alone (UTC by the spec): the engine's answer is final.
  // The engine's own table, measured token by token (PR #485, round 10): Z; UT/UTC/GMT with or
  // without an offset; a bare offset with one or two hour digits; the North American abbreviations
  // and CET/CEST; any of them followed by parenthesised names. A parenthesis alone, or a token
  // the engine does not know (BST, JST), is not a zone — it reads as host-local or as NaN.
  // NOTE: Not \\b before the letters: "12:00:00Z" has no word boundary between the digit and the Z,
  // and the ISO instant was read as host-local until this was a lookbehind. And a bare offset is
  // not one when it is the last part of a date: "09-05-2026", or "2026-09-05" with a space around
  // it, ends in a sign and digits that the engine read as the day or the year (round 14).
  var DESIGNATED = /(?:(?<![A-Za-z])Z|(?<![A-Za-z])(?:UTC?|GMT)(?:[+-]\\d{1,2}(?::?\\d{2})?)?|(?<!-\\d{1,2})[+-]\\d{1,2}(?::?\\d{2})?|(?<![A-Za-z])(?:[ECMP][SD]T|CES?T))(?:\\s*\\([^)]*\\))*\\s*$/i;
  // The spec's date alone, exactly: padded with a space it is the free form, and local (measured
  // in the engine and in JSC alike).
  var DATE_ONLY = /^(?:[+-]\\d{6}|\\d{4})(?:-\\d{2}){0,2}$/;
  function parse(text) {
    var s = Str(text);
    var m = LOCAL.exec(s);
    if (m) return instant(NativeDate.parse(m[0].trim() + "Z"));
    var t = NativeDate.parse(s);
    if (nan(t) || DESIGNATED.test(s) || DATE_ONLY.test(s)) return t;
    // Every other offset-less text the engine accepts ("2026/09/05 12:00", "Sep 5, 2026 12:00") it
    // read in the HOST's zone — measured: the value moved by three hours between a UTC host and a
    // São Paulo one (PR #485, round 7). The instant it made does not give the wall clock back: the
    // engine adds the host's offset AT THE WALL CLOCK READ AS UTC, so around a host transition two
    // wall clocks make one instant (New York, March 8th: 06:30 and 07:30 both become 11:30Z), and
    // reading the offset back off the instant (rounds 7 to 13) returned the later one, an hour late
    // in the agent's zone (round 14). Read the text itself as UTC instead: the engine's free-form
    // grammar takes a designator at the end of every form it accepts (measured, comments included),
    // and the last one wins, which is why a text with its own was returned above. A form the engine
    // accepts alone and refuses with the suffix is not known; it would be Invalid Date here, and
    // never the host's reading.
    return instant(NativeDate.parse(s + " UTC"));
  }
  function primitive(v) {
    if (v instanceof NativeDate) return getTime.call(v);
    if (v !== null && typeof v === "object") {
      var p = v.valueOf();
      return typeof p === "object" ? Str(v) : p;
    }
    return v;
  }
  function ShimDate(a) {
    if (!(this instanceof ShimDate)) return new ShimDate().toString();
    var t;
    if (arguments.length === 0) t = NativeDate.now();
    else if (arguments.length === 1) {
      var p = primitive(a);
      t = typeof p === "string" ? parse(p) : Num(p);
    } else t = instant(NativeDate.UTC.apply(null, arguments));
    return new NativeDate(t);
  }
  ShimDate.prototype = proto;
  define("constructor", ShimDate);
  ShimDate.now = NativeDate.now;
  ShimDate.UTC = NativeDate.UTC;
  ShimDate.parse = parse;
  defineProperty(ShimDate, "name", { value: "Date" });
  defineProperty(ShimDate, "length", { value: 7 });
  globalThis.Date = ShimDate;
})(__tzOffset);
delete globalThis.__tzOffset;`;

// The host side of the shim: the zone's offset at an instant, in seconds, memoised because a snippet that reads
// the same date's fields one after another asks for the same instant each time.
function installZone(vm: QuickJSContext, timezone: string): void {
  const fmt = zoneFormatter(timezone);
  const cache = new Map<number, number>();
  const fn = vm.newFunction("__tzOffset", (handle: QuickJSHandle) => {
    const t = vm.getNumber(handle);
    let offset = cache.get(t);
    if (offset === undefined) {
      offset = zoneOffsetSeconds(fmt, t);
      if (cache.size >= 4096) cache.clear();
      cache.set(t, offset);
    }
    return vm.newNumber(offset);
  });
  vm.setProp(vm.global, "__tzOffset", fn);
  fn.dispose();
  vm.unwrapResult(vm.evalCode(DATE_SHIM_SOURCE, "date.js")).dispose();
}

function installPrelude(vm: QuickJSContext): void {
  vm.unwrapResult(vm.evalCode(PRELUDE_SOURCE, "prelude.js")).dispose();
}

// The agent's clock, as two strings: the IANA zone and the current instant written in that zone
// with its UTC offset (`2026-09-02T19:05:33-03:00`). A model doing date arithmetic reads the local
// date off the string and `new Date(NOW_LOCAL)` is the exact instant, which is what n8n's `$now` /
// `$today` give a Code node from the workflow's timezone.
function installClock(
  vm: QuickJSContext,
  clock: SandboxRequest["clock"],
): void {
  for (const [name, value] of [
    ["TIMEZONE", clock.timezone],
    ["NOW_LOCAL", clock.nowLocal],
  ] as const) {
    const handle = vm.newString(value);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  }
}

// The tool's call, in function-body mode: `input` (the model's arguments, validated by the tool's
// schema) and `context` (what the turn knows about the conversation), each crossing as JSON text —
// one copy, no host object reference, the same discipline as the clock strings. `__takeArgs`
// parses both and deletes the three names before the body runs (arguments are evaluated before the
// call), so the body sees `input` and `context` as parameters and nothing new on the global object.
function installCall(vm: QuickJSContext, call: SandboxCall): void {
  for (const [name, value] of [
    ["__INPUT_JSON", call.input],
    ["__CONTEXT_JSON", call.context],
  ] as const) {
    const handle = vm.newString(value);
    vm.setProp(vm.global, name, handle);
    handle.dispose();
  }
  vm.unwrapResult(vm.evalCode(TAKE_ARGS_SOURCE, "args.js")).dispose();
}

const TAKE_ARGS_SOURCE = `(function () {
  var parse = JSON.parse;
  globalThis.__takeArgs = function () {
    var args = [parse(globalThis.__INPUT_JSON), parse(globalThis.__CONTEXT_JSON)];
    delete globalThis.__INPUT_JSON;
    delete globalThis.__CONTEXT_JSON;
    delete globalThis.__takeArgs;
    return args;
  };
})()`;

// The body runs as a FUNCTION, so `return` is how it answers and the wrapper's opening line is the
// only line above it (the consumer sits on the last line): a line the engine reports is the body's
// line plus one. Without a call the source runs as a bare script and its completion value is the
// result — the engine tests' harness, not a production path.
function wrap(code: string, call: boolean): { source: string; offset: number } {
  if (!call) return { source: code, offset: 0 };
  return {
    source: `(function (input, context) {\n${code}\n})(...__takeArgs())`,
    offset: 1,
  };
}

const RENDER_BUDGET_MS = 200;
const ERROR_NAME_MAX_CHARS = 100;

// The engine's own limit is a QuickJS error; the HOST's is a RangeError thrown by JSC through the
// WASM frames, when the interrupt handler (a JS callback, fired every 10k opcodes) is entered at a
// depth the thread's native stack cannot take. Measured with the budget at 512 KiB: the native
// limit came first (~2,400 frames on macOS), and only when an interrupt happened to fire deep, so
// the recursion test passed by phase. The frames that throw unwinds never ran their epilogues (the
// shadow stack pointer is wherever the deepest one left it), so after it NOTHING in the interpreter
// is called again — no dump, no dispose; the thread is discarded with the reply. Left uncaught, the
// RangeError was what killed the thread (`stack` came back as `aborted`). The budget is sized so
// this is the exception (code-sandbox.ts), and this is what a thread with less room gets.
const HOST_STACK_LIMIT = {
  ok: false,
  error: { name: "InternalError", message: "stack overflow" } as ThrownValue,
  limit: "stack",
  unwound: true,
} as const;

function evalOrUnwind(
  vm: QuickJSContext,
  source: string,
): ReturnType<QuickJSContext["evalCode"]> | undefined {
  try {
    return vm.evalCode(source, "snippet.js");
  } catch (e) {
    if (e instanceof RangeError) return undefined;
    throw e;
  }
}

function evaluate(
  vm: QuickJSContext,
  code: string,
  readError: (handle: QuickJSHandle) => ThrownValue,
  call: boolean,
):
  | { ok: true; value: QuickJSHandle }
  | { ok: false; error: ThrownValue; limit?: SandboxLimit; unwound?: true } {
  const { source, offset } = wrap(code, call);
  const r = evalOrUnwind(vm, source);
  if (r === undefined) return HOST_STACK_LIMIT;
  if (!r.error) return { ok: true, value: r.value };
  const err = readError(r.error);
  return {
    ok: false,
    error: withSourceLine(err, code, offset),
    limit: limitOf(err),
  };
}

// Reading a thrown value RUNS the snippet's code again: `message` can be a getter, `toString` a
// method, and both are the snippet's. n8n's Python sandbox was escaped through exactly that seam
// (CVE-2026-0863: the formatting of an attacker-built exception ran outside the sandbox's checks).
// Here the read happens inside the interpreter, so the snippet's own deadline still governs it, and
// an interrupted read is reported as such rather than thrown. Measured: a getter that loops forever
// comes back at the deadline. The deadline is deliberately NOT renewed for this read — renewing it
// handed that getter 200 ms more, and a legitimate error object takes microseconds to read. The
// reader also CUTS name, message and stack to one past the budget before anything crosses the
// boundary: `throw new Error("y".repeat(15_000_000))` used to be copied whole into the host's heap
// (PR #485, round 10), and the bindings it uses are taken before any snippet runs.
const DESCRIBE_ERROR_SOURCE = `(function () {
  var stringify = JSON.stringify, Str = String;
  return function (e, max) {
    function cut(s) { return s.length > max ? s.slice(0, max + 1) : s; }
    function read(get, fallback) { try { return get(); } catch (x) { return fallback; } }
    var out = {};
    if (e === null || typeof e !== "object") {
      out.name = "Error";
      out.message = cut(read(function () { return Str(e); }, "[unreadable]"));
      return stringify(out);
    }
    var name = read(function () { return e.name; }, undefined);
    var message = read(function () { return e.message; }, undefined);
    out.name = typeof name === "string" ? cut(name) : "Error";
    out.message = typeof message === "string"
      ? cut(message)
      : cut(read(function () { var s = stringify(e); return s === undefined ? Str(e) : s; }, "[unreadable]"));
    var line = read(function () { return e.lineNumber; }, undefined);
    if (typeof line === "number") out.lineNumber = line;
    var stack = read(function () { return e.stack; }, undefined);
    if (typeof stack === "string") out.stack = cut(stack);
    return stringify(out);
  };
})()`;

interface ThrownValue {
  name: string;
  message: string;
  lineNumber?: number;
  stack?: string;
}

const UNREAD_ERROR: ThrownValue = {
  name: "Error",
  message: "[the thrown value could not be read within the deadline]",
};
const UNCUT_ERROR: ThrownValue = {
  name: "Error",
  message: "[thrown value reached the sandbox boundary uncut and was dropped]",
};

function makeErrorReader(
  vm: QuickJSContext,
  maxChars: number,
): { read: (handle: QuickJSHandle) => ThrownValue; dispose: () => void } {
  const fn = vm.unwrapResult(vm.evalCode(DESCRIBE_ERROR_SOURCE, "describe.js"));
  // Three cut fields, each up to six times longer once JSON-escaped, plus the envelope: the ceiling
  // the description of a thrown value cannot legitimately pass.
  const ceiling = 3 * 6 * (maxChars + 1) + 256;
  return {
    read: (handle) => {
      const budget = vm.newNumber(maxChars);
      const r = vm.callFunction(fn, vm.undefined, handle, budget);
      budget.dispose();
      handle.dispose();
      if (r.error) {
        r.error.dispose();
        return UNREAD_ERROR;
      }
      const lengthHandle = vm.getProp(r.value, "length");
      const length = vm.getNumber(lengthHandle);
      lengthHandle.dispose();
      if (length > ceiling) {
        r.value.dispose();
        return UNCUT_ERROR;
      }
      const json = vm.getString(r.value);
      r.value.dispose();
      try {
        return JSON.parse(json) as ThrownValue;
      } catch {
        return UNREAD_ERROR;
      }
    },
    dispose: () => fn.dispose(),
  };
}

// An error names its line, and the model needs the line more than the message: measured live,
// gpt-4o-mini re-sent the same unparseable snippet nine times on "unexpected token in expression:
// ''" alone. `offset` is the wrapper line the function-body retry adds above the snippet.
function withSourceLine(
  error: ThrownValue,
  code: string,
  offset: number,
): ThrownValue {
  const e = error;
  // NOTE: A SyntaxError carries `lineNumber`; a runtime error carries the line in the first frame of
  // its stack (`at <eval> (snippet.js:2:5)`).
  const fromStack =
    typeof e.stack === "string"
      ? /snippet\.js:(\d+)/.exec(e.stack)?.[1]
      : undefined;
  const reported =
    typeof e.lineNumber === "number"
      ? e.lineNumber
      : fromStack
        ? Number(fromStack)
        : undefined;
  if (reported === undefined) return error;
  const lines = code.split("\n");
  // NOTE: In function-body mode an error at the end of the body (an unfinished `input.cpf.`, an
  // unclosed brace) is reported on the wrapper's closing line, past the body; it lands on the
  // body's last line instead.
  const line =
    offset > 0 ? Math.min(reported - offset, lines.length) : reported - offset;
  const text = lines[line - 1];
  if (text === undefined) return error;
  return {
    ...e,
    message: `${String(e.message)} (line ${line}: ${clipText(text.trim(), 120)})`,
  };
}

// Everything that stands before the snippet: the runtime and its limits, the context, the renderer,
// the error reader, the four preludes. What fails here is the sandbox's own, never the snippet's.
interface Session {
  runtime: ReturnType<typeof QuickJS.newRuntime>;
  vm: QuickJSContext;
  renderer: ReturnType<typeof makeRenderer>;
  errors: ReturnType<typeof makeErrorReader>;
  logs: string[];
}

function open(req: SandboxRequest): Session {
  const logs: string[] = [];
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(req.memoryBytes);
  runtime.setMaxStackSize(req.stackBytes);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + req.timeoutMs),
  );
  const vm = runtime.newContext();
  const renderer = makeRenderer(vm);
  const errors = makeErrorReader(vm, req.maxChars);
  installConsole(vm, renderer.handle, logs, req.maxChars);
  installZone(vm, req.clock.timezone);
  installPrelude(vm);
  installClock(vm, req.clock);
  if (req.call) installCall(vm, req.call);
  return { runtime, vm, renderer, errors, logs };
}

function run(req: SandboxRequest): SandboxReply {
  const started = performance.now();
  let session: Session;
  try {
    session = open(req);
  } catch (e) {
    // The thread is discarded with the reply, so nothing half-built is freed here.
    const reason = e instanceof Error ? e.message : String(e);
    return {
      kind: "unavailable",
      reason: `the interpreter could not be set up: ${reason}`,
    };
  }
  const { runtime, vm, renderer, errors, logs } = session;
  const render = renderer.render;
  const renewDeadline = () =>
    runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + RENDER_BUDGET_MS),
    );
  let unwound = false;
  try {
    const out = evaluate(vm, req.code, errors.read, req.call !== undefined);
    const ms = Math.round(performance.now() - started);
    if (out.ok) {
      // NOTE: Rendering runs interpreter code too, on its own short deadline: a snippet that spent its
      // whole budget building the value would otherwise have its result interrupted mid-render and
      // come back as "[object Object]" (measured, and fenced by test).
      renewDeadline();
      const value = clip(render(out.value, req.maxChars), req.maxChars);
      out.value.dispose();
      return {
        kind: "value",
        value: storable(value),
        logs: logs.map(storable),
        ms,
      };
    }
    const e = out.error as ThrownValue;
    // NOTE: The name is the snippet's too (`e.name = "x".repeat(1e6)` is one assignment), so it is
    // bounded like the message; a real error name is an identifier.
    const name = clip(e.name, ERROR_NAME_MAX_CHARS);
    const message = e.message;
    unwound = out.unwound === true;
    return {
      kind: "error",
      name: storable(name),
      message: storable(clip(message, req.maxChars)),
      logs: logs.map(storable),
      ms,
      ...(out.limit ? { limit: out.limit } : {}),
    };
  } finally {
    // NOTE: A runtime the host unwound through (HOST_STACK_LIMIT) is NOT freed: its frames never
    // ran their epilogues, and `JS_FreeRuntime` asserts on what they left — measured, an engine
    // abort printed on every such call. The reply still posts (the abort is caught here), so the
    // outcome cannot tell; the fence is the fixture that reads the thread's stderr. The thread is
    // discarded with the reply either way. Freeing is best effort on the normal path too.
    if (!unwound) {
      try {
        errors.dispose();
        renderer.dispose();
        vm.dispose();
        runtime.dispose();
      } catch {}
    }
  }
}

self.onmessage = (ev: MessageEvent<SandboxRequest>) => {
  self.postMessage(run(ev.data) satisfies SandboxReply);
};

self.postMessage({ kind: "ready" } satisfies SandboxReply);
