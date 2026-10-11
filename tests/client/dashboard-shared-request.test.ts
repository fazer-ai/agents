import { describe, expect, test } from "bun:test";
import { sharedRequest } from "@/client/pages/dashboard/useBlock";

// Two blocks asking the same thing at once share one request; once it settles, the next ask (a
// reload, a retry) goes to the API again instead of reading the old answer.

describe("sharedRequest", () => {
  test("a request in flight is shared, a settled one is asked again", async () => {
    let sent = 0;
    const ask = () =>
      sharedRequest("k", async () => {
        sent += 1;
        return sent;
      });
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a, b, sent]).toEqual([1, 1, 1]);
    expect(await ask()).toBe(2);
  });

  test("a failed request is asked again too", async () => {
    let sent = 0;
    const ask = () =>
      sharedRequest("f", async () => {
        sent += 1;
        if (sent === 1) throw new Error("down");
        return sent;
      });
    await expect(ask()).rejects.toThrow("down");
    expect(await ask()).toBe(2);
  });
});
