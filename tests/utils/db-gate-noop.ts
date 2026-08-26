import { expect, test } from "bun:test";

// A test file with nothing in it, on purpose. It is the target of the subprocess runs in
// tests/lib/db-gate.test.ts, which are about what the PRELOAD does before any test file is
// loaded: when the gate refuses, this never executes and the run exits non-zero; when the
// opt-out disarms the gate, this is what proves the run got as far as executing a test.
test("the suite reached a test file", () => {
  expect(true).toBe(true);
});
