import { describe, expect, test } from "bun:test";
import { until } from "@/tests/utils/poll";

describe("until", () => {
  test("returns the first truthy value, as soon as it appears", async () => {
    let calls = 0;
    const got = await until(
      "the third call",
      () => (++calls === 3 ? { calls } : null),
      { everyMs: 1 },
    );
    expect(got).toEqual({ calls: 3 });
  });

  test("throws naming the condition when the deadline lapses", async () => {
    await expect(
      until("a row that never lands", () => false, {
        everyMs: 1,
        deadlineMs: 20,
      }),
    ).rejects.toThrow("gave up waiting for a row that never lands after 20ms");
  });
});
