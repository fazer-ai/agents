import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { Pool } from "pg";
import {
  CONNECT_TIMEOUT_MS,
  connectTimeoutOption,
} from "@/api/lib/pool-options";
import "@/api/lib/prisma";
import config from "@/config";
import { getCheckpointer } from "@/graph/checkpointer";
import { registeredPool } from "@/lib/pool-stats";
import { until } from "@/tests/utils/poll";

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
      expect(String(failure)).toMatch(/timeout/i);
    } finally {
      for (const s of sockets) s.destroy();
      await pool.end();
    }
  });

  test("still waits, past the connect bound, for a free client when it is at max", async () => {
    const appUrl = process.env.TEST_APP_DATABASE_URL;
    if (!appUrl) throw new Error("TEST_APP_DATABASE_URL is not set");
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

describe("a pool given its password as an option", () => {
  // `pg-pool` keeps a password passed as an option non-enumerable, so a client that copied its config
  // by spreading it would connect with none.
  test("still authenticates through the bounded client", async () => {
    const appUrl = process.env.TEST_APP_DATABASE_URL;
    if (!appUrl) throw new Error("TEST_APP_DATABASE_URL is not set");
    const url = new URL(appUrl);
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

describe("the runtime's pools", () => {
  test.each([["main"], ["background"], ["checkpointer"]])(
    "%s bounds its connect and not its queue",
    async (name) => {
      if (name === "checkpointer") await getCheckpointer();
      const pool = registeredPool(name);
      if (!pool) throw new Error(`no pool registered as ${name}`);
      const options = (
        pool as unknown as {
          options: {
            Client?: { connectTimeoutMs?: number };
            connectionTimeoutMillis?: number;
          };
        }
      ).options;
      expect(options.Client?.connectTimeoutMs).toBe(CONNECT_TIMEOUT_MS);
      expect(options.connectionTimeoutMillis ?? 0).toBe(0);
    },
  );
});

describe("the checkpointer after a failed setup", () => {
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
