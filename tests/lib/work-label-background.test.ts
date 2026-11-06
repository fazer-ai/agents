import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { currentWorkLabel } from "@/lib/work-label";
import { runDebounceTick } from "@/modules/debounce/worker";
import { runCompactionTick } from "@/modules/memory/worker";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { runClaimed, runSchedulerTick } from "@/modules/scheduler/worker";

// A statement that times out records the work label it ran under, and the alert and the database
// screen name the work by it (docs/logs.md, "Database"). Work with no request or job around it (a
// scheduler claim, a job's own outcome write, a worker's timer) carries a label of its own, so its
// timeouts never reach the operator as "unlabeled work".

// A client whose every call records the label it was made under, then fails: the first statement a
// pass sends is the one whose label is read.
function recordingBase(seen: (string | null)[]): PrismaClient {
  const stop = () => {
    seen.push(currentWorkLabel());
    throw new Error("stop");
  };
  return new Proxy(
    {},
    {
      get: (_t, prop) => {
        if (prop === "then") return undefined;
        return stop;
      },
    },
  ) as unknown as PrismaClient;
}

describe("background work runs under a work label", () => {
  test("the scheduler tick's own statements (reap, claim) are labeled", async () => {
    const seen: (string | null)[] = [];
    await runSchedulerTick(recordingBase(seen), {
      staleMs: 60_000,
      batchSize: 1,
      // The client refuses every call, so nothing is claimed; the tenant only keeps the drain scoped.
      tenantId: 1n,
    }).catch(() => null);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe("scheduler");
  });

  test("a claimed job's outcome write carries the job's label, not only its handler", async () => {
    const seen: (string | null)[] = [];
    const job = {
      // The client refuses every call, so no row is read; zero is an id no sequence hands out.
      id: 0n,
      tenantId: 1n,
      // No handler is registered in this process, so the run goes straight to failing the row:
      // the outcome write, which runs after the handler and outside it.
      kind: "SPEND_POLL",
      payload: {},
      attempts: 0,
      claimSeq: 1,
    } as unknown as ClaimedJob;
    await runClaimed(job, recordingBase(seen)).catch(() => null);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((l) => l === "job:SPEND_POLL")).toBe(true);
  });

  test("the debounce and compaction lanes label their claims", async () => {
    const seen: (string | null)[] = [];
    const claim = async () => {
      seen.push(currentWorkLabel());
      return [];
    };
    await runDebounceTick({} as PrismaClient, 1, { claim } as never).catch(
      () => null,
    );
    await runCompactionTick({} as PrismaClient, 1, {
      claim,
      reap: async () => {
        seen.push(currentWorkLabel());
        return [];
      },
    } as never).catch(() => null);
    // One debounce claim, then the compaction lane's reaps (one per kind) and its claim.
    expect(seen[0]).toBe("debounce");
    expect(seen.length).toBeGreaterThan(2);
    expect(seen.slice(1).every((l) => l === "compaction")).toBe(true);
  });
});
