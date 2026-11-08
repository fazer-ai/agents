// The real sandbox thread on a clock that moves one tick per read instead of with the wall. Every
// deadline the engine sets and every interrupt poll it makes advances time by exactly TICK_MS, so
// how much of a budget a snippet spends is a count of the engine's own polls: the same on any
// machine, at any load.
import { serve } from "@/graph/tools/code-sandbox.worker";

const TICK_MS = 20;

let t = 0;
serve(() => {
  t += TICK_MS;
  return t;
});
