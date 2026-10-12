import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import { asSuperAdminOn, type TenantContext } from "@/lib/tenancy";
import {
  createInstanceAlertChannel,
  listInstanceAlertChannels,
  listInstanceThresholds,
  resetInstanceThreshold,
  sendInstanceAlertChannelTest,
  setInstanceThreshold,
  updateInstanceAlertChannel,
} from "@/modules/instance-health/channels";
import {
  evaluateSample,
  firingSignals,
  judge,
  resetEvaluator,
  setEvaluatorBase,
} from "@/modules/instance-health/evaluator";
import {
  readInstanceHealth,
  requireFleet,
} from "@/modules/instance-health/read";
import {
  HISTORY_MS,
  readDatabaseSignals,
  resetSamplerState,
  type SamplerSources,
  sampleOnce,
  snapshot,
  tick,
} from "@/modules/instance-health/sampler";
import {
  processInstanceAlertBatch,
  pruneInstanceAlertDeliveries,
} from "@/modules/instance-health/worker";
import {
  instanceAlertChannelCreate,
  instanceAlertChannelUpdate,
  instanceHealthGet,
  instanceThresholdSet,
} from "@/modules/mcp/write-instance-health";
import { dbProbeFailed } from "@/tests/db-gate";
import { outboundUrl } from "../utils/outbound";
import { until } from "../utils/poll";

// Instance health against a real database: the fleet-only tables, the channel service, the
// "above X for Y seconds" evaluator, the delivery worker and the sampler's database read. The
// instance tables are global and only this file writes them, so each test starts from empty.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

const FLEET: TenantContext = {
  tenantId: null,
  userId: null,
  role: "SUPER_ADMIN",
};
const allowAll = async (url: string) => new URL(url);

async function wipe(): Promise<void> {
  await suDb.$executeRaw`DELETE FROM instance_alert_deliveries`;
  await suDb.$executeRaw`DELETE FROM instance_alert_channels`;
  await suDb.$executeRaw`DELETE FROM instance_alert_thresholds`;
}

// A delivery's `created_at` is the client's clock and the claim compares it to the database's; moved
// back past any coalesce window so the claim sees it.
async function age(): Promise<void> {
  await suDb.$executeRaw`UPDATE instance_alert_deliveries SET created_at = now() - interval '1 hour'`;
}

async function deliveries() {
  return suDb.instanceAlertDelivery.findMany({ orderBy: { id: "asc" } });
}

async function channel(signals: string[] = [], name = "ops") {
  return createInstanceAlertChannel(
    FLEET,
    { name, type: "webhook", url: outboundUrl("/x"), signals },
    appDb,
  );
}

afterAll(async () => {
  if (dbUp) await wipe();
});

describe.skipIf(!dbUp)("instance alert tables", () => {
  beforeEach(wipe);

  test("the runtime role outside the fleet role sees nothing and writes nothing (catches a table left without RLS)", async () => {
    await channel();
    const seen = await appDb.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM instance_alert_channels`;
    expect(seen[0]?.n).toBe(0);
    await expect(
      (async () =>
        appDb.$executeRaw`INSERT INTO instance_alert_thresholds (signal, threshold, duration_seconds, updated_at)
                        VALUES ('event_loop_p99_ms', 1, 1, now())`)(),
    ).rejects.toThrow();
    const asFleet = await asSuperAdminOn(appDb, (db) =>
      db.instanceAlertChannel.count(),
    );
    expect(asFleet).toBe(1);
  });

  test("a tenant principal is refused at the service boundary (catches a tenant admin reading the fleet's load)", () => {
    expect(() =>
      requireFleet({ tenantId: 1n, userId: 1n, role: "TENANT_ADMIN" }),
    ).toThrow();
    expect(() => requireFleet(null)).toThrow();
    expect(requireFleet(FLEET)).toBe(FLEET);
  });
});

describe.skipIf(!dbUp)("instance alert channels", () => {
  beforeEach(wipe);

  test("url and secret are stored encrypted and never returned (catches a token leaking through the list)", async () => {
    const created = await createInstanceAlertChannel(
      FLEET,
      {
        name: "ops",
        type: "webhook",
        url: outboundUrl("/secret-path?token=abc"),
        secret: "s3cret",
      },
      appDb,
    );
    const listed = await listInstanceAlertChannels(appDb);
    const text = JSON.stringify(listed);
    expect(text).not.toContain("secret-path");
    expect(text).not.toContain("s3cret");
    expect(listed[0]?.hasSecret).toBe(true);
    const row = await suDb.instanceAlertChannel.findUniqueOrThrow({
      where: { id: BigInt(created.id) },
    });
    expect(decryptJson<string>(row.url as string)).toContain("secret-path");
    expect(decryptJson<string>(row.secret as string)).toBe("s3cret");
  });

  test("an unknown signal is refused (catches a channel filtering on a name nothing emits)", async () => {
    await expect(channel(["no_such_signal"])).rejects.toThrow(/unknown signal/);
    const c = await channel();
    await expect(
      updateInstanceAlertChannel(
        FLEET,
        BigInt(c.id),
        { signals: ["nope"] },
        appDb,
      ),
    ).rejects.toThrow(/unknown signal/);
  });

  test("writes land on the fleet audit trail, with no tenant (catches an audit row filed under a tenant)", async () => {
    const c = await channel();
    const audit = await suDb.auditLog.findFirst({
      where: { target: `instance_alert_channel:${c.id}` },
      orderBy: { id: "desc" },
    });
    expect(audit?.action).toBe("instance_alert_channel.create");
    expect(audit?.tenantId).toBeNull();
    expect(JSON.stringify(audit?.after)).not.toContain("/x");
  });

  test("a threshold override replaces the default and reset brings it back", async () => {
    const before = (await listInstanceThresholds(appDb)).find(
      (t) => t.signal === "event_loop_p99_ms",
    );
    expect(before?.isDefault).toBe(true);
    const set = await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 50, durationSeconds: 10 },
      appDb,
    );
    expect(set).toMatchObject({
      threshold: 50,
      durationSeconds: 10,
      isDefault: false,
    });
    const reset = await resetInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      appDb,
    );
    expect(reset).toMatchObject({
      threshold: before?.defaultThreshold,
      durationSeconds: before?.defaultDurationSeconds,
      isDefault: true,
    });
    await expect(
      setInstanceThreshold(
        FLEET,
        "event_loop_p99_ms",
        { threshold: -1, durationSeconds: 0 },
        appDb,
      ),
    ).rejects.toThrow();
  });
});

describe.skipIf(!dbUp)("above X for Y seconds", () => {
  beforeEach(async () => {
    await wipe();
    resetEvaluator(appDb);
  });

  test("a breach shorter than the duration never alerts (catches a page on a one-sample spike)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 30 },
      appDb,
    );
    const t0 = 1_000_000;
    await evaluateSample({ event_loop_p99_ms: 500 }, t0);
    await evaluateSample({ event_loop_p99_ms: 500 }, t0 + 25_000);
    await evaluateSample({ event_loop_p99_ms: 10 }, t0 + 30_000);
    await evaluateSample({ event_loop_p99_ms: 500 }, t0 + 35_000);
    expect(await deliveries()).toEqual([]);
    expect(firingSignals()).toEqual([]);
  });

  test("a value equal to the threshold is not above it (catches waiters=0 paging with the default 0)", async () => {
    await channel();
    await evaluateSample(
      { model_permit_waiters: 0, ingress_lag_p95_ms: 30_000 },
      1_500_000,
    );
    await evaluateSample(
      { model_permit_waiters: 0, ingress_lag_p95_ms: 30_000 },
      1_600_000,
    );
    expect(await deliveries()).toEqual([]);
  });

  test("held for the duration it fires once, and recovers once (catches an alert per sample)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 30 },
      appDb,
    );
    const t0 = 2_000_000;
    for (let s = 0; s <= 60; s += 5) {
      await evaluateSample({ event_loop_p99_ms: 500 }, t0 + s * 1000);
    }
    expect(firingSignals()).toEqual(["event_loop_p99_ms"]);
    await evaluateSample({ event_loop_p99_ms: 20 }, t0 + 65_000);
    await evaluateSample({ event_loop_p99_ms: 20 }, t0 + 70_000);
    const rows = await deliveries();
    expect(rows.map((r) => [r.signal, r.kind, r.level, r.count])).toEqual([
      ["event_loop_p99_ms", "firing", "error", 1],
      ["event_loop_p99_ms", "recovered", "info", 1],
    ]);
    expect(rows[0]?.summary).toContain("above 200 ms for 30 s");
  });

  test("an alert whose write failed is retried on the next sample (catches a firing marked but never sent)", async () => {
    await channel();
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 7_000_000);
    const broken = {
      $transaction: async () => {
        throw new Error("pool exhausted");
      },
    } as unknown as PrismaClient;
    setEvaluatorBase(broken);
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 7_005_000);
    expect(await deliveries()).toEqual([]);
    setEvaluatorBase(appDb);
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 7_010_000);
    expect((await deliveries()).map((r) => r.kind)).toEqual(["firing"]);
  });

  test("a breach does not carry over samples the thresholds could not be read for (catches a fire before the duration held)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 30 },
      appDb,
    );
    const t0 = 8_200_000;
    await evaluateSample({ event_loop_p99_ms: 500 }, t0);
    const broken = {
      $transaction: async () => {
        throw new Error("pool exhausted");
      },
    } as unknown as PrismaClient;
    // Cache expired and unreadable: the cached limits still judge the sample, so a dip ends the breach.
    setEvaluatorBase(broken);
    await evaluateSample({ event_loop_p99_ms: 10 }, t0 + 40_000);
    setEvaluatorBase(appDb);
    await evaluateSample({ event_loop_p99_ms: 500 }, t0 + 45_000);
    expect(await deliveries()).toEqual([]);
  });

  test("a threshold changed while it is being read is read again (catches the old limit cached over the change)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 0 },
      appDb,
    );
    // The change lands right after the evaluator's first read returns, before it caches what it read.
    let hook: (() => Promise<unknown>) | null = () =>
      setInstanceThreshold(
        FLEET,
        "event_loop_p99_ms",
        { threshold: 1000, durationSeconds: 0 },
        appDb,
      );
    const racing = new Proxy(appDb, {
      get(target, prop, receiver) {
        if (prop !== "$transaction") return Reflect.get(target, prop, receiver);
        return async (...args: unknown[]) => {
          const out = await (
            target.$transaction as (...a: unknown[]) => Promise<unknown>
          )(...args);
          const h = hook;
          hook = null;
          if (h) await h();
          return out;
        };
      },
    });
    resetEvaluator(racing);
    await evaluateSample({ event_loop_p99_ms: 600 }, 8_100_000);
    await evaluateSample({ event_loop_p99_ms: 600 }, 8_105_000);
    expect(firingSignals()).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  test("a new threshold restarts a pending breach (catches the old interval firing against the new limit)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 30 },
      appDb,
    );
    const t0 = 8_000_000;
    await evaluateSample({ event_loop_p99_ms: 500 }, t0);
    await evaluateSample({ event_loop_p99_ms: 500 }, t0 + 25_000);
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 1000, durationSeconds: 30 },
      appDb,
    );
    await evaluateSample({ event_loop_p99_ms: 1500 }, t0 + 30_000);
    expect(await deliveries()).toEqual([]);
    await evaluateSample({ event_loop_p99_ms: 1500 }, t0 + 60_000);
    expect((await deliveries()).map((r) => r.kind)).toEqual(["firing"]);
  });

  test("muting a firing signal drops it without a recovery (catches a false all-clear while the value is still above)", async () => {
    await channel();
    const t0 = 8_500_000;
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, t0);
    expect(firingSignals()).toEqual(["ingress_lag_p95_ms"]);
    await setInstanceThreshold(
      FLEET,
      "ingress_lag_p95_ms",
      { threshold: 30_000, durationSeconds: 0, enabled: false },
      appDb,
    );
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, t0 + 5_000);
    await evaluateSample({ ingress_lag_p95_ms: 0 }, t0 + 10_000);
    expect(firingSignals()).toEqual([]);
    expect((await deliveries()).map((r) => r.kind)).toEqual(["firing"]);
  });

  test("a flapping signal folds into the pending delivery's count (catches a flood while the first is unsent)", async () => {
    await channel();
    const t0 = 3_000_000;
    for (let i = 0; i < 3; i++) {
      await evaluateSample({ ingress_lag_p95_ms: 90_000 }, t0 + i * 100_000);
      await evaluateSample({ ingress_lag_p95_ms: 0 }, t0 + i * 100_000 + 5_000);
    }
    const rows = await deliveries();
    expect(rows.map((r) => [r.kind, r.count])).toEqual([
      ["firing", 3],
      ["recovered", 1],
    ]);
  });

  test("a channel gets only its signals, a disabled channel and a muted signal get nothing", async () => {
    const lag = await channel(["ingress_lag_p95_ms"], "lag only");
    const all = await channel([], "all");
    const off = await channel([], "off");
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(off.id),
      { enabled: false },
      appDb,
    );
    await setInstanceThreshold(
      FLEET,
      "model_permit_waiters",
      { threshold: 0, durationSeconds: 0, enabled: false },
      appDb,
    );
    await evaluateSample(
      {
        model_permit_waiters: 9,
        ingress_lag_p95_ms: 90_000,
        debounce_lane_full_ms: 60_000,
      },
      4_000_000,
    );
    const rows = await deliveries();
    expect(
      rows.map((r) => `${String(r.channelId)}:${r.signal}`).sort(),
    ).toEqual(
      [
        `${lag.id}:ingress_lag_p95_ms`,
        `${all.id}:ingress_lag_p95_ms`,
        `${all.id}:debounce_lane_full_ms`,
      ].sort(),
    );
  });
});

describe.skipIf(!dbUp)("instance alert delivery", () => {
  beforeEach(async () => {
    await wipe();
    resetEvaluator(appDb);
  });

  test("delivers signed, links the instance screen, names no tenant (catches an instance alert sent like a tenant's)", async () => {
    await createInstanceAlertChannel(
      FLEET,
      {
        name: "ops",
        type: "webhook",
        url: outboundUrl("/x"),
        secret: "k",
      },
      appDb,
    );
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 5_000_000);
    await age();
    const posted: { headers: Headers; body: string }[] = [];
    const summary = await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: {
        assertSafe: allowAll,
        fetchImpl: (async (_url: string, init: RequestInit) => {
          posted.push({
            headers: new Headers(init.headers),
            body: String(init.body),
          });
          return new Response(null, { status: 204 });
        }) as unknown as typeof fetch,
      },
    });
    expect(summary).toMatchObject({ claimed: 1, delivered: 1 });
    const body = JSON.parse(posted[0]?.body ?? "{}");
    expect(body.stage).toBe("instance_health");
    expect(body.tenant).toEqual({ id: null, name: null });
    expect(body.links[0].url).toContain("/admin/instance-health");
    expect(posted[0]?.headers.get("x-fazerai-signature")).toBeTruthy();
    expect((await deliveries())[0]?.status).toBe("DELIVERED");
  });

  test("a refused destination retries with backoff, an unreachable url goes straight to DEAD", async () => {
    await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 6_000_000);
    await age();
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: {
        assertSafe: allowAll,
        fetchImpl: (async () =>
          new Response(null, { status: 500 })) as unknown as typeof fetch,
      },
    });
    const retried = (await deliveries())[0];
    expect(retried?.status).toBe("PENDING");
    expect(retried?.attempts).toBe(1);
    expect(retried?.nextAttemptAt).not.toBeNull();
    await suDb.$executeRaw`UPDATE instance_alert_deliveries SET next_attempt_at = now() - interval '1 second'`;
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: {
        assertSafe: async () => {
          throw new Error("blocked");
        },
      },
    });
    expect((await deliveries())[0]?.status).toBe("DEAD");
    // The bus cannot page about itself: the channel is listed as failing, with the reason.
    const [listed] = await listInstanceAlertChannels(appDb);
    expect(listed?.failing?.signal).toBe("ingress_lag_p95_ms");
    expect(listed?.failing?.error).toContain("blocked");
  });
});

describe.skipIf(!dbUp)("instance alert order, signing and retention", () => {
  beforeEach(async () => {
    await wipe();
    resetEvaluator(appDb);
  });

  const ok204 = (async () =>
    new Response(null, { status: 204 })) as unknown as typeof fetch;

  test("a flap that is still unsent leaves the firing as the last word (catches a recovery delivered while the signal fires)", async () => {
    await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_000_000);
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_005_000);
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_010_000);
    const rows = await deliveries();
    expect(rows.map((r) => [r.kind, r.count])).toEqual([["firing", 2]]);
    expect(firingSignals()).toEqual(["ingress_lag_p95_ms"]);
  });

  test("a firing decided before a newer reading ended it is not written once the channel read returns (catches a stale page sent next to its recovery)", async () => {
    await channel();
    // Limits read, nothing owed.
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_400_000);
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = suDb.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE instance_alert_channels IN ACCESS EXCLUSIVE MODE`;
        await released;
      },
      { timeout: 30_000 },
    );
    await until("the lock is held", async () => {
      const [row] = await suDb.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE relation = 'instance_alert_channels'::regclass AND granted`;
      return (row?.n ?? 0) > 0;
    });
    // Judged above, then its channel read waits on the lock.
    const sample = evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_405_000);
    await until("the channel read is waiting", async () => {
      const [row] = await suDb.$queryRaw<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
         WHERE relation = 'instance_alert_channels'::regclass AND NOT granted`;
      return (row?.n ?? 0) > 0;
    });
    // Meanwhile the process half judges a newer reading, back under.
    judge({ ingress_lag_p95_ms: 0 }, 9_410_000);
    expect(firingSignals()).toEqual([]);
    release();
    await holder;
    await sample;
    expect(await deliveries()).toEqual([]);
  });

  test("after a restart a signal still above does not page again (catches a duplicate page per restart)", async () => {
    await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_050_000);
    resetEvaluator(appDb);
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_055_000);
    const rows = await deliveries();
    expect(rows.map((r) => [r.kind, r.count])).toEqual([["firing", 1]]);
  });

  test("after a restart a signal back under still sends the recovery it owes (catches a firing left without its all-clear)", async () => {
    await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_060_000);
    resetEvaluator(appDb);
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_065_000);
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_070_000);
    expect((await deliveries()).map((r) => r.kind)).toEqual([
      "firing",
      "recovered",
    ]);
  });

  test("a channel created or enabled during a breach hears the firing, and a quiet signal sends it nothing (catches an incident missed by a new channel)", async () => {
    const ops = await channel([], "ops");
    await evaluateSample(
      { ingress_lag_p95_ms: 90_000, model_permit_waiters: 0 },
      9_080_000,
    );
    const late = await channel([], "late");
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(ops.id),
      { enabled: false },
      appDb,
    );
    await evaluateSample(
      { ingress_lag_p95_ms: 90_000, model_permit_waiters: 0 },
      9_085_000,
    );
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(ops.id),
      { enabled: true },
      appDb,
    );
    await evaluateSample(
      { ingress_lag_p95_ms: 90_000, model_permit_waiters: 0 },
      9_090_000,
    );
    const rows = await deliveries();
    const by = (id: bigint | string) =>
      rows
        .filter((r) => String(r.channelId) === String(id))
        .map((r) => [r.signal, r.kind, r.count]);
    expect(by(ops.id)).toEqual([["ingress_lag_p95_ms", "firing", 1]]);
    expect(by(late.id)).toEqual([["ingress_lag_p95_ms", "firing", 1]]);
  });

  test("a firing that died is sent again once the channel is edited, and only then (catches a repaired channel left out of the incident)", async () => {
    const c = await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_300_000);
    await suDb.$executeRaw`UPDATE instance_alert_deliveries SET status = 'DEAD', attempts = 5, updated_at = now()`;
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_305_000);
    expect((await deliveries()).map((r) => r.status)).toEqual(["DEAD"]);
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(c.id),
      { url: outboundUrl("/fixed") },
      appDb,
    );
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_310_000);
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_315_000);
    expect(
      (await deliveries()).map((r) => [r.kind, r.status, r.attempts]),
    ).toEqual([
      ["firing", "DEAD", 5],
      ["firing", "PENDING", 0],
    ]);
  });

  test("an attempt that dies on the old configuration after the channel was fixed still counts as unheard (catches a repair made mid-attempt)", async () => {
    const c = await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_312_000);
    await age();
    await suDb.$executeRaw`UPDATE instance_alert_deliveries SET attempts = 7`;
    const failing = (async () => {
      // The operator fixes the URL while this last attempt, on the old one, is still out.
      await updateInstanceAlertChannel(
        FLEET,
        BigInt(c.id),
        { url: outboundUrl("/fixed") },
        appDb,
      );
      return new Response(null, { status: 500 });
    }) as unknown as typeof fetch;
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: failing },
    });
    expect((await deliveries()).map((r) => r.status)).toEqual(["DEAD"]);
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_317_000);
    expect((await deliveries()).map((r) => [r.kind, r.status])).toEqual([
      ["firing", "DEAD"],
      ["firing", "PENDING"],
    ]);
  });

  test("a recovery that died is sent once the channel is repaired (catches a receiver left in the firing state)", async () => {
    const c = await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_320_000);
    await suDb.$executeRaw`UPDATE instance_alert_deliveries SET status = 'DELIVERED', attempts = 1`;
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_325_000);
    await suDb.$executeRaw`UPDATE instance_alert_deliveries SET status = 'DEAD', attempts = 8, updated_at = now() WHERE kind = 'recovered'`;
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_330_000);
    expect((await deliveries()).length).toBe(2);
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(c.id),
      { url: outboundUrl("/fixed") },
      appDb,
    );
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_335_000);
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_340_000);
    expect((await deliveries()).map((r) => [r.kind, r.status])).toEqual([
      ["firing", "DELIVERED"],
      ["recovered", "DEAD"],
      ["recovered", "PENDING"],
    ]);
  });

  test("a destination that hangs holds back only its own alerts (catches one slow channel delaying the rest)", async () => {
    await channel([], "slow");
    await channel([], "fast");
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_350_000);
    await age();
    // The first request out never answers until released; the other channel's must not wait on it.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sent: string[] = [];
    let first = true;
    const fetchImpl = (async () => {
      if (first) {
        first = false;
        await gate;
        return new Response(null, { status: 204 });
      }
      sent.push("fast");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const batch = processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl },
    });
    await until("the healthy channel's delivery", () => sent.length > 0);
    expect(sent).toEqual(["fast"]);
    release();
    const summary = await batch;
    expect(summary.delivered).toBe(2);
  });

  test("what is queued for a signal muted since, or dropped from the channel, is never sent (catches a mute that does not stop pending sends)", async () => {
    const c = await channel();
    await evaluateSample(
      { ingress_lag_p95_ms: 90_000, model_permit_oldest_ms: 90_000 },
      9_400_000,
    );
    await age();
    await setInstanceThreshold(
      FLEET,
      "ingress_lag_p95_ms",
      { threshold: 30_000, durationSeconds: 0, enabled: false },
      appDb,
    );
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(c.id),
      // Still takes the muted signal, so each pending row is dropped by one rule alone.
      { signals: ["ingress_lag_p95_ms"] },
      appDb,
    );
    const sent: string[] = [];
    const record = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).summary);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: record },
    });
    expect(sent).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  test("a recovery waits for the firing before it, even while that one retries (catches deliveries out of order)", async () => {
    await channel();
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_100_000);
    await age();
    const failing = (async () =>
      new Response(null, { status: 500 })) as unknown as typeof fetch;
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: failing },
    });
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_105_000);
    await age();
    const sent: string[] = [];
    const record = (async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).level);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: record },
    });
    expect(sent).toEqual([]);
    await suDb.$executeRaw`UPDATE instance_alert_deliveries SET next_attempt_at = now() - interval '1 second' WHERE next_attempt_at IS NOT NULL`;
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: record },
    });
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: record },
    });
    expect(sent).toEqual(["error", "info"]);
  });

  test("a stored secret that cannot be read is reported on the channel, not shown as signed", async () => {
    const c = await createInstanceAlertChannel(
      FLEET,
      { name: "ops", type: "webhook", url: outboundUrl("/x"), secret: "k" },
      appDb,
    );
    await suDb.$executeRaw`UPDATE instance_alert_channels SET secret = 'not-a-blob' WHERE id = ${BigInt(c.id)}`;
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_200_000);
    await age();
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: ok204 },
    });
    const [listed] = await listInstanceAlertChannels(appDb);
    expect(listed?.hasSecret).toBe(true);
    expect(listed?.unsignedReason).toContain("cannot be read");
    // Another edit keeps the warning: the secret it is about is still the same.
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(c.id),
      { name: "ops 2" },
      appDb,
    );
    expect(
      (await listInstanceAlertChannels(appDb))[0]?.unsignedReason,
    ).toContain("cannot be read");
    // A replaced secret makes it stale (catches a repaired secret still reported as unreadable).
    await updateInstanceAlertChannel(
      FLEET,
      BigInt(c.id),
      { secret: "k2" },
      appDb,
    );
    expect(
      (await listInstanceAlertChannels(appDb))[0]?.unsignedReason,
    ).toBeNull();
  });

  test("an unsigned attempt still out when the secret is replaced does not restore the warning (catches a repaired secret reported unreadable again)", async () => {
    const c = await createInstanceAlertChannel(
      FLEET,
      { name: "ops", type: "webhook", url: outboundUrl("/x"), secret: "k" },
      appDb,
    );
    await suDb.$executeRaw`UPDATE instance_alert_channels SET secret = 'not-a-blob' WHERE id = ${BigInt(c.id)}`;
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_210_000);
    await age();
    const replacing = (async () => {
      await updateInstanceAlertChannel(
        FLEET,
        BigInt(c.id),
        { secret: "k2" },
        appDb,
      );
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
      send: { assertSafe: allowAll, fetchImpl: replacing },
    });
    expect((await deliveries()).map((r) => r.status)).toEqual(["DELIVERED"]);
    expect(
      (await listInstanceAlertChannels(appDb))[0]?.unsignedReason,
    ).toBeNull();
  });

  test("clearing a stale unsigned warning leaves which delivery is newest alone (catches an old failure resurfacing)", async () => {
    const c = await createInstanceAlertChannel(
      FLEET,
      { name: "ops", type: "webhook", url: outboundUrl("/x"), secret: "k" },
      appDb,
    );
    const id = BigInt(c.id);
    await suDb.$executeRaw`
      INSERT INTO instance_alert_deliveries (channel_id, signal, kind, level, summary, status, last_error, unsigned_reason, created_at, updated_at)
      VALUES (${id}, 'ingress_lag_p95_ms', 'firing', 'error', 'old', 'DEAD', 'HTTP 500', 'secret cannot be read', now() - interval '2 hours', now() - interval '2 hours'),
             (${id}, 'ingress_lag_p95_ms', 'recovered', 'info', 'new', 'DELIVERED', NULL, NULL, now() - interval '1 hour', now() - interval '1 hour')`;
    expect((await listInstanceAlertChannels(appDb))[0]?.failing).toBeNull();
    await updateInstanceAlertChannel(FLEET, id, { secret: "k2" }, appDb);
    expect((await listInstanceAlertChannels(appDb))[0]?.failing).toBeNull();
  });

  test("finished deliveries past retention are pruned, recent ones and pending ones stay", async () => {
    const c = await channel();
    const id = BigInt(c.id);
    await suDb.$executeRaw`
      INSERT INTO instance_alert_deliveries (channel_id, signal, kind, level, summary, status, created_at, updated_at)
      VALUES (${id}, 'event_loop_p99_ms', 'firing', 'error', 'old', 'DELIVERED', now() - interval '40 days', now() - interval '40 days'),
             (${id}, 'event_loop_p99_ms', 'recovered', 'info', 'recent', 'DELIVERED', now(), now()),
             (${id}, 'event_loop_p99_ms', 'firing', 'error', 'old pending', 'PENDING', now() - interval '40 days', now() - interval '40 days'),
             (${id}, 'ingress_lag_p95_ms', 'firing', 'error', 'old but last', 'DELIVERED', now() - interval '40 days', now() - interval '40 days'),
             (${id}, 'model_permit_oldest_ms', 'firing', 'error', 'old but last heard', 'DELIVERED', now() - interval '40 days', now() - interval '40 days'),
             (${id}, 'model_permit_oldest_ms', 'recovered', 'info', 'old dead', 'DEAD', now() - interval '40 days', now() - interval '40 days'),
             (${id}, 'model_permit_oldest_ms', 'recovered', 'info', 'queued', 'PENDING', now(), now()),
             (${id}, 'debounce_lane_full_ms', 'firing', 'error', 'old dead but last', 'DEAD', now() - interval '40 days', now() - interval '40 days'),
             (${id}, 'event_loop_p99_ms', 'firing', 'error', 'newest', 'DELIVERED', now(), now())`;
    expect(await pruneInstanceAlertDeliveries(appDb, 30)).toBe(2);
    expect((await deliveries()).map((r) => r.summary).sort()).toEqual([
      "newest",
      "old but last",
      "old but last heard",
      "old dead but last",
      "old pending",
      "queued",
      "recent",
    ]);
    // The kept row is still what that channel was last told: a signal firing past retention does
    // not page again, and its recovery is still owed.
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_200_000);
    await evaluateSample({ ingress_lag_p95_ms: 0 }, 9_205_000);
    expect(
      (await deliveries())
        .filter((r) => r.signal === "ingress_lag_p95_ms")
        .map((r) => r.kind),
    ).toEqual(["firing", "recovered"]);
  });
});

describe.skipIf(!dbUp)("the sampler", () => {
  beforeEach(async () => {
    await wipe();
    resetEvaluator(appDb);
    resetSamplerState();
  });

  test("a database read that hangs holds back neither the in-process samples nor their judgement (catches telemetry going dark during a database incident)", async () => {
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 10 },
      appDb,
    );
    let now = 30_000_000;
    let loop = 5;
    let release: () => void = () => {};
    let hang = false;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => loop,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => {
        if (hang) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return { kindAges: {}, chatwootPendingOldestMs: 0 };
      },
    };
    await sampleOnce(sources, { database: true });
    hang = true;
    loop = 500;
    const pending = tick(sources);
    expect(pending === null).toBe(false);
    for (let i = 0; i < 4; i++) {
      now += 5_000;
      expect(tick(sources)).toBeNull();
    }
    const series = snapshot(now).signals.find(
      (x) => x.signal === "event_loop_p99_ms",
    );
    expect(series?.history.map((p) => p.value)).toEqual([
      5, 500, 500, 500, 500, 500,
    ]);
    expect(firingSignals()).toEqual(["event_loop_p99_ms"]);
    release();
    await pending;
  });

  test("a database read that comes due while the previous one is still out runs with the next one that starts (catches queue signals that stop refreshing)", async () => {
    let reads = 0;
    let release: () => void = () => {};
    let hang = true;
    const sources: SamplerSources = {
      now: () => 35_000_000,
      eventLoopP99Ms: () => 5,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => {
        reads++;
        if (hang) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return { kindAges: {}, chatwootPendingOldestMs: 0 };
      },
    };
    // Tick 0 reads and hangs; ticks 1 to 3 find it busy, and tick 3 is the next one on the cadence.
    const first = tick(sources);
    for (let i = 0; i < 3; i++) expect(tick(sources)).toBeNull();
    hang = false;
    release();
    await first;
    expect(reads).toBe(1);
    // Tick 4 is off the cadence, but the read due at tick 3 never ran: this one carries it.
    await tick(sources);
    expect(reads).toBe(2);
  });

  test("a threshold raised between ticks judges the next reading against the new one (catches a page against the old limit)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 0 },
      appDb,
    );
    let now = 31_000_000;
    let loop = 5;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => loop,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => ({ kindAges: {}, chatwootPendingOldestMs: 0 }),
    };
    await sampleOnce(sources, { database: true });
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 1000, durationSeconds: 0 },
      appDb,
    );
    loop = 600;
    now += 5_000;
    await sampleOnce(sources, { database: true });
    now += 5_000;
    await sampleOnce(sources, { database: true });
    expect(firingSignals()).toEqual([]);
    expect(await deliveries()).toEqual([]);
  });

  test("the first tick is judged once the thresholds are read (catches a process reading never judged)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 0 },
      appDb,
    );
    resetEvaluator(appDb);
    await sampleOnce(
      {
        now: () => 32_000_000,
        eventLoopP99Ms: () => 500,
        modelPermitWaiters: () => 0,
        modelPermitOldestMs: () => 0,
        debounceLaneFullMs: () => 0,
        ingressLagP95Ms: () => 0,
        readDatabase: async () => ({
          kindAges: {},
          chatwootPendingOldestMs: 0,
        }),
      },
      { database: true },
    );
    expect((await deliveries()).map((r) => [r.signal, r.kind])).toEqual([
      ["event_loop_p99_ms", "firing"],
    ]);
  });

  test("a reading that arrives late never overrides a newer one (catches a stale tick paging after the dip)", async () => {
    await channel();
    await setInstanceThreshold(
      FLEET,
      "event_loop_p99_ms",
      { threshold: 200, durationSeconds: 0 },
      appDb,
    );
    let now = 33_000_000;
    let loop = 5;
    let release: () => void = () => {};
    let hang = false;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => loop,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => {
        if (hang) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return { kindAges: {}, chatwootPendingOldestMs: 0 };
      },
    };
    await sampleOnce(sources, { database: true });
    hang = true;
    loop = 500;
    now += 5_000;
    const late = tick(sources);
    hang = false;
    loop = 10;
    now += 5_000;
    expect(tick(sources)).toBeNull();
    release();
    await late;
    expect(await deliveries()).toEqual([]);
    expect(firingSignals()).toEqual([]);
  });

  test("before the first thresholds arrive, a late first tick does not stand in for a newer reading (catches a page for lag already gone)", async () => {
    await channel();
    resetEvaluator(appDb);
    let now = 33_500_000;
    let lag = 90_000;
    let release: () => void = () => {};
    let hang = true;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => 5,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => lag,
      readDatabase: async () => {
        if (hang) {
          await new Promise<void>((r) => {
            release = r;
          });
        }
        return { kindAges: {}, chatwootPendingOldestMs: 0 };
      },
    };
    const first = tick(sources);
    hang = false;
    lag = 0;
    now += 5_000;
    expect(tick(sources)).toBeNull();
    release();
    await first;
    expect(await deliveries()).toEqual([]);
    expect(firingSignals()).toEqual([]);
  });

  test("a judgement made against a changed threshold is dropped until judged again (catches a new channel paged against the old limit)", async () => {
    await channel([], "ops");
    let now = 34_000_000;
    let pending = 90_000;
    let withDb = true;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => 5,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => ({
        kindAges: {},
        chatwootPendingOldestMs: pending,
      }),
    };
    await sampleOnce(sources, { database: withDb });
    expect(firingSignals()).toEqual(["chatwoot_pending_oldest_ms"]);
    await setInstanceThreshold(
      FLEET,
      "chatwoot_pending_oldest_ms",
      { threshold: 120_000, durationSeconds: 0 },
      appDb,
    );
    const late = await channel([], "late");
    withDb = false;
    pending = 0;
    now += 5_000;
    await sampleOnce(sources, { database: withDb });
    expect(firingSignals()).toEqual([]);
    expect(
      (await deliveries()).filter(
        (r) => String(r.channelId) === String(late.id),
      ),
    ).toEqual([]);
  });

  test("each known pool's queue becomes its waiters signal, with in use, idle and the oldest wait beside it (catches a pool queue the screen cannot see)", async () => {
    const sources: SamplerSources = {
      now: () => 36_000_000,
      eventLoopP99Ms: () => 5,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      pools: () => [
        { name: "main", inUse: 30, idle: 0, waiting: 4, oldestWaitMs: 1_500 },
        { name: "ack", inUse: 1, idle: 3, waiting: 0, oldestWaitMs: 0 },
        // Not a pool the screen knows: no signal invented for it.
        { name: "t-other", inUse: 1, idle: 0, waiting: 9, oldestWaitMs: 9 },
      ],
      lockTimeoutsPerMinute: () => 3,
      readDatabase: async () => ({
        kindAges: {},
        chatwootPendingOldestMs: 0,
        debounceWaiters: 2,
      }),
    };
    const recorded = await sampleOnce(sources, { database: true });
    expect(recorded["pool_waiters:main"]).toBe(4);
    expect(recorded["pool_waiters:ack"]).toBe(0);
    expect(recorded.lock_timeouts_per_min).toBe(3);
    expect(recorded.debounce_waiters).toBe(2);
    expect(Object.keys(recorded).some((k) => k.includes("t-other"))).toBe(
      false,
    );
    const health = await readInstanceHealth(true, appDb, 36_000_000);
    expect(health.pools.main).toEqual({
      inUse: 30,
      idle: 0,
      waiting: 4,
      oldestWaitMs: 1_500,
    });
    expect(health.pools["t-other"]).toBeUndefined();
    // The checkpointer's pool opens on the first turn: until then it reads as empty, not as missing.
    expect(recorded["pool_waiters:checkpointer"]).toBe(0);
    expect(health.pools.checkpointer).toEqual({
      inUse: 0,
      idle: 0,
      waiting: 0,
      oldestWaitMs: 0,
    });
  });

  test("keeps one hour and starts empty after a reset (catches unbounded memory and a history that survives a restart)", async () => {
    let now = 10_000_000;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => 5,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => ({ kindAges: {}, chatwootPendingOldestMs: 0 }),
    };
    for (let i = 0; i < 800; i++) {
      await sampleOnce(sources, { database: false });
      now += 5_000;
    }
    const loop = snapshot(now).signals.find(
      (s) => s.signal === "event_loop_p99_ms",
    );
    // Read as of the first sample: points older than the hour must be gone from memory, not merely
    // filtered out of the latest read.
    const early = snapshot(10_000_000 + 60_000).signals.find(
      (s) => s.signal === "event_loop_p99_ms",
    );
    expect(early?.history).toEqual([]);
    expect(loop?.history.length).toBeLessThanOrEqual(HISTORY_MS / 5_000 + 1);
    expect(loop?.history[0]?.at).toBeGreaterThanOrEqual(now - HISTORY_MS);
    resetSamplerState();
    expect(snapshot(now).signals.every((s) => s.history.length === 0)).toBe(
      true,
    );
    // 800 samples, each evaluated against the database: past the default 5 s on a loaded machine, and
    // a timed-out loop would keep writing into the next test's sampler.
  }, 60_000);

  test("a signal whose read keeps failing is marked stale, a fresh one is not (catches an old reading shown as current)", async () => {
    let now = 20_000_000;
    let dbUp = true;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => 5,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => {
        if (!dbUp) throw new Error("pool exhausted");
        return { kindAges: {}, chatwootPendingOldestMs: 0 };
      },
    };
    await sampleOnce(sources, { database: true });
    dbUp = false;
    // Two database refreshes missed (30 s) is within the allowance; the fourth tick past it is not.
    for (let i = 0; i < 6; i++) {
      now += 5_000;
      await sampleOnce(sources, { database: true });
    }
    const stale = (h: Awaited<ReturnType<typeof readInstanceHealth>>) =>
      Object.fromEntries(h.signals.map((x) => [x.signal, x.stale]));
    let read = stale(await readInstanceHealth(true, appDb, now));
    expect(read.chatwoot_pending_oldest_ms).toBe(false);
    expect(read.event_loop_p99_ms).toBe(false);
    for (let i = 0; i < 4; i++) {
      now += 5_000;
      await sampleOnce(sources, { database: true });
    }
    read = stale(await readInstanceHealth(true, appDb, now));
    expect(read.chatwoot_pending_oldest_ms).toBe(true);
    expect(read.event_loop_p99_ms).toBe(false);
    // Still failing an hour later: the reading has left the chart but is still the last one, and old.
    for (let i = 0; i < 800; i++) {
      now += 5_000;
      await sampleOnce(sources, { database: true });
    }
    const late = await readInstanceHealth(true, appDb, now);
    const pending = late.signals.find(
      (x) => x.signal === "chatwoot_pending_oldest_ms",
    );
    expect(pending?.stale).toBe(true);
    expect(pending?.value).toBe(0);
    expect(pending?.history).toEqual([]);
    // A process that does not sample has nothing to call stale.
    read = stale(await readInstanceHealth(false, appDb, now));
    expect(read.chatwoot_pending_oldest_ms).toBe(false);
    // Over an hour of samples, each evaluated against the database (see the one-hour test).
  }, 60_000);

  test("a signal whose read has failed since boot is stale too, once its first refresh is overdue (catches a never-read signal shown as fine)", async () => {
    let now = 30_000_000;
    const sources: SamplerSources = {
      now: () => now,
      eventLoopP99Ms: () => 5,
      modelPermitWaiters: () => 0,
      modelPermitOldestMs: () => 0,
      debounceLaneFullMs: () => 0,
      ingressLagP95Ms: () => 0,
      readDatabase: async () => {
        throw new Error("pool exhausted");
      },
    };
    await sampleOnce(sources, { database: true });
    const of = async (signal: string) =>
      (await readInstanceHealth(true, appDb, now)).signals.find(
        (x) => x.signal === signal,
      );
    // Within the allowance: not yet overdue.
    expect((await of("chatwoot_pending_oldest_ms"))?.stale).toBe(false);
    for (let i = 0; i < 10; i++) {
      now += 5_000;
      await sampleOnce(sources, { database: true });
    }
    const pending = await of("chatwoot_pending_oldest_ms");
    expect(pending?.value).toBeNull();
    expect(pending?.stale).toBe(true);
    expect((await of("scheduler_queue_age_ms:shared"))?.stale).toBe(true);
    expect((await of("event_loop_p99_ms"))?.stale).toBe(false);
  });

  test("reads the oldest overdue job per kind from the database (catches a queue age taken from created_at)", async () => {
    const tenant = await suDb.tenant.create({
      data: { name: "IH", slug: `ih-${process.pid}-${Date.now()}` },
    });
    try {
      await suDb.$executeRaw`
        INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, run_at, payload, status, created_at, updated_at)
        VALUES (${tenant.id}, 'DEBOUNCE', ${`ih-${process.pid}`}, now() - interval '90 seconds', '{}'::jsonb,
                'PENDING', now() - interval '1 day', now())`;
      await suDb.$executeRaw`
        INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, run_at, payload, status, created_at, updated_at)
        VALUES (${tenant.id}, 'MEMORY_COMPACT', ${`ih-f-${process.pid}`}, now() + interval '1 hour', '{}'::jsonb,
                'PENDING', now() - interval '1 day', now())`;
      await suDb.$executeRaw`
        INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, run_at, payload, status, created_at, updated_at)
        VALUES (${tenant.id}, 'DEBOUNCE', ${`ih-d-${process.pid}`}, now() + interval '1 hour', '{}'::jsonb,
                'PENDING', now() - interval '1 day', now())`;
      const read = await readDatabaseSignals(appDb);
      expect(read.kindAges.DEBOUNCE).toBeGreaterThanOrEqual(89_000);
      expect(read.kindAges.DEBOUNCE).toBeLessThan(3_600_000);
      // A job not yet due is not late, however old its row.
      expect(read.kindAges.MEMORY_COMPACT).toBeUndefined();
      // The due, unclaimed debounce flush is one burst waiting for a slot; the future job is not.
      expect(read.debounceWaiters).toBe(1);
    } finally {
      await suDb.tenant.delete({ where: { id: tenant.id } });
    }
  });
});

describe.skipIf(!dbUp)("the MCP tools", () => {
  beforeEach(wipe);

  const tenantToken = {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN" as const,
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
  const fleetToken = {
    userId: 1n,
    tenantId: null,
    role: "SUPER_ADMIN" as const,
    scopes: ["mcp:read", "mcp:write", "mcp:admin"],
    clientId: "c",
    jti: "j",
  };

  test("a channel created over MCP carries no URL or secret, stays off, and is filled from the link (catches a secret routed through the transcript)", async () => {
    // A URL handed to the tool is refused, not dropped: the channel is not created as if it had
    // been taken.
    const refused = await instanceAlertChannelCreate(
      fleetToken,
      {
        name: "ops",
        type: "webhook",
        url: "https://hooks.example/x",
        dry_run: false,
      },
      { base: appDb },
    );
    expect(refused.ok).toBe(false);
    expect(await listInstanceAlertChannels(appDb)).toEqual([]);
    const preview = await instanceAlertChannelCreate(
      fleetToken,
      { name: "ops", type: "webhook" },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    expect(await listInstanceAlertChannels(appDb)).toEqual([]);
    const res = await instanceAlertChannelCreate(
      fleetToken,
      { name: "ops", type: "webhook", dry_run: false },
      { base: appDb },
    );
    if (!res.ok) throw new Error(res.error);
    const channel = res.data.channel as { id: string; urlMasked: unknown };
    expect(channel.urlMasked).toBeNull();
    expect(String(res.data.fillAt)).toContain(
      `/admin/instance-health?fill=${channel.id}`,
    );
    const id = BigInt(channel.id);
    // Waiting for its URL: it cannot be turned on, tested, or handed an alert.
    await expect(
      updateInstanceAlertChannel(FLEET, id, { enabled: true }, appDb),
    ).rejects.toThrow(/no URL yet/);
    const enable = await instanceAlertChannelUpdate(
      fleetToken,
      { id: channel.id, enabled: true, dry_run: false },
      { base: appDb },
    );
    expect(enable.ok).toBe(false);
    // The preview refuses it too, instead of asking to approve a change the apply refuses.
    const enablePreview = await instanceAlertChannelUpdate(
      fleetToken,
      { id: channel.id, enabled: true },
      { base: appDb },
    );
    expect(enablePreview.ok).toBe(false);
    const renamePreview = await instanceAlertChannelUpdate(
      fleetToken,
      { id: channel.id, name: "ops 2" },
      { base: appDb },
    );
    expect(renamePreview.ok).toBe(true);
    await expect(sendInstanceAlertChannelTest(id, appDb)).rejects.toThrow(
      /no URL yet/,
    );
    resetEvaluator(appDb);
    await evaluateSample({ ingress_lag_p95_ms: 90_000 }, 9_500_000);
    expect(await deliveries()).toEqual([]);
    // A row switched on around the service, with an alert queued for it, is still never claimed:
    // there is nowhere to send it.
    await suDb.$executeRaw`UPDATE instance_alert_channels SET enabled = true WHERE id = ${id}`;
    await suDb.$executeRaw`
      INSERT INTO instance_alert_deliveries (channel_id, signal, kind, level, summary, created_at, updated_at)
      VALUES (${id}, 'ingress_lag_p95_ms', 'firing', 'error', 's', now() - interval '1 hour', now())`;
    const batch = await processInstanceAlertBatch({
      base: appDb,
      coalesceWindowMs: 0,
    });
    expect(batch.claimed).toBe(0);
    await suDb.$executeRaw`DELETE FROM instance_alert_deliveries`;
    await suDb.$executeRaw`UPDATE instance_alert_channels SET enabled = false WHERE id = ${id}`;
    // The console fills it: URL and enabled together.
    const filled = await updateInstanceAlertChannel(
      FLEET,
      id,
      { url: outboundUrl("/filled"), enabled: true },
      appDb,
    );
    expect(filled.urlMasked).not.toBeNull();
    expect(filled.enabled).toBe(true);
  });

  test("a tenant token is refused (catches the fleet's load answered to a tenant)", async () => {
    const res = await instanceHealthGet(tenantToken, { base: appDb });
    expect(JSON.stringify(res)).toContain("insufficient_scope");
    const forged = await instanceHealthGet(
      { ...tenantToken, scopes: ["mcp:admin"] },
      { base: appDb },
    );
    expect(JSON.stringify(forged)).toContain("forbidden");
  });

  test("a preview refuses what the apply would refuse (catches approving a change that cannot happen)", async () => {
    const c = await channel();
    const emptyName = await instanceAlertChannelUpdate(
      fleetToken,
      { id: c.id, name: "" },
      { base: appDb },
    );
    expect(emptyName.ok).toBe(false);
    const nothing = await instanceAlertChannelUpdate(
      fleetToken,
      { id: c.id },
      { base: appDb },
    );
    expect(nothing.ok).toBe(false);
    const tooBig = await instanceThresholdSet(
      fleetToken,
      { signal: "event_loop_p99_ms", threshold: 86_400_001 },
      { base: appDb },
    );
    expect(tooBig.ok).toBe(false);
  });

  test("writes preview by default and apply only with dry_run false (catches a threshold changed by a preview)", async () => {
    const preview = await instanceThresholdSet(
      fleetToken,
      { signal: "event_loop_p99_ms", threshold: 42 },
      { base: appDb },
    );
    expect(JSON.stringify(preview)).toContain("dryRun");
    expect(
      (await listInstanceThresholds(appDb)).find(
        (t) => t.signal === "event_loop_p99_ms",
      )?.isDefault,
    ).toBe(true);
    await instanceThresholdSet(
      fleetToken,
      { signal: "event_loop_p99_ms", threshold: 42, dry_run: false },
      { base: appDb },
    );
    expect(
      (await listInstanceThresholds(appDb)).find(
        (t) => t.signal === "event_loop_p99_ms",
      )?.threshold,
    ).toBe(42);
    const c = await channel();
    await instanceAlertChannelUpdate(
      fleetToken,
      { id: c.id, enabled: false },
      { base: appDb },
    );
    expect((await listInstanceAlertChannels(appDb))[0]?.enabled).toBe(true);
  });
});
