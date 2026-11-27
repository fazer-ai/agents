// The operator's turn-review rules, matched against a reply OFF the server's event loop, the way an
// attribute's `regex_pattern` is (src/modules/chatwoot/attribute-pattern.ts). The pattern is operator
// text and the reply is the model's, so a backtracking pattern would otherwise stall every tenant's
// requests for as long as it runs, and no deadline can interrupt a synchronous `test`. One thread per
// review tests the rules in order under one time budget. Past it the thread is terminated and the
// answer names the rule that was running.
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
  | { kind: "error"; index: number };

// The budget of one review, all rules together. A pattern a person can reasonably write answers in
// well under a millisecond. The rest is the thread starting. The reply is matched whole, however
// long: a verdict about a prefix would be a verdict about a text the customer does not receive, and
// the budget is what bounds the work.
export const TURN_RULES_TIMEOUT_MS = 1_000;

const WORKER_URL = new URL("./turn-rules.worker.ts", import.meta.url).href;

// The first pattern, in order, that matches `text`.
export function firstTurnRuleMatch(
  patterns: readonly string[],
  text: string,
  opts: { timeoutMs?: number; workerUrl?: string } = {},
): Promise<TurnRulesVerdict> {
  if (patterns.length === 0) return Promise.resolve({ kind: "none" });
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
