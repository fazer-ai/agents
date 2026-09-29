import { clipText } from "@/lib/text";
import {
  clipToModelLimit,
  MODEL_RESPONSE_CHAR_LIMIT,
} from "@/modules/tool-definitions/response-template";
import type { SandboxReply, SandboxRequest } from "./code-sandbox.worker";
import {
  SANDBOX_MEMORY_BYTES,
  SANDBOX_STACK_BYTES,
  SANDBOX_TIMEOUT_MS,
} from "./code-sandbox-limits";
import {
  resolveTimezone,
  wallClock,
  zoneFormatter,
  zoneOffsetMinutes,
} from "./zone-offset";

// Runs the body of an operator-authored code tool (tools/code.ts) where it can compute and decide,
// and cannot reach anything else. Each call gets its own thread (code-sandbox.worker.ts) and a fresh
// interpreter: a runaway snippet never stalls the process (the deadline is a poll, and the main
// thread holds the Chatwoot webhook's ack budget), an interpreter crash kills only that thread, and
// `terminate()` is a hard stop. The stack limit must be hit by the engine before the thread's native
// stack runs out (JSC throws a RangeError through the WASM frames past ~2,400 frames), hence 256
// KiB. Design and limits: docs/graph.md, the `src/graph/tools/code.ts` entry.

export {
  CODE_TOOL_CONTEXT_MAX_CHARS,
  CODE_TOOL_INPUT_MAX_CHARS,
  SANDBOX_CODE_MAX_CHARS,
  SANDBOX_MEMORY_BYTES,
  SANDBOX_STACK_BYTES,
  SANDBOX_TIMEOUT_MS,
} from "./code-sandbox-limits";
// How many sandbox threads may run at once, process-wide. Uncapped, parallel tool calls and parallel
// turns each spawn a thread on arrival, and a burst exhausts memory and starves threads of boot time
// before the kill timer. Calls past the cap wait, and their deadline starts once they run.
export const SANDBOX_MAX_CONCURRENCY = 8;
// Boot (module load, a few ms) plus the deadline plus slack for a loaded machine, after
// which the thread is killed whether or not the interrupt ever fired.
const HARD_KILL_GRACE_MS = 1500;

export type SandboxOutcome =
  // The code finished; `value` is the rendered return value (JSON where possible).
  | { kind: "value"; value: string; logs: string[]; ms: number }
  // The code threw, or did not parse. The code's own fault, reported as such.
  | { kind: "error"; name: string; message: string; logs: string[]; ms: number }
  // A limit stopped it. `aborted` is the interpreter giving up in a way its own error path did not
  // catch (the thread died); the code is still the cause.
  | {
      kind: "limit";
      limit: "time" | "memory" | "stack" | "aborted";
      logs: string[];
    }
  // The sandbox itself could not start — the thread died before it ever said it was ready — or
  // the interpreter could not be set up for the request (a runtime, a context, a prelude failing
  // before the code ran). This is the one outcome that is ours and not the code's.
  | { kind: "unavailable"; reason: string };

export interface SandboxOptions {
  timeoutMs?: number;
  memoryBytes?: number;
  stackBytes?: number;
  maxChars?: number;
  // The agent's clock, exposed inside as `TIMEZONE` and `NOW_LOCAL`. Absent ⇒ UTC, now.
  clock?: { timezone: string; now?: Date };
  // A code tool's call: the body runs as `function (input, context)` and answers with `return`.
  // Both cross the thread boundary as JSON text (`undefined` becomes `null`). Absent, the source
  // runs as a bare script whose completion value is the result — the engine tests' harness.
  call?: { input: unknown; context: unknown };
}

export interface SandboxDeps {
  // The thread's entry, overridable so a test can stand in a thread that never boots or never
  // answers; the default is the real worker beside this file.
  workerUrl?: string;
  // The concurrency gate, overridable so a test can prove the cap with a small one.
  queue?: SandboxQueue;
}

// A counting semaphore: `acquire` resolves at once while fewer than `limit` calls hold it, and in
// arrival order after that. Nothing about a waiting call runs — no thread, no timer — so a burst of
// calls costs memory only for the ones actually executing.
export class SandboxQueue {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(readonly limit: number) {}
  get active(): number {
    return this.running;
  }
  get queued(): number {
    return this.waiting.length;
  }
  acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiting.push(() => {
        this.running += 1;
        resolve();
      });
    });
  }
  release(): void {
    this.running -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const defaultQueue = new SandboxQueue(SANDBOX_MAX_CONCURRENCY);

// The current instant written in `timezone` with its UTC offset, e.g. `2026-09-02T19:05:33.412-03:00`:
// a string whose first ten characters are the local date and which `new Date()` parses back to
// the same instant. Computed HERE because the interpreter has no Intl. An unknown zone falls back
// to UTC rather than to nothing, so the snippet always has a clock.
export function localIsoNow(timezone: string, now: Date = new Date()): string {
  const fmt = zoneFormatter(resolveTimezone(timezone));
  const w = wallClock(fmt, now.getTime());
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  // With the milliseconds, so `new Date(NOW_LOCAL)` is the instant itself, as the tool
  // description promises, rather than up to 999 ms before it.
  const ms = now.getTime() - Math.floor(now.getTime() / 1000) * 1000;
  // The expanded ISO 8601 year outside 0000 to 9999, the spelling `new Date` reads back.
  const year =
    w.year >= 0 && w.year <= 9999
      ? pad(w.year, 4)
      : `${w.year < 0 ? "-" : "+"}${pad(Math.abs(w.year), 6)}`;
  const wall = `${year}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${pad(ms, 3)}`;
  const offsetMinutes = zoneOffsetMinutes(fmt, now.getTime());
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return `${wall}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const WORKER_URL = new URL("./code-sandbox.worker.ts", import.meta.url).href;

export async function runSandboxedCode(
  code: string,
  opts: SandboxOptions = {},
  deps: SandboxDeps = {},
): Promise<SandboxOutcome> {
  const queue = deps.queue ?? defaultQueue;
  await queue.acquire();
  try {
    return await spawnAndRun(code, opts, deps);
  } finally {
    queue.release();
  }
}

function spawnAndRun(
  code: string,
  opts: SandboxOptions,
  deps: SandboxDeps,
): Promise<SandboxOutcome> {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const timezone = resolveTimezone(opts.clock?.timezone ?? "UTC");
  const request: SandboxRequest = {
    code,
    timeoutMs,
    memoryBytes: opts.memoryBytes ?? SANDBOX_MEMORY_BYTES,
    stackBytes: opts.stackBytes ?? SANDBOX_STACK_BYTES,
    maxChars: opts.maxChars ?? MODEL_RESPONSE_CHAR_LIMIT,
    clock: { timezone, nowLocal: localIsoNow(timezone, opts.clock?.now) },
    ...(opts.call
      ? {
          call: {
            input: asJsonText(opts.call.input),
            context: asJsonText(opts.call.context),
          },
        }
      : {}),
  };
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(deps.workerUrl ?? WORKER_URL);
    } catch (e) {
      resolve({ kind: "unavailable", reason: describe(e) });
      return;
    }
    let ready = false;
    let settled = false;
    const finish = (outcome: SandboxOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      worker.terminate();
      resolve(outcome);
    };
    const killer = setTimeout(
      () =>
        finish(
          ready
            ? { kind: "limit", limit: "time", logs: [] }
            : {
                kind: "unavailable",
                reason: "the sandbox thread did not start",
              },
        ),
      timeoutMs + HARD_KILL_GRACE_MS,
    );
    worker.onmessage = (ev: MessageEvent<SandboxReply>) => {
      const reply = ev.data;
      if (reply.kind === "ready") {
        ready = true;
        worker.postMessage(request);
        return;
      }
      // The thread is up and the interpreter could not be set up for the request: ours, like a
      // thread that never booted, and unlike a thread that died on the snippet.
      if (reply.kind === "unavailable") {
        finish(reply);
        return;
      }
      if (reply.kind === "value") {
        finish(reply);
        return;
      }
      if (reply.limit) {
        finish({ kind: "limit", limit: reply.limit, logs: reply.logs });
        return;
      }
      const { limit: _none, ...error } = reply;
      finish(error);
    };
    // NOTE: An uncaught error in the thread, or the thread ending without a reply. Before `ready` it is
    // the sandbox failing to boot (a missing WASM file, a broken install): ours. After, it is the
    // interpreter dying on the snippet: the snippet's.
    worker.onerror = (ev) =>
      finish(
        ready
          ? { kind: "limit", limit: "aborted", logs: [] }
          : { kind: "unavailable", reason: describe(ev) },
      );
    worker.addEventListener("close", () =>
      finish(
        ready
          ? { kind: "limit", limit: "aborted", logs: [] }
          : {
              kind: "unavailable",
              reason: "the sandbox thread exited before starting",
            },
      ),
    );
  });
}

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string" && m) return m;
  }
  return String(e);
}

// JSON text for the thread, with the two values JSON.stringify has no text for folded into `null`:
// a stringify that answered `undefined` would post the string "undefined" and `JSON.parse` inside
// would throw on the operator's behalf.
function asJsonText(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value) ?? "null";
}

// The text the model reads for a value, and the text the operator reads for a failure. A value
// puts the output first and `Result:` last, where the model reads it; a failure puts the reason
// FIRST, because the flow log keeps a failure's first line as its cause. The result or reason is
// never cut: the output block gets whatever budget the main line leaves, so a flood of
// `console.log` cannot push `Result:` off the end, as a single clip over the whole text would.
export function formatSandboxResult(
  out: Exclude<SandboxOutcome, { kind: "unavailable" }>,
  opts: { timeoutMs?: number; memoryBytes?: number; maxChars?: number } = {},
): string {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const memoryMb = Math.round(
    (opts.memoryBytes ?? SANDBOX_MEMORY_BYTES) / (1024 * 1024),
  );
  const maxChars = opts.maxChars ?? MODEL_RESPONSE_CHAR_LIMIT;
  let main: string;
  switch (out.kind) {
    case "value":
      main = `Result: ${clipToModelLimit(out.value, maxChars).text}`;
      break;
    case "error":
      main = `Error: ${clipText(out.name, 100)}: ${clipToModelLimit(out.message, maxChars).text}`;
      break;
    case "limit":
      switch (out.limit) {
        case "time":
          main = `Execution stopped after ${timeoutMs} ms without finishing.`;
          break;
        case "memory":
          main = `Execution exceeded the ${memoryMb} MB memory limit.`;
          break;
        case "stack":
          main = "Execution overflowed the call stack (too much recursion).";
          break;
        case "aborted":
          main = "Execution was aborted before finishing.";
          break;
      }
  }
  if (out.logs.length === 0) return main;
  const joined = out.logs.join("\n");
  const frame = "Output:\n\n\n".length + OUTPUT_TRUNCATED.length;
  const budget = maxChars - main.length - frame;
  if (budget < 40) return main;
  const body =
    joined.length <= budget
      ? joined
      : `${clipText(joined, budget)}${OUTPUT_TRUNCATED}`;
  return out.kind === "value"
    ? `Output:\n${body}\n\n${main}`
    : `${main}\n\nOutput:\n${body}`;
}

const OUTPUT_TRUNCATED = "…[output truncated]";
