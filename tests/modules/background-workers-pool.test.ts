import { afterEach, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { currentPoolClass, type PoolClass } from "@/lib/pool-class";
import {
  startAlertWorker,
  stopAlertWorker,
} from "@/modules/flowlog/alert-worker";
import {
  startOutboundWorker,
  stopOutboundWorker,
} from "@/modules/webhooks/outbound/worker";
import { until } from "@/tests/utils/poll";

// The outbound webhook and alert workers deliver to third parties nobody is waiting on this second,
// so their ticks draw from the background pool (src/lib/pool-class.ts), not the turns' one.

// A client that records the class of whoever touches it, and refuses every use.
function recordingBase(seen: PoolClass[]): PrismaClient {
  return new Proxy(
    {},
    {
      get() {
        seen.push(currentPoolClass());
        throw new Error("not a database");
      },
    },
  ) as PrismaClient;
}

afterEach(() => {
  stopOutboundWorker();
  stopAlertWorker();
});

describe("background workers", () => {
  test("the outbound webhook worker's tick runs in the background class", async () => {
    const seen: PoolClass[] = [];
    const saved = config.webhookWorker.intervalMs;
    config.webhookWorker.intervalMs = 5;
    try {
      startOutboundWorker({ base: recordingBase(seen) });
      await until("the tick touched the database", () => seen.length > 0);
    } finally {
      config.webhookWorker.intervalMs = saved;
    }
    expect(new Set(seen)).toEqual(new Set(["background"]));
  });

  test("the alert worker's tick runs in the background class", async () => {
    const seen: PoolClass[] = [];
    const saved = config.alertWorker.intervalMs;
    config.alertWorker.intervalMs = 5;
    try {
      startAlertWorker({ base: recordingBase(seen) });
      await until("the tick touched the database", () => seen.length > 0);
    } finally {
      config.alertWorker.intervalMs = saved;
    }
    expect(new Set(seen)).toEqual(new Set(["background"]));
  });
});
