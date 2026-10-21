// The thread that tests ONE attribute value against an operator's `regex_pattern` and answers, spawned
// per check by attribute-pattern.ts. A backtracking pattern can run for seconds on a short value, and a
// regex cannot be interrupted from inside its own thread: here the host terminates the thread instead.
import type { PatternRequest } from "./attribute-pattern";

declare var self: Worker;

self.onmessage = (ev: MessageEvent<PatternRequest>) => {
  const { source, flags, value } = ev.data;
  let match = false;
  try {
    match = new RegExp(source, flags).test(value);
  } catch {
    match = false;
  }
  self.postMessage({ match });
};
