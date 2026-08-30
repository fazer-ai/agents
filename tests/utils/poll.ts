// ONE DEADLINE FOR EVERY HAND-ROLLED POLL IN THIS SUITE.
//
// Ten files wait for a row to appear by reading it in a loop until a deadline, and before this
// constant each had picked its own: 2000, 2000, 2000, 3000, 3000, 3000, 3000, 4000, 10_000. Not one
// of those numbers was argued for anywhere. They are all the same guess, made nine times, about how
// long the work under test takes on the machine that happened to be running it.
//
// The guess holds while the suite has the machine to itself and stops holding under
// `bun test --parallel`, where everything runs some multiple slower. Measured at 24 workers on an
// 18-core machine: `deadRows(1)` in tests/modules/terminal-failure-announces.test.ts exhausted its
// 4000ms and returned nothing, twice in six runs, and the failure it produced named neither the wait
// nor the file — `Expected length: 1, Received length: 0`, which reads as a feature that stopped
// writing its dead-letter line.
//
// WAITING LONGER IS FREE WHEN THE TEST PASSES: every one of these loops returns the moment its
// condition holds, so the deadline is only ever reached on a run that was going to fail anyway. That
// is what makes one generous number better than nine tight ones, and it is the same reasoning as the
// two library defaults raised in tests/setup.ts. It is NOT the reasoning for a window a test's setup
// has to fit inside; those are paid in full every run and are sized where they live.
//
// KNOWN WEAKNESS, deliberately left: these helpers RETURN what they have when the deadline lapses,
// rather than throwing. So a lapse still surfaces as an assertion about the data instead of one about
// the wait, and the reader has to know to look here. Making them throw means touching twelve call
// sites whose `expected` counts are not all "at least one" (a poll for zero returns immediately by
// construction), so it is a separate change from this one.
export const POLL_DEADLINE_MS = 15_000;
