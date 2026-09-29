// ONE DEADLINE FOR EVERY HAND-ROLLED POLL IN THIS SUITE. Files that wait for a row by reading it in a
// loop share this number instead of each guessing how long the work takes on the machine at hand; a
// tight guess lapses under `bun test --parallel` with a failure naming neither the wait nor the file
// (`Expected length: 1, Received length: 0`). WAITING LONGER IS FREE WHEN THE TEST PASSES: each loop
// returns the moment its condition holds, the same reasoning as the two library defaults raised in
// tests/setup.ts, and NOT the reasoning for a window a test's setup must fit inside. KNOWN WEAKNESS:
// these helpers RETURN what they have when the deadline lapses, so a lapse surfaces as an assertion
// about the data; throwing instead needs each caller's `expected` count checked (not all are >= 1).
export const POLL_DEADLINE_MS = 15_000;
