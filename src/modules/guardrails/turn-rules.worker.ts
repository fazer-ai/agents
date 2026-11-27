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
    try {
      if (new RegExp(source, flags).test(text)) {
        match = index;
        break;
      }
    } catch {
      // A pattern that does not compile matches nothing: the reader already dropped those.
    }
  }
  self.postMessage({ match } satisfies TurnRulesProgress);
};
