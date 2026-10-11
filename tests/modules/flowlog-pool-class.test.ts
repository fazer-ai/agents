import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import { currentPoolClass, type PoolClass } from "@/lib/pool-class";
import { scheduledFlowWrites } from "@/modules/flowlog/scheduled";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { until } from "@/tests/utils/poll";

// A flow-log line a turn emits without waiting is written on the background pool: nothing waits on
// it, and with its table locked it would otherwise sit on a connection a turn needs.
describe("emitFlowEvent", () => {
  test("writes on the background pool, whatever pool the emitter is on", async () => {
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
      { tenantId: 1n, turnId: "t-pool", source: "inbox", base },
      { stage: "generate" },
    );
    await until("the write ran", () => seen.length > 0);
    await until("the write settled", () => scheduledFlowWrites() === 0);
    expect(seen).toEqual(["background"]);
  });
});
