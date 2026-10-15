import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import config from "@/config";
import { type PermitWaitInfo, runModelCall } from "@/graph/model-limit";

// A model call that waits for a permit of the process-wide semaphore past the threshold
// says so ONCE, while it is still waiting. Exercises the real singleton: the permits are taken by
// calls that hang until the test lets them go.

const THRESHOLD_MS = 300;

let saved: number | undefined;
beforeEach(() => {
  saved = config.agent.capacityWaitAlertMs;
  config.agent.capacityWaitAlertMs = THRESHOLD_MS;
});

const held: Array<() => void> = [];
afterEach(async () => {
  for (const release of held.splice(0)) release();
  await Bun.sleep(0);
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
  while (started < cap) await Bun.sleep(1);
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
    const seen: PermitWaitInfo[] = [];
    const call = runModelCall(async () => "ok", {
      primary: LABELS,
      onPermitWait: (info) => seen.push(info),
    });
    await Bun.sleep(THRESHOLD_MS / 2);
    expect(seen).toEqual([]);
    await Bun.sleep(THRESHOLD_MS);
    // Reported BEFORE the permit arrived: the operator hears about the wait while it is happening.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.waitedMs).toBeGreaterThanOrEqual(THRESHOLD_MS - 5);
    expect(seen[0]?.thresholdMs).toBe(THRESHOLD_MS);
    // It names the limit that held it, with the semaphore as it stood.
    const cap = config.agent.modelConcurrency;
    expect(seen[0]?.occupancy).toEqual({
      limit: "AGENT_MODEL_CONCURRENCY",
      class: "reply",
      modelInFlight: cap,
      modelPermits: cap,
      modelWaiting: 1,
      modelWaitingReply: 1,
      modelWaitingBackground: 0,
    });
    release();
    expect(await call).toBe("ok");
    await Bun.sleep(THRESHOLD_MS);
    expect(seen).toHaveLength(1);
  });

  test("a permit that arrives before the threshold reports nothing", async () => {
    const release = await holdEveryPermit();
    const seen: unknown[] = [];
    const call = runModelCall(async () => "ok", {
      primary: LABELS,
      onPermitWait: (info) => seen.push(info),
    });
    await Bun.sleep(THRESHOLD_MS / 3);
    release();
    await call;
    await Bun.sleep(THRESHOLD_MS * 1.5);
    expect(seen).toEqual([]);
  });

  test("a call that gets a permit at once reports nothing, however long it runs", async () => {
    const seen: unknown[] = [];
    await runModelCall(() => Bun.sleep(THRESHOLD_MS * 1.5).then(() => "ok"), {
      primary: LABELS,
      onPermitWait: (info) => seen.push(info),
    });
    expect(seen).toEqual([]);
  });

  test("a call that fails after waiting still reported the wait once", async () => {
    const release = await holdEveryPermit();
    const seen: unknown[] = [];
    let ran = 0;
    const boom = new Error("boom");
    const call = runModelCall(
      async () => {
        ran++;
        throw boom;
      },
      { primary: LABELS, onPermitWait: (info) => seen.push(info) },
    ).catch((e: Error) => e);
    await Bun.sleep(THRESHOLD_MS * 1.5);
    release();
    // The call ran once, after the permit, and the caller gets its failure, redacted, with
    // the provider's own error as the cause.
    const err = await call;
    expect([err.message, err.cause]).toEqual(["provider error", boom]);
    expect(ran).toBe(1);
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
    await Bun.sleep(THRESHOLD_MS * 1.5);
    release();
    expect(await call).toBe("ok");
  });
});
