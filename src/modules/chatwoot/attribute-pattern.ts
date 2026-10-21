// An attribute definition's `regex_pattern`, read and tested the way the dashboard does, OFF the
// server's event loop. The pattern is operator text and the value is the model's, so a backtracking
// pattern (`/^(a+)+$/` on thirty-odd characters) would otherwise stall every tenant's requests for as
// long as it runs, and no deadline can interrupt a synchronous `test`. Each check runs in its own
// thread with a time budget; a check that outlives it answers `timeout` and the thread is terminated.

export interface PatternRequest {
  source: string;
  flags: string;
  value: string;
}

export type PatternVerdict = "match" | "no_match" | "timeout";

// The budget of one check. A pattern a person can reasonably write answers in well under a
// millisecond; the rest is the thread starting.
export const PATTERN_TIMEOUT_MS = 1_000;

const WORKER_URL = new URL("./attribute-pattern.worker.ts", import.meta.url)
  .href;

// Chatwoot keeps the pattern as the dashboard wrote it, `/source/flags` (normalizeRegexPattern in the
// fork's Validators.js), and older rows hold the bare source. `g` and `y` are dropped: they make
// `test` stateful, and a rule must answer the same for the same value. Null when it does not compile,
// which the caller treats as a refusal, as the dashboard does. Compiling is linear in the pattern, so
// it is safe here; only the TEST is isolated.
export function parseAttributePattern(
  pattern: string,
): { source: string; flags: string } | null {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(pattern);
  const source = m ? (m[1] ?? "") : pattern;
  const flags = (m?.[2] ?? "").replace(/[gy]/g, "");
  try {
    new RegExp(source, flags);
  } catch {
    return null;
  }
  return { source, flags };
}

export function testAttributePattern(
  pattern: string,
  value: string,
  opts: { timeoutMs?: number; workerUrl?: string } = {},
): Promise<PatternVerdict> {
  const parsed = parseAttributePattern(pattern);
  if (!parsed) return Promise.resolve("no_match");
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(opts.workerUrl ?? WORKER_URL);
    } catch {
      // NOTE: no thread, no check: refused, since a value that was never tested is not accepted.
      resolve("timeout");
      return;
    }
    let settled = false;
    const finish = (verdict: PatternVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      worker.terminate();
      resolve(verdict);
    };
    const killer = setTimeout(
      () => finish("timeout"),
      opts.timeoutMs ?? PATTERN_TIMEOUT_MS,
    );
    worker.onmessage = (ev: MessageEvent<{ match: boolean }>) =>
      finish(ev.data.match ? "match" : "no_match");
    worker.onerror = () => finish("timeout");
    worker.postMessage({ ...parsed, value } satisfies PatternRequest);
  });
}
