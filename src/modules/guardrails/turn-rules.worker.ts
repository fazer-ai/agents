// The thread that tests ONE reply against the operator's turn-review rules and answers, spawned per
// review by turn-rules.ts. A backtracking pattern can run for seconds on a short reply, and a regex
// cannot be interrupted from inside its own thread: here the host terminates the thread instead. It
// says which pattern it is about to test, so a timeout names the rule that ran out of time.
import type { TurnRulesProgress, TurnRulesRequest } from "./turn-rules";

declare var self: Worker;

self.onmessage = (ev: MessageEvent<TurnRulesRequest>) => {
  const { patterns, flags, text } = ev.data;
  let match = -1;
  for (const [index, source] of patterns.entries()) {
    self.postMessage({ testing: index } satisfies TurnRulesProgress);
    let pattern: RegExp;
    try {
      pattern = new RegExp(source, flags);
    } catch {
      // A pattern that does not compile matches nothing: the reader already dropped those.
      continue;
    }
    try {
      if (pattern.test(text)) {
        match = index;
        break;
      }
    } catch {
      // The engine gave up on a pattern that compiles: the reply was not checked against this
      // rule, which is not the same as not matching it.
      self.postMessage({ failed: index } satisfies TurnRulesProgress);
      return;
    }
  }
  self.postMessage({ match } satisfies TurnRulesProgress);
};
