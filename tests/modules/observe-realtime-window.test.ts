import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { z } from "zod";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  assertSettingsClosedValues,
  InvalidSettingsValueError,
} from "@/modules/agents/service";
import { BEHAVIOR_PATCH_ARGS_SHAPE } from "@/modules/agents/settings-schema";
import { armObserve } from "@/modules/observe/job";
import {
  MONITORING_DEFAULTS,
  readMonitoringConfig,
} from "@/modules/observe/settings";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  getJobHandler,
  type JobHandler,
  registerJobHandler,
  startScheduler,
  stopScheduler,
  unregisterJobHandler,
} from "@/modules/scheduler/worker";
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";

// The observer's burst window down to ZERO: what the reader keeps, what the write
// boundary refuses, and when the observation of a message starts with no window at all, against
// the database and the worker's own timers.

const windowOf = (windowSeconds: unknown, maxWindowSeconds?: unknown) =>
  readMonitoringConfig({
    monitoring: {
      debounce: {
        windowSeconds,
        ...(maxWindowSeconds === undefined ? {} : { maxWindowSeconds }),
      },
    },
  }).debounce;

describe("the window the reader keeps", () => {
  test("0, 1 and 2 are kept as written", () => {
    expect(windowOf(0).windowSeconds).toBe(0);
    expect(windowOf(1).windowSeconds).toBe(1);
    expect(windowOf(2).windowSeconds).toBe(2);
  });

  test("a window of zero may carry a ceiling of zero, and the ceiling is never below the window", () => {
    expect(windowOf(0, 0)).toEqual({ windowSeconds: 0, maxWindowSeconds: 0 });
    expect(windowOf(2, 1)).toEqual({ windowSeconds: 2, maxWindowSeconds: 2 });
  });

  test("an agent that never set the window reads the default, and so does a value that is not a number", () => {
    const def = MONITORING_DEFAULTS.debounce;
    expect(def).toEqual({ windowSeconds: 20, maxWindowSeconds: 60 });
    expect(readMonitoringConfig({}).debounce).toEqual(def);
    expect(readMonitoringConfig({ monitoring: {} }).debounce).toEqual(def);
    expect(windowOf("0").windowSeconds).toBe(def.windowSeconds);
    expect(windowOf(null).windowSeconds).toBe(def.windowSeconds);
  });

  test("a value above the ceiling is still narrowed, as before", () => {
    expect(windowOf(9_999).windowSeconds).toBe(600);
  });
});

describe("what the write boundary answers for the window", () => {
  const caught = (settings: unknown, stored?: unknown) => {
    try {
      assertSettingsClosedValues(settings, stored);
    } catch (e) {
      return e as InvalidSettingsValueError;
    }
    return null;
  };
  const withWindow = (windowSeconds: unknown) => ({
    monitoring: { debounce: { windowSeconds } },
  });

  test("0, 1 and 2 are accepted", () => {
    for (const ok of [0, 1, 2]) expect(caught(withWindow(ok))).toBeNull();
  });

  test("a negative window is refused by path, with what was expected", () => {
    const err = caught(withWindow(-1));
    expect(err).toBeInstanceOf(InvalidSettingsValueError);
    expect(err?.statusCode).toBe(400);
    expect(err?.field).toBe("monitoring.debounce.windowSeconds");
    expect(err?.translationKey).toBe("errors.invalidSettingsValue");
    expect(String(err?.translationParams?.expected)).toBe(
      "a number of at least 0",
    );
    // The value, not its type: "expects a number, got number" tells the operator nothing.
    expect(err?.translationParams?.got).toBe("-1");
    expect(err?.message).toBe(
      "settings.monitoring.debounce.windowSeconds expects a number of at least 0, got -1",
    );
    expect(caught(withWindow(-0.5))?.field).toBe(
      "monitoring.debounce.windowSeconds",
    );
  });

  test("a window that is not a number is refused in the shape every closed value is", () => {
    const reference = caught({ monitoring: { analysis: "banana" } });
    for (const bad of ["abc", "0", true, [0], { s: 0 }]) {
      const err = caught(withWindow(bad));
      expect(err).toBeInstanceOf(InvalidSettingsValueError);
      expect(err?.field).toBe("monitoring.debounce.windowSeconds");
      expect(err?.statusCode).toBe(reference?.statusCode);
      expect(err?.translationKey).toBe(reference?.translationKey);
      expect(Object.keys(err?.translationParams ?? {}).sort()).toEqual(
        Object.keys(reference?.translationParams ?? {}).sort(),
      );
    }
  });

  test("a stored negative window re-sent untouched still saves, and a value above the ceiling is not refused", () => {
    expect(caught(withWindow(-5), withWindow(-5))).toBeNull();
    expect(caught(withWindow(-4), withWindow(-5))?.field).toBe(
      "monitoring.debounce.windowSeconds",
    );
    expect(caught(withWindow(100_000))).toBeNull();
  });

  test("the MCP patch refuses a negative window and takes zero", () => {
    const patch = z.object(BEHAVIOR_PATCH_ARGS_SHAPE);
    expect(patch.safeParse(withWindow(0)).success).toBe(true);
    expect(patch.safeParse(withWindow(-1)).success).toBe(false);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(holds: () => boolean, ms = POLL_DEADLINE_MS) {
  const end = Date.now() + ms;
  while (!holds() && Date.now() < end) await sleep(10);
}

// A handler a test holds open, recording when each run began and ended.
function held() {
  const runs: { began: number; ended: number | null }[] = [];
  let release: (() => void) | undefined;
  let open = false;
  const handler: JobHandler = async (_job: ClaimedJob) => {
    const run = { began: Date.now(), ended: null as number | null };
    runs.push(run);
    if (!open) await new Promise<void>((r) => (release = r));
    run.ended = Date.now();
    return { outcome: "done" };
  };
  return {
    runs,
    handler,
    releaseOne() {
      release?.();
      release = undefined;
    },
    releaseAll() {
      open = true;
      release?.();
    },
  };
}

describe.skipIf(!dbUp)("a window of zero on the observe lane", () => {
  let previous: JobHandler | undefined;
  // The window as an agent's stored settings give it, through the reader the receiver uses.
  const cfg = (windowSeconds: number) =>
    readMonitoringConfig({ monitoring: { debounce: { windowSeconds } } });
  const arm = (conversationId: number, windowSeconds: number, now?: Date) =>
    armObserve({
      tenantId,
      instanceId: 1n,
      conversationId,
      agentId: 1n,
      reason: "burst",
      cfg: cfg(windowSeconds),
      base: appDb,
      ...(now ? { now } : {}),
    });
  // Both intervals a minute away: whatever starts here was started by the arm's own wake-up or by a
  // slot being freed, never by an interval.
  const start = () =>
    startScheduler({
      base: appDb,
      intervalMs: 60_000,
      observeIntervalMs: 60_000,
      tenantId,
      providerConcurrency: 2,
    });

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "OBS-RT", slug: `obs-rt-${process.pid}` },
    });
    tenantId = t.id;
    previous = getJobHandler("OBSERVE");
  });

  afterEach(async () => {
    stopScheduler();
    if (previous) registerJobHandler("OBSERVE", previous);
    else unregisterJobHandler("OBSERVE");
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.schedulerJob.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("the row is due at the instant it is armed", async () => {
    const now = new Date("2026-10-09T12:00:00.000Z");
    expect(await arm(8801, 0, now)).toBe("armed");
    const row = await suDb.schedulerJob.findFirstOrThrow({
      where: { tenantId, kind: "OBSERVE" },
      select: { runAt: true, status: true },
    });
    expect(row.status).toBe("PENDING");
    expect(row.runAt.getTime()).toBe(now.getTime());
  });

  test("the observation starts within a second of the message, with no interval to wait for", async () => {
    const h = held();
    h.releaseAll();
    registerJobHandler("OBSERVE", h.handler);
    start();
    const armedAt = Date.now();
    expect(await arm(8802, 0)).toBe("armed");
    await until(() => h.runs.length > 0, 3_000);
    expect(h.runs).toHaveLength(1);
    expect((h.runs[0]?.began ?? Infinity) - armedAt).toBeLessThan(1_000);
  });

  test("messages landing while an observation runs get ONE more, after it, and never beside it", async () => {
    const h = held();
    registerJobHandler("OBSERVE", h.handler);
    start();
    expect(await arm(8803, 0)).toBe("armed");
    await until(() => h.runs.length === 1, 3_000);
    expect(h.runs).toHaveLength(1);
    // Ten messages in the run's lifetime, each arming the same row due at once.
    for (let i = 0; i < 10; i += 1) {
      expect(await arm(8803, 0)).toBe("armed");
      await sleep(20);
    }
    // Long enough for every wake-up those arms asked for to have fired.
    await sleep(400);
    expect(h.runs).toHaveLength(1);
    expect(
      await suDb.schedulerJob.count({
        where: { tenantId, kind: "OBSERVE", status: "PENDING" },
      }),
    ).toBe(1);
    const releasedAt = Date.now();
    h.releaseOne();
    await until(() => h.runs.length === 2, 3_000);
    expect(h.runs).toHaveLength(2);
    const [first, second] = h.runs;
    expect(first?.ended).not.toBeNull();
    expect(second?.began ?? 0).toBeGreaterThanOrEqual(first?.ended ?? Infinity);
    // The freed slot starts it, not the interval a minute away.
    expect((second?.began ?? Infinity) - releasedAt).toBeLessThan(1_000);
    h.releaseAll();
    await until(() => h.runs[1]?.ended != null, 3_000);
    await sleep(300);
    // Nothing owed after the last message was covered.
    expect(h.runs).toHaveLength(2);
    expect(
      await suDb.schedulerJob.count({
        where: {
          tenantId,
          kind: "OBSERVE",
          status: { in: ["PENDING", "CLAIMED"] },
        },
      }),
    ).toBe(0);
  });

  test("five messages inside the default window are still one observation", async () => {
    const h = held();
    h.releaseAll();
    registerJobHandler("OBSERVE", h.handler);
    start();
    const def = readMonitoringConfig({});
    for (let i = 0; i < 5; i += 1) {
      expect(
        await armObserve({
          tenantId,
          instanceId: 1n,
          conversationId: 8804,
          agentId: 1n,
          reason: "burst",
          cfg: def,
          base: appDb,
        }),
      ).toBe("armed");
    }
    await sleep(600);
    expect(h.runs).toHaveLength(0);
    const rows = await suDb.schedulerJob.findMany({
      where: { tenantId, kind: "OBSERVE" },
      select: { status: true, runAt: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect((rows[0]?.runAt.getTime() ?? 0) - Date.now()).toBeGreaterThan(
      15_000,
    );
  });
});
