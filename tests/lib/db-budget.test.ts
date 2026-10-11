import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import config from "@/config";
import {
  assertConnectionBudget,
  ConnectionBudgetError,
  type PoolShare,
  poolShares,
  readServerLimits,
  serverOf,
} from "@/lib/db-budget";

// The sum of a replica's pools against what each database server accepts from the runtime role.

const MAIN = "postgres://app:x@db.internal:5432/agents";
const OTHER = "postgres://app:x@checkpoints.internal:6543/langgraph";

function shares(main: number, langgraph: number, url = MAIN): PoolShare[] {
  return [
    { env: "DB_POOL_MAX", size: main, url: MAIN },
    { env: "LANGGRAPH_POOL_MAX", size: langgraph, url },
    { env: "CHATWOOT_ACK_POOL_MAX", size: 4, url: MAIN },
    { env: "METRICS_POOL_MAX", size: 3, url: MAIN },
  ];
}

const limits = (byServer: Record<string, number>) => async (url: string) => {
  const host = new URL(url).hostname;
  return { maxConnections: byServer[host] ?? 0, reserved: 3 };
};

describe("connection budget", () => {
  test("a sum equal to what the server accepts fits, one more is refused naming every pool", async () => {
    // 45 + 45 + 4 + 3 = 97 = 100 - 3 reserved
    const fit = await assertConnectionBudget(
      shares(45, 45),
      limits({ "db.internal": 100 }),
    );
    expect(fit.map((l) => l.line)).toEqual([
      "db.internal:5432: 97 of 97 connections (DB_POOL_MAX=45, LANGGRAPH_POOL_MAX=45, CHATWOOT_ACK_POOL_MAX=4, METRICS_POOL_MAX=3)",
    ]);

    const err = await assertConnectionBudget(
      shares(46, 45),
      limits({ "db.internal": 100 }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionBudgetError);
    expect(err.message).toContain("98 connections to db.internal:5432");
    expect(err.message).toContain("accepts 97");
    for (const v of [
      "DB_POOL_MAX=46",
      "LANGGRAPH_POOL_MAX=45",
      "CHATWOOT_ACK_POOL_MAX=4",
      "METRICS_POOL_MAX=3",
    ]) {
      expect(err.message).toContain(v);
    }
  });

  test("the background pool counts in the main server's sum, and a value one over refuses naming it", async () => {
    const saved = config.backgroundPoolMax;
    config.backgroundPoolMax = 7;
    try {
      const pools = poolShares();
      const background = pools.find((p) => p.env === "BACKGROUND_POOL_MAX");
      expect(background?.size).toBe(7);
      expect(background?.url).toBe(config.databaseUrl ?? "");
      const main = serverOf(config.databaseUrl ?? "");
      const sum = pools
        .filter((p) => serverOf(p.url) === main)
        .reduce((n, p) => n + p.size, 0);
      const exactly = await assertConnectionBudget(pools, async () => ({
        maxConnections: sum + 3,
        reserved: 3,
      }));
      expect(exactly[0]?.line).toContain("BACKGROUND_POOL_MAX=7");
      const err = await assertConnectionBudget(pools, async () => ({
        maxConnections: sum + 2,
        reserved: 3,
      })).catch((e) => e);
      expect(err).toBeInstanceOf(ConnectionBudgetError);
      expect(err.message).toContain("BACKGROUND_POOL_MAX=7");
    } finally {
      config.backgroundPoolMax = saved;
    }
  });

  test("each server is judged by its own pools: a checkpointer on another server leaves the main sum", async () => {
    // Main: 90 + 4 + 3 = 97, fits 97. The checkpointer's 17 would push one global sum past it, and
    // fits the 17 its own server accepts.
    const fit = await assertConnectionBudget(
      shares(90, 17, OTHER),
      limits({ "db.internal": 100, "checkpoints.internal": 20 }),
    );
    expect(fit).toHaveLength(2);

    const err = await assertConnectionBudget(
      shares(10, 18, OTHER),
      limits({ "db.internal": 100, "checkpoints.internal": 20 }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ConnectionBudgetError);
    expect(err.message).toContain("checkpoints.internal:6543");
    expect(err.message).toContain("LANGGRAPH_POOL_MAX=18");
    expect(err.message).not.toContain("DB_POOL_MAX=10");
  });

  test("a server that does not answer is reported unchecked, and does not hide another server's refusal", async () => {
    const down = async (url: string) => {
      if (new URL(url).hostname === "checkpoints.internal") {
        throw new Error("connect ECONNREFUSED");
      }
      return { maxConnections: 100, reserved: 3 };
    };
    const fit = await assertConnectionBudget(shares(10, 10, OTHER), down);
    expect(fit.map((l) => [l.server, l.checked])).toEqual([
      ["db.internal:5432", true],
      ["checkpoints.internal:6543", false],
    ]);

    const err = await assertConnectionBudget(shares(91, 10, OTHER), down).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ConnectionBudgetError);
    expect(err.message).toContain("DB_POOL_MAX=91");
  });

  test("a URL that does not parse is never echoed into the log, password included", async () => {
    const bad = "postgres://app:s3cret-pass@db.internal:54x2/agents";
    const lines = await assertConnectionBudget(
      [{ env: "DB_POOL_MAX", size: 10, url: bad }],
      async () => {
        throw new Error(`could not connect to ${bad}`);
      },
    );
    const logged = lines.map((l) => `${l.server} ${l.line}`).join("\n");
    expect(logged).not.toContain("s3cret-pass");
    expect(lines[0]?.checked).toBe(false);
  });

  test("a server that drops the connection mid-read is a server not read, not a crash", async () => {
    // What `pg` does when the server goes away after connecting: the pending query rejects and the
    // client emits `error` from the socket's handler, where nothing up the stack catches it. An
    // `error` with no listener is thrown from there, so the read must listen before it queries.
    let listening = 0;
    const client = Object.assign(new EventEmitter(), {
      connect: async () => {},
      end: async () => {},
      query: () => {
        listening = client.listenerCount("error");
        const dropped = new Error("Connection terminated unexpectedly");
        if (listening > 0) client.emit("error", dropped);
        return Promise.reject(dropped);
      },
    });
    const read = readServerLimits(MAIN, () => client as never);
    await expect(read).rejects.toThrow("Connection terminated unexpectedly");
    expect(listening).toBeGreaterThan(0);
  });
});
