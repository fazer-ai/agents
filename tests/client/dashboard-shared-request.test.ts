import { describe, expect, test } from "bun:test";
import { sharedRequest } from "@/client/pages/dashboard/useBlock";

// Two blocks asking the same thing at once share one request; once it settles, the next ask (a
// reload, a retry) goes to the API again instead of reading the old answer. The sharing lives in
// the map of one page, so another page (a login after a logout in the same tab) never reads it.

describe("sharedRequest", () => {
  test("a request in flight is shared, a settled one is asked again", async () => {
    const page = new Map<string, Promise<unknown>>();
    let sent = 0;
    const ask = () =>
      sharedRequest(page, "k", async () => {
        sent += 1;
        return sent;
      });
    const [a, b] = await Promise.all([ask(), ask()]);
    expect([a, b, sent]).toEqual([1, 1, 1]);
    expect(await ask()).toBe(2);
  });

  test("a failed request is asked again too", async () => {
    const page = new Map<string, Promise<unknown>>();
    let sent = 0;
    const ask = () =>
      sharedRequest(page, "f", async () => {
        sent += 1;
        if (sent === 1) throw new Error("down");
        return sent;
      });
    await expect(ask()).rejects.toThrow("down");
    expect(await ask()).toBe(2);
  });

  test("a request another page left in flight answers nothing here", async () => {
    let release: (v: string) => void = () => {};
    const before = new Map<string, Promise<unknown>>();
    const pending = sharedRequest(
      before,
      "k",
      () => new Promise<string>((r) => (release = r)),
    );
    const after = new Map<string, Promise<unknown>>();
    const mine = await sharedRequest(after, "k", async () => "this session");
    release("previous session");
    expect([mine, await pending]).toEqual(["this session", "previous session"]);
  });
});
