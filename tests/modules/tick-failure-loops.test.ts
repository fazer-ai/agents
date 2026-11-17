import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import config from "@/config";
import {
  startDebounceWorker,
  stopDebounceWorker,
} from "@/modules/debounce/worker";
import {
  startAlertWorker,
  stopAlertWorker,
} from "@/modules/flowlog/alert-worker";
import {
  startCompactionWorker,
  stopCompactionWorker,
} from "@/modules/memory/worker";
import { startScheduler, stopScheduler } from "@/modules/scheduler/worker";
import {
  startOutboundWorker,
  stopOutboundWorker,
} from "@/modules/webhooks/outbound/worker";
import { until } from "@/tests/utils/poll";

// Each background loop reports a tick the database refused (no connection within `maxWait`) at
// warn, not at error, which pages. The base refuses every use the way a drained pool does.

function neverStarted(): Error {
  return Object.assign(
    new Error(
      "Transaction API error: Unable to start a transaction in the given time.",
    ),
    { code: "P2028" },
  );
}

function refusingBase(): PrismaClient {
  return new Proxy(
    {},
    {
      get() {
        throw neverStarted();
      },
    },
  ) as PrismaClient;
}

const warn = spyOn(logger, "warn");
const error = spyOn(logger, "error");

afterEach(() => {
  stopScheduler();
  stopDebounceWorker();
  stopCompactionWorker();
  stopAlertWorker();
  stopOutboundWorker();
  warn.mockClear();
  error.mockClear();
});

const said = (spy: typeof warn, text: string) =>
  spy.mock.calls.some((c) => c.some((a) => String(a).includes(text)));

async function warnsNotErrors(text: string): Promise<void> {
  await until(`a warn naming "${text}"`, () => said(warn, text));
  expect(said(error, text)).toBe(false);
}

describe("a tick the database refused logs at warn", () => {
  test("scheduler", async () => {
    startScheduler({
      base: refusingBase(),
      intervalMs: 5,
      observeIntervalMs: 60_000,
      runTraffic: async () => ({ waitMs: null }) as never,
    });
    await warnsNotErrors("scheduler tick failed");
  });

  test("observe", async () => {
    startScheduler({
      base: refusingBase(),
      intervalMs: 60_000,
      observeIntervalMs: 5,
      runTraffic: async () => ({ waitMs: null }) as never,
    });
    await warnsNotErrors("observe tick failed");
  });

  test("traffic", async () => {
    startScheduler({
      base: refusingBase(),
      intervalMs: 5,
      observeIntervalMs: 60_000,
      runTraffic: async () => {
        throw neverStarted();
      },
    });
    await warnsNotErrors("traffic tick failed");
  });

  test("debounce", async () => {
    startDebounceWorker({ base: refusingBase(), intervalMs: 5 });
    await warnsNotErrors("debounce tick failed");
  });

  test("compaction", async () => {
    startCompactionWorker({ base: refusingBase(), intervalMs: 5 });
    await warnsNotErrors("compaction tick failed");
  });

  test("alert", async () => {
    const saved = config.alertWorker.intervalMs;
    config.alertWorker.intervalMs = 5;
    try {
      startAlertWorker({ base: refusingBase() });
      await warnsNotErrors("Alert tick failed");
    } finally {
      config.alertWorker.intervalMs = saved;
    }
  });

  test("outbound webhook", async () => {
    const saved = config.webhookWorker.intervalMs;
    config.webhookWorker.intervalMs = 5;
    try {
      startOutboundWorker({ base: refusingBase() });
      await warnsNotErrors("Outbound webhook tick failed");
    } finally {
      config.webhookWorker.intervalMs = saved;
    }
  });
});
