import { describe, expect, test } from "bun:test";
import { withDeadline } from "@/modules/voice-call/providers/tool-deadline";

describe("a tool run past its deadline", () => {
  test("is cut before the call hears it timed out, so it sends nothing after that answer", async () => {
    let handed: AbortSignal | undefined;
    const outcome = await withDeadline((signal) => {
      handed = signal;
      return new Promise<string>(() => {});
    }, 5).catch((err: Error) => ({
      message: err.message,
      cutFirst: handed?.aborted === true,
    }));
    expect(outcome).toEqual({
      message: "tool timed out after 5 ms",
      cutFirst: true,
    });
  });

  test("one that answers in time is not cut", async () => {
    let handed: AbortSignal | undefined;
    expect(
      await withDeadline(async (signal) => {
        handed = signal;
        return "ok";
      }, 1_000),
    ).toBe("ok");
    expect(handed?.aborted).toBe(false);
  });
});

describe("a tool still running when the call ends", () => {
  test("is cut, and answers that the call ended", async () => {
    const session = new AbortController();
    let handed: AbortSignal | undefined;
    const running = withDeadline(
      (signal) => {
        handed = signal;
        return new Promise<string>(() => {});
      },
      60_000,
      session.signal,
    );
    session.abort();
    await expect(running).rejects.toThrow(
      "the call ended before the tool answered",
    );
    expect(handed?.aborted).toBe(true);
  });

  test("asked for after the call ended does not run, even one that would answer at once", async () => {
    let ran = false;
    await expect(
      withDeadline(
        async () => {
          ran = true;
          return "ok";
        },
        60_000,
        AbortSignal.abort(),
      ),
    ).rejects.toThrow("the call ended");
    expect(ran).toBe(false);
  });
});
