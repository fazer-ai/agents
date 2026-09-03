import { clipText } from "@/lib/text";
import {
  clipToModelLimit,
  MODEL_RESPONSE_CHAR_LIMIT,
} from "@/modules/tool-definitions/response-template";
import type { SandboxReply, SandboxRequest } from "./code-sandbox.worker";
import {
  resolveTimezone,
  wallClock,
  zoneFormatter,
  zoneOffsetMinutes,
} from "./zone-offset";

// Runs a model-authored JavaScript snippet where it can compute and decide, and cannot reach
// anything else (issue #363). The tool exists because a verdict left to the model is periodically
// wrong even when every number it holds is right: the CPF case that opened the issue had the two
// check digits computed correctly by `calculator` on every run and the model still answering "does
// not match". Code that RETURNS the verdict leaves nothing to compare.
//
// Each call gets its own thread (code-sandbox.worker.ts) and the thread gets a fresh interpreter,
// which costs 13–16 ms measured end to end and buys three things the in-thread design could not:
//
//   - A runaway snippet never stalls the process. The interpreter's deadline is a poll, and until
//     it fires the CPU is busy; on the main thread that is the Chatwoot webhook's 5 s ack budget
//     shared with every other tenant's turn. Measured with `while(true){}` in flight: a 50 ms timer
//     on the main thread fired at 51 ms.
//   - The interpreter's own failure is contained. With the stack ceiling set high enough, a runaway
//     recursion overflowed the HOST stack before QuickJS could refuse it — a RangeError thrown out
//     of WASM, and an assertion abort on the next dispose. In a thread that is a dead thread; in the
//     process it is a corrupted module shared by every later call.
//   - `terminate()` is a hard stop that does not depend on the interrupt being polled.
//
// The limits below are the measured safe values. The stack budget is the one the ENGINE must reach
// before the thread's native stack does: the interrupt handler is a JS callback fired from inside
// the WASM frames every 10k opcodes, and JSC refuses to enter it past a depth (~2,400 interpreter
// frames on macOS) by throwing a RangeError through those frames. At 512 KiB the engine's own limit
// sat past that depth, and the runaway-recursion test only passed when no interrupt happened to
// fire deep — fewer than ~1,200 opcodes before the recursion; with more, `aborted`. At 448 KiB the
// engine came first; 256 KiB (~1,340 honest frames) leaves half the measured room, and the worker
// still maps the host's RangeError to the stack limit for a thread with less. The CPU deadline is
// polled and lands within a few ms of the figure.

export const SANDBOX_TIMEOUT_MS = 1000;
export const SANDBOX_MEMORY_BYTES = 32 * 1024 * 1024;
export const SANDBOX_STACK_BYTES = 256 * 1024;
// The snippet itself: a model does not write more than a few hundred lines in one call, and the
// bound keeps a runaway generation from being handed to a thread as a megabyte of source.
export const SANDBOX_CODE_MAX_CHARS = 20_000;
// How many sandbox threads may run at once, process-wide. Without a cap every call spawns its own
// thread the moment it arrives — a ToolNode runs a turn's calls in parallel, and turns run in
// parallel — and the ceiling is the machine's, not ours. Measured with 50 at once on an 18-core
// machine: RSS 15 → 2,485 MB across three batches, and 4 of the 50 busy ones reported "unavailable"
// because their thread had not even booted when the kill timer fired. n8n's task runner caps the
// same thing at 10 per runner (N8N_RUNNERS_MAX_CONCURRENCY). Calls past the cap wait their turn,
// and the deadline only starts once they have it. The same 50-at-once through this gate: RSS
// peaked at 571 MB, and all 50 came back with their real outcome.
export const SANDBOX_MAX_CONCURRENCY = 8;
// Boot (module load, ~6 ms measured) plus the deadline plus slack for a loaded machine, after
// which the thread is killed whether or not the interrupt ever fired.
const HARD_KILL_GRACE_MS = 1500;

export type SandboxOutcome =
  // The snippet finished; `value` is the rendered completion value (JSON where possible).
  | { kind: "value"; value: string; logs: string[]; ms: number }
  // The snippet threw, or did not parse. Its own fault, reported as such.
  | { kind: "error"; name: string; message: string; logs: string[]; ms: number }
  // A limit stopped it. `aborted` is the interpreter giving up in a way its own error path did not
  // catch (the thread died); the snippet is still the cause.
  | {
      kind: "limit";
      limit: "time" | "memory" | "stack" | "aborted";
      logs: string[];
    }
  // The sandbox itself could not start: the thread died before it ever said it was ready. This is
  // the one outcome that is ours and not the snippet's, and the tool reports it as a failure.
  | { kind: "unavailable"; reason: string };

export interface SandboxOptions {
  timeoutMs?: number;
  memoryBytes?: number;
  stackBytes?: number;
  maxChars?: number;
  // The agent's clock, exposed inside as `TIMEZONE` and `NOW_LOCAL`. Absent ⇒ UTC, now.
  clock?: { timezone: string; now?: Date };
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
  // NOTE: With the milliseconds: without them, `new Date(NOW_LOCAL)` was up to 999 ms before the
  // instant it was written from, and the description promises the instant (PR #485, round 11).
  const ms = now.getTime() - Math.floor(now.getTime() / 1000) * 1000;
  const wall = `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${pad(ms, 3)}`;
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

// The text the model reads. Output first (it was produced first), the result or the reason last,
// and every branch says what to do next in one clause, because the model calls again on what it
// reads here and a bare "interrupted" gives it nothing to change.
//
// The tail is what the tool exists to deliver, so it is never the part that gets cut: the output
// block is given whatever budget the tail leaves, and clipped on its own. A single head-first clip
// over the whole text (the first version of this) let 4,000 characters of `console.log` push the
// `Result:` line — or the error and its retry instruction — off the end (PR #485, round 1).
export function formatSandboxResult(
  out: Exclude<SandboxOutcome, { kind: "unavailable" }>,
  opts: { timeoutMs?: number; memoryBytes?: number; maxChars?: number } = {},
): string {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const memoryMb = Math.round(
    (opts.memoryBytes ?? SANDBOX_MEMORY_BYTES) / (1024 * 1024),
  );
  const maxChars = opts.maxChars ?? MODEL_RESPONSE_CHAR_LIMIT;
  let tail: string;
  switch (out.kind) {
    case "value":
      tail = `Result: ${clipToModelLimit(out.value, maxChars).text}`;
      break;
    case "error":
      tail = `Error: ${clipText(out.name, 100)}: ${clipToModelLimit(out.message, maxChars).text}\nThe code did not finish. Fix it and call run_code again.`;
      break;
    case "limit":
      switch (out.limit) {
        case "time":
          tail = `Execution stopped after ${timeoutMs} ms without finishing. Do less work per call (smaller loops, no busy-waiting) and call run_code again.`;
          break;
        case "memory":
          tail = `Execution exceeded the ${memoryMb} MB memory limit. Build smaller structures and call run_code again.`;
          break;
        case "stack":
          tail =
            "Execution overflowed the call stack (too much recursion). Rewrite it iteratively and call run_code again.";
          break;
        case "aborted":
          tail =
            "Execution was aborted before finishing. Simplify the code and call run_code again.";
          break;
      }
  }
  if (out.logs.length === 0) return tail;
  const joined = out.logs.join("\n");
  const frame = "Output:\n\n\n".length + OUTPUT_TRUNCATED.length;
  const budget = maxChars - tail.length - frame;
  if (budget < 40) return tail;
  const body =
    joined.length <= budget
      ? joined
      : `${clipText(joined, budget)}${OUTPUT_TRUNCATED}`;
  return `Output:\n${body}\n\n${tail}`;
}

const OUTPUT_TRUNCATED = "…[output truncated]";
