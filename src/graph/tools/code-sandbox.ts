import {
  clipToModelLimit,
  MODEL_RESPONSE_CHAR_LIMIT,
} from "@/modules/tool-definitions/response-template";
import type { SandboxReply, SandboxRequest } from "./code-sandbox.worker";

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
// The limits below are the measured safe values: 512 KiB of interpreter stack is refused cleanly by
// QuickJS (as "stack overflow") in a worker thread while still allowing ~2000 frames of plain
// recursion; the CPU deadline is polled and lands within a few ms of the figure.

export const SANDBOX_TIMEOUT_MS = 1000;
export const SANDBOX_MEMORY_BYTES = 32 * 1024 * 1024;
export const SANDBOX_STACK_BYTES = 512 * 1024;
// The snippet itself: a model does not write more than a few hundred lines in one call, and the
// bound keeps a runaway generation from being handed to a thread as a megabyte of source.
export const SANDBOX_CODE_MAX_CHARS = 20_000;
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
}

export interface SandboxDeps {
  // The thread's entry, overridable so a test can stand in a thread that never boots or never
  // answers; the default is the real worker beside this file.
  workerUrl?: string;
}

const WORKER_URL = new URL("./code-sandbox.worker.ts", import.meta.url).href;

// The two InternalError messages QuickJS uses for its own limits, mapped to the limit they mean.
// Anything else the snippet raised is the snippet's error, InternalError included.
function limitOf(
  name: string,
  message: string,
): "time" | "memory" | "stack" | null {
  if (name !== "InternalError") return null;
  if (message === "interrupted") return "time";
  if (message === "out of memory") return "memory";
  if (message === "stack overflow") return "stack";
  return null;
}

export function runSandboxedCode(
  code: string,
  opts: SandboxOptions = {},
  deps: SandboxDeps = {},
): Promise<SandboxOutcome> {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const request: SandboxRequest = {
    code,
    timeoutMs,
    memoryBytes: opts.memoryBytes ?? SANDBOX_MEMORY_BYTES,
    stackBytes: opts.stackBytes ?? SANDBOX_STACK_BYTES,
    maxChars: opts.maxChars ?? MODEL_RESPONSE_CHAR_LIMIT,
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
      const limit = limitOf(reply.name, reply.message);
      finish(limit ? { kind: "limit", limit, logs: reply.logs } : reply);
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
export function formatSandboxResult(
  out: Exclude<SandboxOutcome, { kind: "unavailable" }>,
  opts: { timeoutMs?: number; memoryBytes?: number; maxChars?: number } = {},
): string {
  const timeoutMs = opts.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const memoryMb = Math.round(
    (opts.memoryBytes ?? SANDBOX_MEMORY_BYTES) / (1024 * 1024),
  );
  const maxChars = opts.maxChars ?? MODEL_RESPONSE_CHAR_LIMIT;
  const output =
    out.logs.length > 0 ? `Output:\n${out.logs.join("\n")}\n\n` : "";
  let tail: string;
  switch (out.kind) {
    case "value":
      tail = `Result: ${out.value}`;
      break;
    case "error":
      tail = `Error: ${out.name}: ${out.message}\nThe code did not finish. Fix it and call run_code again.`;
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
  return clipToModelLimit(output + tail, maxChars).text;
}
