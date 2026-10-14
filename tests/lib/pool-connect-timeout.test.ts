import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  CONNECT_TIMEOUT_MS,
  connectTimeoutOption,
  DatabaseConnectTimeout,
  runtimePoolOptions,
} from "@/api/lib/pool-options";
import config from "@/config";
import { getCheckpointer } from "@/graph/checkpointer";
import {
  isDatabaseUnavailable,
  isTransactionNeverStarted,
} from "@/lib/pool-retry";
import { registeredPool } from "@/lib/pool-stats";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";

// The cases that need the test database skip under the db-gate's opt-out, as every integration suite
// does; the stalled-server and option cases run either way.
const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
if (appUrl) {
  const probe = new Pool({ connectionString: appUrl, max: 1 });
  try {
    await probe.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  } finally {
    await probe.end();
  }
}

// A connect that never completes, from a server that accepts the TCP connection and never answers:
// the shape a stalled network or a wedged Postgres takes. Bound to 127.0.0.1 and an address the
// system picks while something listens on it, so the client cannot end up connected to itself.
let server: Server;
let stalledPort = 0;
const sockets = new Set<Socket>();

beforeAll(async () => {
  server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  stalledPort = (server.address() as { port: number }).port;
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise((r) => server.close(r));
});

const stalledPool = (ms: number) =>
  new Pool({
    host: "127.0.0.1",
    port: stalledPort,
    user: "nobody",
    database: "nothing",
    max: 1,
    ...connectTimeoutOption(ms),
  });

describe("a pool built with connectTimeoutOption", () => {
  test("fails a connect that never completes instead of waiting on it", async () => {
    const pool = stalledPool(100);
    let failure: unknown;
    pool.connect().then(
      (c) => c.release(),
      (e) => {
        failure = e;
      },
    );
    try {
      // A deadline of its own, so a connect left unbounded fails here instead of hanging the file.
      await until("the connect to fail on its bound", () => failure, {
        deadlineMs: 5_000,
      });
      // The checkpointer meets this error as `pg` gives it, with no Prisma around it.
      expect(failure).toBeInstanceOf(DatabaseConnectTimeout);
      expect(isTransactionNeverStarted(failure)).toBe(true);
    } finally {
      for (const s of sockets) s.destroy();
      await pool.end();
    }
  });
});

describe.skipIf(!dbUp)("a bounded pool at max, on the real database", () => {
  test("still waits, past the connect bound, for a free client when it is at max", async () => {
    const pool = new Pool({
      connectionString: appUrl,
      max: 1,
      ...connectTimeoutOption(100),
    });
    const stalled = stalledPool(100);
    try {
      // The first client is a real connect under the same short bound, which a loaded runner can miss:
      // asked again until one lands, since what is measured here is the queue, not this connect.
      const held = await until(
        "a first client of the real database",
        () => pool.connect().catch(() => null),
        { deadlineMs: 10_000 },
      );
      let queuedSettled = false;
      const queued = pool.connect();
      queued.then(
        () => {
          queuedSettled = true;
        },
        () => {
          queuedSettled = true;
        },
      );
      // Asked after the queued request, so by the time it fails on its bound the queued request has
      // waited at least as long.
      let stalledFailed = false;
      stalled.connect().catch(() => {
        stalledFailed = true;
      });
      await until(
        "the stalled connect to fail on its bound",
        () => stalledFailed,
        { deadlineMs: 5_000 },
      );
      expect(queuedSettled).toBe(false);
      held.release();
      const next = await queued;
      next.release();
    } finally {
      await pool.end();
      await stalled.end();
    }
  });
});

test("a connect past its bound reads as an unavailable database through the Prisma adapter", async () => {
  // What a caller sees: the adapter's error, which isDatabaseUnavailable must take for a database that
  // could not be reached, so the work is rescheduled instead of failed.
  const pool = stalledPool(100);
  const client = new PrismaClient({
    adapter: new PrismaPg(pool, { disposeExternalPool: true }),
  });
  let failure: unknown;
  client.$queryRaw`SELECT 1`.then(
    () => {},
    (e) => {
      failure = e;
    },
  );
  try {
    await until("the query to fail on the connect bound", () => failure, {
      deadlineMs: 5_000,
    });
    expect(isDatabaseUnavailable(failure)).toBe(true);
    // And as a transaction that never started: a turn that met it before any tool ran is retried by
    // the delivery's recovery, not announced as failed.
    expect(isTransactionNeverStarted(failure)).toBe(true);
  } finally {
    for (const s of sockets) s.destroy();
    await client.$disconnect();
  }
});

test("the same socket code from anything but Prisma is not a database outage", () => {
  // A Chatwoot request that cannot connect fails with these codes too, and its failure is the
  // account's, not the database's.
  for (const code of ["ETIMEDOUT", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND"]) {
    expect(
      isDatabaseUnavailable(Object.assign(new Error(code), { code })),
    ).toBe(false);
  }
});

test("a bound that is not a positive number of ms is refused, since pg reads 0 as none", () => {
  expect(() => connectTimeoutOption(0)).toThrow(/positive/);
  expect(() => connectTimeoutOption(Number.NaN)).toThrow(/positive/);
});

describe.skipIf(!dbUp)("a pool given its password as an option", () => {
  // `pg-pool` keeps a password passed as an option non-enumerable, so a client that copied its config
  // by spreading it would connect with none.
  test("still authenticates through the bounded client", async () => {
    const url = new URL(appUrl ?? "");
    const password = decodeURIComponent(url.password);
    if (!password) throw new Error("the test database URL carries no password");
    const pool = new Pool({
      host: url.hostname,
      port: Number(url.port),
      user: decodeURIComponent(url.username),
      database: url.pathname.slice(1),
      password,
      max: 1,
      ...connectTimeoutOption(),
    });
    try {
      const { rows } = await pool.query<{ one: number }>("SELECT 1 AS one");
      expect(rows[0]?.one).toBe(1);
    } finally {
      await pool.end();
    }
  });
});

// What the main, background and checkpointer pools are built with. Read from the builder, not from
// the pools: other files in the same process mock ./prisma, and then the real pools never exist here.
// That each site builds through it is held by require-pool-connect-bound, which refuses an inline
// options object with no bound.
describe("the runtime's pool options", () => {
  test("bound the connect at 10 s and not the queue", () => {
    const options = runtimePoolOptions("postgresql://x@127.0.0.1/y", 3) as {
      Client?: { connectTimeoutMs?: number };
      connectionTimeoutMillis?: number;
      max?: number;
    };
    // The value the deploy documents, written out: compared with the constant, a constant set to 0
    // (no limit) would agree with itself.
    expect(options.Client?.connectTimeoutMs).toBe(10_000);
    expect(CONNECT_TIMEOUT_MS).toBe(10_000);
    expect(options.connectionTimeoutMillis ?? 0).toBe(0);
    expect(options.max).toBe(3);
  });
});

describe.skipIf(!dbUp)("the checkpointer's pool", () => {
  test("is built with the runtime's pool options", async () => {
    await getCheckpointer();
    const pool = registeredPool("checkpointer");
    if (!pool) throw new Error("no pool registered as checkpointer");
    const options = (
      pool as unknown as {
        options: {
          Client?: { connectTimeoutMs?: number };
          connectionTimeoutMillis?: number;
        };
      }
    ).options;
    expect(options.Client?.connectTimeoutMs).toBe(10_000);
    expect(options.connectionTimeoutMillis ?? 0).toBe(0);
  });
});

describe.skipIf(!dbUp)("the checkpointer after a failed setup", () => {
  test("is built again on the next call, not kept failed until a restart", async () => {
    const key = Symbol.for("fazerai.langgraph.checkpointer");
    const g = globalThis as unknown as Record<symbol, unknown>;
    const kept = g[key];
    const url = config.langgraphDatabaseUrl;
    try {
      g[key] = {};
      // Nothing listens on port 1: the connect is refused at once, which fails the setup the way a
      // connect past its bound does, without waiting for the bound.
      config.langgraphDatabaseUrl = "postgresql://nobody@127.0.0.1:1/nothing";
      await expect(getCheckpointer()).rejects.toThrow();
      config.langgraphDatabaseUrl = url;
      const saver = await getCheckpointer();
      expect(
        await saver.getTuple({ configurable: { thread_id: "none" } }),
      ).toBeUndefined();
    } finally {
      config.langgraphDatabaseUrl = url;
      g[key] = kept;
    }
  });
});
