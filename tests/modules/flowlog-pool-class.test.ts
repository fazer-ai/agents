import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  currentPoolClass,
  type PoolClass,
  runInPoolClass,
} from "@/lib/pool-class";
import { scheduledFlowWrites } from "@/modules/flowlog/scheduled";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { until } from "@/tests/utils/poll";

// A flow-log line is written on the pool of the work that emits it. A turn's lines are its record for
// the operator: on the background pool they would wait behind whatever holds it, and past maxWait the
// turn's lines are dropped while the turn itself answers.
describe("emitFlowEvent", () => {
  test("writes on the emitter's pool: a turn's on main, a background job's on background", async () => {
    const seen: PoolClass[] = [];
    // A client that records the class its transaction was opened under, and refuses it.
    const base = {
      $extends: () => base,
      $transaction: () => {
        seen.push(currentPoolClass());
        return Promise.reject(new Error("not a database"));
      },
    } as unknown as PrismaClient;
    expect(currentPoolClass()).toBe("main");
    emitFlowEvent(
      { tenantId: 1n, turnId: "t-turn", source: "inbox", base },
      { stage: "generate" },
    );
    await until("the turn's write ran", () => seen.length > 0);
    runInPoolClass("background", () =>
      emitFlowEvent(
        { tenantId: 1n, turnId: "t-job", source: "inbox", base },
        { stage: "generate" },
      ),
    );
    await until("the job's write ran", () => seen.length > 1);
    await until("the writes settled", () => scheduledFlowWrites() === 0);
    expect(seen).toEqual(["main", "background"]);
  });
});
