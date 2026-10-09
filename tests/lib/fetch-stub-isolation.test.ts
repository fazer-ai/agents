import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// A FETCH STUB A TEST NEVER TOOK BACK. Bun moves on from a timed-out test without waiting for its
// body, so a stub restored in that body's `finally` stays installed, and every file the process runs
// next calls the fake: a cost test then records the token counts of another file's fake answer.
// The first test below stands for that body: it installs a stub and never restores it. The second
// reads what the next test gets, which is what the next file would get.

const before = globalThis.fetch;
const stub = (async () => Response.json({})) as unknown as typeof fetch;

describe("a fetch stub left installed by a test", () => {
  test("a test installs a stub and never takes it back", () => {
    globalThis.fetch = stub;
    expect(globalThis.fetch).toBe(stub);
  });

  test("the next test gets the fetch from before it", () => {
    expect(globalThis.fetch).not.toBe(stub);
    expect(globalThis.fetch).toBe(before);
  });
});

// The other half: a stub a file installs once for all its tests is not a leftover, and every test of
// the file still calls it. Reverting each test to the fetch from before the file would undo it.
describe("a fetch stub a file installs for all its tests", () => {
  const shared = (async () => Response.json({})) as unknown as typeof fetch;
  let outside: typeof fetch;
  beforeAll(() => {
    outside = globalThis.fetch;
    globalThis.fetch = shared;
  });
  afterAll(() => {
    globalThis.fetch = outside;
  });

  test("the first test calls it", () => {
    expect(globalThis.fetch).toBe(shared);
  });

  test("and so does the next", () => {
    expect(globalThis.fetch).toBe(shared);
  });
});
