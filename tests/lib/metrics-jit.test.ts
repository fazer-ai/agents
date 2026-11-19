import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool, type PoolConfig } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { metricsPoolOptions, runtimePoolOptions } from "@/api/lib/pool-options";
import { dbProbeFailed } from "@/tests/db-gate";
import { withJitOffInUrl } from "@/tests/db-jit";

// A metrics read compiles nothing on a server with the JIT available and on, whatever its cost: the
// metrics pool turns the JIT off for its sessions, and the suite's own clients, which the tests call
// the metrics readers on, do the same. A plan EXPLAIN shows with a `JIT` entry is one the JIT would
// compile; `jit_above_cost` at zero makes every plan cross the threshold, so the absence of the entry
// is the setting and not a cheap plan.

const appUrl = process.env.TEST_APP_DATABASE_URL;

// The URL a server default reaches a session through: the JIT asked for on, as a server whose `jit`
// is on hands it to every new session.
function jitOn(url: string): string {
  const u = new URL(url);
  u.searchParams.set("options", "-c jit=on");
  return u.toString();
}

let dbUp = false;
let jitAvailable = false;
let probe: PrismaClient | undefined;
if (appUrl) {
  try {
    probe = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await probe.$queryRaw`SELECT 1`;
    dbUp = true;
    // `pg_jit_available()` answers false in a session with the JIT off, as the suite's are.
    const on = new Pool({ connectionString: jitOn(appUrl), max: 1 });
    try {
      const { rows } = await on.query<{ available: boolean }>(
        "SELECT pg_jit_available() AS available",
      );
      jitAvailable = Boolean(rows[0]?.available);
    } finally {
      await on.end();
    }
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

afterAll(async () => {
  await probe?.$disconnect();
});

async function compiles(options: PoolConfig): Promise<{
  jit: string;
  planned: boolean;
}> {
  const pool = new Pool({ ...options, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL jit_above_cost = 0");
    const { rows } = await client.query<{ jit: string }>(
      "SELECT current_setting('jit') AS jit",
    );
    const plan = await client.query<{ "QUERY PLAN": unknown[] }>(
      "EXPLAIN (FORMAT JSON) SELECT sum(g) FROM generate_series(1, 1000) AS g",
    );
    await client.query("COMMIT");
    const [top] = plan.rows[0]?.["QUERY PLAN"] ?? [];
    return {
      jit: rows[0]?.jit ?? "",
      planned: Boolean(top && typeof top === "object" && "JIT" in top),
    };
  } finally {
    client.release();
    await pool.end();
  }
}

describe("the JIT on the metrics reads", () => {
  test("the suite's database URLs ask for it off, beside an options they already carry", () => {
    expect(
      new URL(withJitOffInUrl("postgres://u:p@h:5432/db")).searchParams.get(
        "options",
      ),
    ).toBe("-c jit=off");
    expect(
      new URL(
        withJitOffInUrl(
          "postgres://u:p@h:5432/db?options=-c%20TimeZone%3DUTC&sslmode=disable",
        ),
      ).searchParams.get("options"),
    ).toBe("-c TimeZone=UTC -c jit=off");
    const once = withJitOffInUrl("postgres://u:p@h:5432/db");
    expect(withJitOffInUrl(once)).toBe(once);
  });

  test.skipIf(!dbUp)("a suite client's session has it off", async () => {
    const [row] = await (probe as PrismaClient).$queryRaw<{ jit: string }[]>`
      SELECT current_setting('jit') AS jit`;
    expect(row?.jit).toBe("off");
  });

  test.skipIf(!dbUp)(
    "the metrics pool turns it off over a server that has it on",
    async () => {
      const out = await compiles(metricsPoolOptions(jitOn(appUrl as string)));
      expect(out).toEqual({ jit: "off", planned: false });
    },
  );

  // The control: the same plan on a runtime pool, which leaves the server's setting alone, is one the
  // JIT compiles, so the read above was given a plan it would have compiled.
  test.skipIf(!dbUp || !jitAvailable)(
    "a pool that leaves the server's setting compiles the same plan",
    async () => {
      const out = await compiles(
        runtimePoolOptions(jitOn(appUrl as string), 1),
      );
      expect(out).toEqual({ jit: "on", planned: true });
    },
  );
});
