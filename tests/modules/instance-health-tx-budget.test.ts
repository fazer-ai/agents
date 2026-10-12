import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import {
  evaluateSample,
  resetEvaluator,
} from "@/modules/instance-health/evaluator";
import { INSTANCE_HEALTH_TX_BUDGET } from "@/modules/instance-health/fleet-tx";
import { readDatabaseSignals } from "@/modules/instance-health/sampler";
import {
  processInstanceAlertBatch,
  pruneInstanceAlertDeliveries,
} from "@/modules/instance-health/worker";

// The sampler's one connection is also the only one the instance alerts have, so its transactions
// carry their own bound instead of the app-wide DB_TX_TIMEOUT_MS, which also becomes their
// statement_timeout (fleet-tx.ts). A client that records what each transaction asked for, and
// stops it there.

function recorder(): { base: PrismaClient; seen: { timeout?: number }[] } {
  const seen: { timeout?: number }[] = [];
  const base = {
    $transaction: async (_fn: unknown, opts: { timeout?: number }) => {
      seen.push(opts);
      throw new Error("stopped by the test");
    },
  } as unknown as PrismaClient;
  return { base, seen };
}

describe("the instance health transactions", () => {
  test("carry their own bound whatever the app-wide timeout (catches a slow aggregate holding the alerts' only connection)", async () => {
    const before = config.dbTx.timeoutMs;
    (config.dbTx as { timeoutMs: number }).timeoutMs = 120_000;
    try {
      const { base, seen } = recorder();
      await readDatabaseSignals(base).catch(() => undefined);
      await processInstanceAlertBatch({ base }).catch(() => undefined);
      await pruneInstanceAlertDeliveries(base).catch(() => undefined);
      // The evaluator's threshold read, retried on failure, on the same client.
      resetEvaluator(base);
      await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_000_000).catch(
        () => undefined,
      );
      resetEvaluator();
      expect(seen.length).toBeGreaterThan(3);
      for (const opts of seen) {
        expect(opts.timeout).toBe(INSTANCE_HEALTH_TX_BUDGET.timeout);
      }
      expect(INSTANCE_HEALTH_TX_BUDGET.timeout).toBeLessThanOrEqual(10_000);
    } finally {
      (config.dbTx as { timeoutMs: number }).timeoutMs = before;
    }
  });
});
