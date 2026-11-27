// The operator's turn-review rules, matched against a reply OFF the server's event loop, the way an
// attribute's `regex_pattern` is (src/modules/chatwoot/attribute-pattern.ts). The pattern is operator
// text and the reply is the model's, so a backtracking pattern would otherwise stall every tenant's
// requests for as long as it runs, and no deadline can interrupt a synchronous `test`. One thread per
// review tests the rules in order under one time budget. Past it the thread is terminated and the
// answer names the rule that was running.
import { SandboxQueue } from "@/graph/tools/code-sandbox";
import { TURN_RULE_FLAGS } from "./settings";

export interface TurnRulesRequest {
  patterns: string[];
  flags: string;
  text: string;
}

export type TurnRulesProgress =
  | { testing: number }
  | { match: number }
  | { failed: number };

// `match`, `timeout` and `error` carry the index of the pattern in the list given. A timeout with
// index -1 means the thread never started or failed before testing anything. `error` is the engine
// refusing to run a pattern that compiles: like a timeout, the reply was not checked.
export type TurnRulesVerdict =
  | { kind: "match"; index: number }
  | { kind: "none" }
  | { kind: "timeout"; index: number }
  | { kind: "error"; index: number }
  // The turn ended while this review waited for a thread: nothing was tested, and nobody reads it.
  | { kind: "aborted" };

// The budget of one review, all rules together. A pattern a person can reasonably write answers in
// well under a millisecond. The rest is the thread starting. The reply is matched whole, however
// long: a verdict about a prefix would be a verdict about a text the customer does not receive, and
// the budget is what bounds the work.
export const TURN_RULES_TIMEOUT_MS = 1_000;

const WORKER_URL = new URL("./turn-rules.worker.ts", import.meta.url).href;

// How many reviews match at once in this process. Each one is a thread, and many conversations
// finishing together would otherwise start as many: the ones past this wait, with no thread and no
// timer running, so the budget counts the matching and not the wait for a turn.
export const TURN_RULES_MAX_CONCURRENCY = 4;
const defaultQueue = new SandboxQueue(TURN_RULES_MAX_CONCURRENCY);

// The first pattern, in order, that matches `text`.
export async function firstTurnRuleMatch(
  patterns: readonly string[],
  text: string,
  opts: {
    timeoutMs?: number;
    workerUrl?: string;
    queue?: SandboxQueue;
    // The turn's own signal: a turn that ends while waiting for a thread starts none.
    signal?: AbortSignal;
  } = {},
): Promise<TurnRulesVerdict> {
  if (patterns.length === 0) return { kind: "none" };
  const queue = opts.queue ?? defaultQueue;
  const { signal } = opts;
  if (signal?.aborted) return { kind: "aborted" };
  const slot = queue.acquire();
  let left: (() => void) | undefined;
  const gone = new Promise<"gone">((resolve) => {
    left = () => resolve("gone");
    signal?.addEventListener("abort", left, { once: true });
  });
  const first = await Promise.race([slot.then(() => "slot" as const), gone]);
  if (left) signal?.removeEventListener("abort", left);
  if (first === "gone") {
    // The slot still arrives, to nobody: handed straight back, so the queue loses no permit.
    void slot.then(() => queue.release());
    return { kind: "aborted" };
  }
  try {
    return await matchInThread(patterns, text, opts);
  } finally {
    queue.release();
  }
}

function matchInThread(
  patterns: readonly string[],
  text: string,
  opts: { timeoutMs?: number; workerUrl?: string },
): Promise<TurnRulesVerdict> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(opts.workerUrl ?? WORKER_URL);
    } catch {
      // NOTE: no thread, no check: reported as a review that could not run, never as clean.
      resolve({ kind: "timeout", index: -1 });
      return;
    }
    let settled = false;
    let testing = -1;
    const finish = (verdict: TurnRulesVerdict) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      worker.terminate();
      resolve(verdict);
    };
    const killer = setTimeout(
      () => finish({ kind: "timeout", index: testing }),
      opts.timeoutMs ?? TURN_RULES_TIMEOUT_MS,
    );
    worker.onmessage = (ev: MessageEvent<TurnRulesProgress>) => {
      if ("testing" in ev.data) {
        testing = ev.data.testing;
        return;
      }
      if ("failed" in ev.data) {
        finish({ kind: "error", index: ev.data.failed });
        return;
      }
      finish(
        ev.data.match >= 0
          ? { kind: "match", index: ev.data.match }
          : { kind: "none" },
      );
    };
    worker.onerror = () => finish({ kind: "timeout", index: testing });
    worker.postMessage({
      patterns: [...patterns],
      flags: TURN_RULE_FLAGS,
      text,
    } satisfies TurnRulesRequest);
  });
}
