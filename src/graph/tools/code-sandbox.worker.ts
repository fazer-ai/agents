// The thread that runs ONE model-authored snippet and exits. Spawned per call by code-sandbox.ts,
// which explains why a thread and why a fresh one; this file is the interpreter side of that
// contract and knows nothing about the tool.
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
import { clipText } from "@/lib/text";
import { zoneFormatter, zoneOffsetMinutes } from "./zone-offset";

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
}

export type SandboxReply =
  | { kind: "ready" }
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
function limitOf(error: unknown): SandboxLimit | undefined {
  const e = error as { name?: unknown; message?: unknown } | null;
  if (e?.name !== "InternalError") return undefined;
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
const RENDER_SOURCE = `(function (root) {
  function conv(x, stack) {
    if (typeof x === "bigint") return x.toString();
    if (typeof x === "number" && !isFinite(x)) return String(x);
    if (typeof x === "function") return "[function]";
    if (typeof x === "symbol") return x.toString();
    if (x === null || typeof x !== "object") return x;
    if (stack.indexOf(x) !== -1) return "[circular]";
    if (stack.length >= 64) return "[nested too deep]";
    if (x instanceof Date) return isNaN(x.getTime()) ? "Invalid Date" : x.toISOString();
    if (x instanceof Error) return { name: x.name, message: x.message };
    if (x instanceof Map || x instanceof Set) x = Array.from(x);
    var next = stack.concat([x]);
    if (Array.isArray(x)) return x.map(function (e) { var v = conv(e, next); return v === undefined ? null : v; });
    // No prototype: with one, assigning the key "__proto__" reaches the legacy setter instead of
    // the object, and a parsed document carrying that key (JSON.parse keeps it as a plain own key)
    // rendered without it (PR #485, round 3).
    var out = Object.create(null);
    var keys = Object.keys(x);
    for (var i = 0; i < keys.length; i++) {
      var v = conv(x[keys[i]], next);
      if (v !== undefined) out[keys[i]] = v;
    }
    return out;
  }
  if (root === undefined) return "undefined";
  if (typeof root === "bigint") return root.toString();
  if (typeof root === "number" && !isFinite(root)) return String(root);
  try {
    var s = JSON.stringify(conv(root, []));
    return s === undefined ? String(root) : s;
  } catch (e) {
    return String(root);
  }
})`;

function makeRenderer(vm: QuickJSContext): {
  render: (value: QuickJSHandle) => string;
  dispose: () => void;
} {
  const fn = vm.unwrapResult(vm.evalCode(RENDER_SOURCE, "render.js"));
  return {
    render: (value) => {
      const r = vm.callFunction(fn, vm.undefined, value);
      if (r.error) {
        r.error.dispose();
        return String(vm.dump(value));
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

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${clipText(s, max)}…[truncated]`;
}

// `console` with the four methods a snippet reaches for, all writing to the same captured list.
// Each argument is rendered like a result would be, so `console.log({a: 1})` reads back as JSON and
// not as "[object Object]".
function installConsole(
  vm: QuickJSContext,
  render: (value: QuickJSHandle) => string,
  logs: string[],
  maxChars: number,
): void {
  const consoleObj = vm.newObject();
  let total = 0;
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const fn = vm.newFunction(method, (...args: QuickJSHandle[]) => {
      if (total >= maxChars) return;
      const line = args
        .map((a) => (vm.typeof(a) === "string" ? vm.getString(a) : render(a)))
        .join(" ");
      // NOTE: The separator counts, so a bare `console.log()` in a loop spends the budget too: with
      // only `line.length` counted, a million empty calls built a million-entry array on this side
      // of the memory ceiling (PR #485, round 2).
      total += line.length + 1;
      logs.push(clip(line, maxChars));
    });
    vm.setProp(consoleObj, method, fn);
    fn.dispose();
  }
  vm.setProp(vm.global, "console", consoleObj);
  consoleObj.dispose();
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
  function checkDigit(chars, weights) {
    var sum = 0;
    for (var i = 0; i < weights.length; i++) sum += (chars.charCodeAt(i) - 48) * weights[i];
    var r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  }
  globalThis.validateCpf = function (input) {
    var d = String(input == null ? "" : input).replace(/\\D/g, "");
    if (d.length !== 11 || /^(\\d)\\1{10}$/.test(d)) return { valid: false };
    return {
      valid:
        checkDigit(d, [10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[9]) &&
        checkDigit(d, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(d[10]),
    };
  };
  globalThis.validateCnpj = function (input) {
    var s = String(input == null ? "" : input).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(s) || /^(.)\\1{13}$/.test(s)) return { valid: false };
    return {
      valid:
        checkDigit(s, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(s[12]) &&
        checkDigit(s, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(s[13]),
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
  var proto = NativeDate.prototype;
  var getTime = proto.getTime;
  var setTime = proto.setTime;
  var MINUTE = 60000;
  function wall(t) { return t + offsetAt(t) * MINUTE; }
  // The wall time is not an instant, so the offset is not read AT it: read a day either side (the
  // true instant lies within 14 h of it, and no zone has two transitions in 48 h), and keep each
  // offset whose instant reads back as that offset. Two survive in an overlap, and the larger one
  // is the earlier instant, the spec's first occurrence; none survives in a gap, and the smaller is
  // the offset from before it, the spec's answer. Reading at the wall time itself (PR #485, round
  // 6) was right for a negative offset and a day late for a positive one: Auckland's 02:30 on the
  // gap morning came back as 01:30 standard time instead of 03:30 daylight time.
  var DAY = 86400000;
  function instant(w) {
    if (isNaN(w)) return NaN;
    var candidates = [offsetAt(w - DAY), offsetAt(w + DAY)];
    var best;
    var lowest = candidates[0];
    for (var i = 0; i < candidates.length; i++) {
      var o = candidates[i];
      if (o < lowest) lowest = o;
      if (offsetAt(w - o * MINUTE) === o && (best === undefined || o > best)) best = o;
    }
    return w - (best === undefined ? lowest : best) * MINUTE;
  }
  function define(name, fn) {
    Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
  }
  var getters = {
    getFullYear: "getUTCFullYear", getMonth: "getUTCMonth", getDate: "getUTCDate", getDay: "getUTCDay",
    getHours: "getUTCHours", getMinutes: "getUTCMinutes", getSeconds: "getUTCSeconds", getMilliseconds: "getUTCMilliseconds",
  };
  Object.keys(getters).forEach(function (name) {
    var utc = proto[getters[name]];
    define(name, function () {
      var t = getTime.call(this);
      return isNaN(t) ? NaN : utc.call(new NativeDate(wall(t)));
    });
  });
  define("getYear", function () { var y = this.getFullYear(); return isNaN(y) ? NaN : y - 1900; });
  define("setYear", function (y) {
    var n = Number(y);
    if (isNaN(n)) return setTime.call(this, NaN);
    var whole = n < 0 ? Math.ceil(n) : Math.floor(n);
    return this.setFullYear(whole >= 0 && whole <= 99 ? 1900 + whole : n);
  });
  define("getTimezoneOffset", function () {
    var t = getTime.call(this);
    return isNaN(t) ? NaN : -offsetAt(t);
  });
  var setters = {
    setFullYear: "setUTCFullYear", setMonth: "setUTCMonth", setDate: "setUTCDate", setHours: "setUTCHours",
    setMinutes: "setUTCMinutes", setSeconds: "setUTCSeconds", setMilliseconds: "setUTCMilliseconds",
  };
  Object.keys(setters).forEach(function (name) {
    var utc = proto[setters[name]];
    define(name, function () {
      var t = getTime.call(this);
      if (isNaN(t) && name !== "setFullYear") return NaN;
      var w = new NativeDate(isNaN(t) ? 0 : wall(t));
      utc.apply(w, arguments);
      return setTime.call(this, instant(getTime.call(w)));
    });
  });
  var DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function pad(n, width) {
    var s = String(Math.abs(n));
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
    var a = Math.abs(o);
    return "GMT" + (o < 0 ? "-" : "+") + pad(Math.floor(a / 60), 2) + pad(a % 60, 2);
  }
  function isoDate(w) {
    return pad(w.getUTCFullYear(), 4) + "-" + pad(w.getUTCMonth() + 1, 2) + "-" + pad(w.getUTCDate(), 2);
  }
  function local(self, render) {
    var t = getTime.call(self);
    return isNaN(t) ? "Invalid Date" : render(new NativeDate(wall(t)), t);
  }
  define("toDateString", function () { return local(this, dateText); });
  define("toTimeString", function () { return local(this, function (w, t) { return timeText(w) + " " + zoneText(t); }); });
  define("toString", function () { return local(this, function (w, t) { return dateText(w) + " " + timeText(w) + " " + zoneText(t); }); });
  define("toLocaleDateString", function () { return local(this, isoDate); });
  define("toLocaleTimeString", function () { return local(this, timeText); });
  define("toLocaleString", function () { return local(this, function (w) { return isoDate(w) + " " + timeText(w); }); });
  // The wall clock is what the engine makes of the same text as UTC, so a field out of range is NaN
  // exactly where the engine says so (month 13, minute 60) and normalises exactly where it does
  // (February 30, 24:00): the two spellings of one instant agree field for field.
  var LOCAL = /^\\s*(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?\\s*$/;
  function parse(text) {
    var m = LOCAL.exec(String(text));
    if (!m) return NativeDate.parse(text);
    return instant(NativeDate.parse(m[0].trim() + "Z"));
  }
  function primitive(v) {
    if (v instanceof NativeDate) return getTime.call(v);
    if (v !== null && typeof v === "object") {
      var p = v.valueOf();
      return typeof p === "object" ? String(v) : p;
    }
    return v;
  }
  function ShimDate(a) {
    if (!(this instanceof ShimDate)) return new ShimDate().toString();
    var t;
    if (arguments.length === 0) t = NativeDate.now();
    else if (arguments.length === 1) {
      var p = primitive(a);
      t = typeof p === "string" ? parse(p) : Number(p);
    } else t = instant(NativeDate.UTC.apply(null, arguments));
    return new NativeDate(t);
  }
  ShimDate.prototype = proto;
  define("constructor", ShimDate);
  ShimDate.now = NativeDate.now;
  ShimDate.UTC = NativeDate.UTC;
  ShimDate.parse = parse;
  Object.defineProperty(ShimDate, "name", { value: "Date" });
  Object.defineProperty(ShimDate, "length", { value: 7 });
  globalThis.Date = ShimDate;
})(__tzOffset);
delete globalThis.__tzOffset;`;

// The host side of the shim: the zone's offset at an instant, memoised because a snippet that reads
// the same date's fields one after another asks for the same instant each time.
function installZone(vm: QuickJSContext, timezone: string): void {
  const fmt = zoneFormatter(timezone);
  const cache = new Map<number, number>();
  const fn = vm.newFunction("__tzOffset", (handle: QuickJSHandle) => {
    const t = vm.getNumber(handle);
    let offset = cache.get(t);
    if (offset === undefined) {
      offset = zoneOffsetMinutes(fmt, t);
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

// A snippet is evaluated as a script, so its result is the completion value: the last expression,
// REPL-style, which is how the tool description tells the model to end it. A snippet that ends in
// `return` instead is a SyntaxError as a script and a perfectly good function body, and a model told
// "return the verdict" writes exactly that, so the one specific SyntaxError that means "you wrote
// a function body" gets the snippet re-run as one. Any other error is the snippet's own.
const RETURN_AT_TOP_LEVEL = /return not in a function/;

// A snippet that ends with an object literal in statement position — `…; { day, days }` — is a
// BLOCK to the parser, so its value is the last expression in it (or a SyntaxError once a property
// has a key), and a model that wanted the object back gets a number or a parse error. Measured live
// (PR #485): 2 of 3 date answers went wrong this way, one of them through three SyntaxError round
// trips before the model added parentheses. So a trailing `{…}` that sits at a statement boundary
// (start of code, `;`, `}` or a line break — not after `)`, `=>`, `else`, `try`…) is tried first with
// parentheses around it, and the original source is what runs if that does not parse.
function withTrailingObjectWrapped(code: string): string | undefined {
  const end = code.replace(/[\s;]+$/, "").length;
  if (end === 0 || code[end - 1] !== "}") return undefined;
  let depth = 0;
  let start = -1;
  for (let i = end - 1; i >= 0; i--) {
    const c = code[i];
    if (c === "}") depth++;
    else if (c === "{" && --depth === 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  const before = code.slice(0, start).replace(/\s+$/, "");
  // NOTE: A closing brace is a boundary too — `if (…) { … } { day, days }` is the shape measured
  // live, once the model guards the month roll-over with a block first.
  const boundary =
    before.length === 0 ||
    /[;}\n]$/.test(code.slice(0, start).replace(/[ \t]+$/, ""));
  if (!boundary) return undefined;
  // NOTE: A separator as well as the parenthesis. Without one, a snippet that leaves semicolons out
  // (`const r = compute()\n{ valid: r.valid }`) reads on as a call — `compute()({…})` — which
  // parses, and then fails at run time, past the fallback (PR #485, round 6).
  return `${code.slice(0, start)};(${code.slice(start, end)})${code.slice(end)}`;
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
  error: { name: "InternalError", message: "stack overflow" },
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
):
  | { ok: true; value: QuickJSHandle }
  | { ok: false; error: unknown; limit?: SandboxLimit; unwound?: true } {
  const wrapped = withTrailingObjectWrapped(code);
  if (wrapped !== undefined) {
    const asObject = evalOrUnwind(vm, wrapped);
    if (asObject === undefined) return HOST_STACK_LIMIT;
    if (!asObject.error) return { ok: true, value: asObject.value };
    const err = dumpError(vm, asObject.error) as { name?: string } | null;
    // NOTE: Only a parse failure sends the original source through; a snippet that threw at runtime
    // with the parentheses on would throw the same without them, and would run twice.
    if (err?.name !== "SyntaxError") {
      return {
        ok: false,
        error: withSourceLine(err, code, 0),
        limit: limitOf(err),
      };
    }
  }
  const first = evalOrUnwind(vm, code);
  if (first === undefined) return HOST_STACK_LIMIT;
  if (!first.error) return { ok: true, value: first.value };
  const error = dumpError(vm, first.error) as {
    name?: string;
    message?: string;
  };
  if (
    error?.name !== "SyntaxError" ||
    !RETURN_AT_TOP_LEVEL.test(error.message ?? "")
  ) {
    return {
      ok: false,
      error: withSourceLine(error, code, 0),
      limit: limitOf(error),
    };
  }
  const second = evalOrUnwind(vm, `(function () {\n${code}\n})()`);
  if (second === undefined) return HOST_STACK_LIMIT;
  if (second.error) {
    const err = dumpError(vm, second.error);
    return {
      ok: false,
      error: withSourceLine(err, code, 1),
      limit: limitOf(err),
    };
  }
  return { ok: true, value: second.value };
}

// Reading a thrown value RUNS the snippet's code again: `message` can be a getter, `toString` a
// method, and both are the snippet's. n8n's Python sandbox was escaped through exactly that seam
// (CVE-2026-0863: the formatting of an attacker-built exception ran outside the sandbox's checks).
// Here the read happens inside the interpreter, so the snippet's own deadline still governs it, and
// `dump` returns a placeholder rather than throwing when it is interrupted. Measured: a getter that
// loops forever comes back as "[object Object]" at the deadline. The deadline is deliberately NOT
// renewed for this read — renewing it handed that getter 200 ms more, and a legitimate error object
// takes microseconds to read.
function dumpError(vm: QuickJSContext, handle: QuickJSHandle): unknown {
  const value = vm.dump(handle);
  handle.dispose();
  return value;
}

// An error names its line, and the model needs the line more than the message: measured live,
// gpt-4o-mini re-sent the same unparseable snippet nine times on "unexpected token in expression:
// ''" alone. `offset` is the wrapper line the function-body retry adds above the snippet.
function withSourceLine(error: unknown, code: string, offset: number): unknown {
  const e = error as {
    name?: unknown;
    message?: unknown;
    lineNumber?: unknown;
    stack?: unknown;
  } | null;
  if (!e || typeof e !== "object") return error;
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
  const line = reported - offset;
  const text = code.split("\n")[line - 1];
  if (text === undefined) return error;
  return {
    ...e,
    message: `${String(e.message)} (line ${line}: ${clipText(text.trim(), 120)})`,
  };
}

function run(req: SandboxRequest): SandboxReply {
  const started = performance.now();
  const logs: string[] = [];
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(req.memoryBytes);
  runtime.setMaxStackSize(req.stackBytes);
  runtime.setInterruptHandler(
    shouldInterruptAfterDeadline(Date.now() + req.timeoutMs),
  );
  const vm = runtime.newContext();
  const renderer = makeRenderer(vm);
  const render = renderer.render;
  const renewDeadline = () =>
    runtime.setInterruptHandler(
      shouldInterruptAfterDeadline(Date.now() + RENDER_BUDGET_MS),
    );
  let unwound = false;
  try {
    installConsole(vm, render, logs, req.maxChars);
    installZone(vm, req.clock.timezone);
    installPrelude(vm);
    installClock(vm, req.clock);
    const out = evaluate(vm, req.code);
    const ms = Math.round(performance.now() - started);
    if (out.ok) {
      // NOTE: Rendering runs interpreter code too, on its own short deadline: a snippet that spent its
      // whole budget building the value would otherwise have its result interrupted mid-render and
      // come back as "[object Object]" (measured, and fenced by test).
      renewDeadline();
      const value = clip(render(out.value), req.maxChars);
      out.value.dispose();
      return { kind: "value", value, logs, ms };
    }
    const e = out.error as { name?: unknown; message?: unknown } | null;
    // NOTE: The name is the snippet's too (`e.name = "x".repeat(1e6)` is one assignment), so it is
    // bounded like the message; a real error name is an identifier.
    const name = clip(
      typeof e?.name === "string" ? e.name : "Error",
      ERROR_NAME_MAX_CHARS,
    );
    const message =
      typeof e?.message === "string"
        ? e.message
        : e === null || typeof e !== "object"
          ? String(e)
          : JSON.stringify(e);
    unwound = out.unwound === true;
    return {
      kind: "error",
      name,
      message: clip(message, req.maxChars),
      logs,
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
