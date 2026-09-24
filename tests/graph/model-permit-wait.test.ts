import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import config from "@/config";
import { runModelCall } from "@/graph/model-limit";

// Issue #812: a model call that waits for a permit of the process-wide semaphore past the threshold
// says so ONCE, while it is still waiting. Exercises the real singleton: the permits are taken by
// calls that hang until the test lets them go.

const THRESHOLD_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let saved: number | undefined;
beforeEach(() => {
  saved = config.agent.capacityWaitAlertMs;
  config.agent.capacityWaitAlertMs = THRESHOLD_MS;
});

const held: Array<() => void> = [];
afterEach(async () => {
  for (const release of held.splice(0)) release();
  await sleep(0);
  if (saved !== undefined) config.agent.capacityWaitAlertMs = saved;
});

// Takes every permit and keeps them until released. Resolves once all of them are held.
async function holdEveryPermit(): Promise<() => void> {
  const cap = config.agent.modelConcurrency;
  const releases: Array<() => void> = [];
  let started = 0;
  for (let i = 0; i < cap; i++) {
    void runModelCall(
      () =>
        new Promise<void>((resolve) => {
          started++;
          releases.push(resolve);
        }),
    );
  }
  while (started < cap) await sleep(1);
  const release = () => {
    for (const r of releases.splice(0)) r();
  };
  held.push(release);
  return release;
}

const LABELS = { provider: "openai", model: "gpt-test" };

describe("a model call waiting for a permit", () => {
  test("is reported once it has waited past the threshold, while it still waits", async () => {
    const release = await holdEveryPermit();
    const seen: Array<{ waitedMs: number; thresholdMs: number }> = [];
    const call = runModelCall(async () => "ok", {
      primary: LABELS,
      onPermitWait: (info) => seen.push(info),
    });
    await sleep(THRESHOLD_MS / 2);
    expect(seen).toEqual([]);
    await sleep(THRESHOLD_MS);
    // Reported BEFORE the permit arrived: the operator hears about the wait while it is happening.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.waitedMs).toBeGreaterThanOrEqual(THRESHOLD_MS - 5);
    expect(seen[0]?.thresholdMs).toBe(THRESHOLD_MS);
    release();
    expect(await call).toBe("ok");
    await sleep(THRESHOLD_MS);
    expect(seen).toHaveLength(1);
  });

  test("a permit that arrives before the threshold reports nothing", async () => {
    const release = await holdEveryPermit();
    const seen: unknown[] = [];
    const call = runModelCall(async () => "ok", {
      primary: LABELS,
      onPermitWait: (info) => seen.push(info),
    });
    await sleep(THRESHOLD_MS / 3);
    release();
    await call;
    await sleep(THRESHOLD_MS * 1.5);
    expect(seen).toEqual([]);
  });

  test("a call that gets a permit at once reports nothing, however long it runs", async () => {
    const seen: unknown[] = [];
    await runModelCall(() => sleep(THRESHOLD_MS * 1.5).then(() => "ok"), {
      primary: LABELS,
      onPermitWait: (info) => seen.push(info),
    });
    expect(seen).toEqual([]);
  });

  test("a call that fails after waiting still reported the wait once", async () => {
    const release = await holdEveryPermit();
    const seen: unknown[] = [];
    const call = runModelCall(
      async () => {
        throw new Error("boom");
      },
      { primary: LABELS, onPermitWait: (info) => seen.push(info) },
    ).catch((e: Error) => e.message);
    await sleep(THRESHOLD_MS * 1.5);
    release();
    expect(await call).toBeString();
    expect(seen).toHaveLength(1);
  });

  test("a report that throws does not break the call", async () => {
    const release = await holdEveryPermit();
    const call = runModelCall(async () => "ok", {
      primary: LABELS,
      onPermitWait: () => {
        throw new Error("sink down");
      },
    });
    await sleep(THRESHOLD_MS * 1.5);
    release();
    expect(await call).toBe("ok");
  });
});
