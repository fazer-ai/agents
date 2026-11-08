import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Pool } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";

// A Postgres restart sends 57P01 to every connection, and a connection idle in a pool has no query to
// reject: the error arrives as an `error` event, and one nobody listens to ends the process. The
// harness kills the idle connection of every pool the app opens, twice, in a process of its own, so
// a crash is a dead child and not a dead test runner.

const HARNESS = join(import.meta.dir, "../fixtures/pool-terminate/harness.ts");
const POOLS = [
  "main",
  "background",
  "ack",
  "metrics",
  "instance-health",
  "checkpointer",
];

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
if (appUrl && suUrl) {
  const probe = new Pool({ connectionString: suUrl, max: 1 });
  try {
    await probe.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  } finally {
    await probe.end();
  }
}

type LogLine = {
  level?: number;
  msg?: string;
  pool?: string;
  sqlstate?: string;
};

async function runHarness(): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(["bun", HARNESS], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      DATABASE_URL: appUrl,
      LANGGRAPH_DATABASE_URL: appUrl,
      MIGRATION_DATABASE_URL: suUrl,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

describe.skipIf(!dbUp)("an idle pool connection the server terminates", () => {
  test("leaves the process up, logs a warn naming the pool and the SQLSTATE, and the pool's next query opens a new connection (catches an unhandled `error` event ending the process)", async () => {
    const { code, out } = await runHarness();
    expect({ code, tail: out.slice(-600) }).toMatchObject({ code: 0 });

    const result = out.split("\n").find((l) => l.startsWith("HARNESS result "));
    const { rounds, checkedOut } = JSON.parse(
      (result ?? "").slice("HARNESS result ".length),
    ) as {
      rounds: Record<string, number>[];
      checkedOut: { heldPid: number; heldFailed: boolean; after: number };
    };
    expect(rounds).toHaveLength(3);
    for (const name of POOLS) {
      const pids = rounds.map((r) => r[name]);
      expect({ name, pids: pids.every((p) => (p ?? 0) > 0) }).toEqual({
        name,
        pids: true,
      });
      expect({ name, distinct: new Set(pids).size }).toEqual({
        name,
        distinct: 3,
      });
    }

    const warns = out
      .split("\n")
      .filter((l) => l.startsWith("{"))
      .map((l) => JSON.parse(l) as LogLine)
      .filter((l) => l.level === 40 && l.sqlstate === "57P01");
    for (const name of POOLS) {
      expect({
        name,
        warns: warns.filter((l) => l.pool === name).length,
      }).toEqual({ name, warns: name === "checkpointer" ? 3 : 2 });
    }

    // The connection held inside a transaction: its next statement fails, as it must, and the pool
    // hands out a new connection after it is released.
    expect(checkedOut.heldFailed).toBe(true);
    expect(checkedOut.after).toBeGreaterThan(0);
    expect(checkedOut.after).not.toBe(checkedOut.heldPid);
  }, 60_000);
});
