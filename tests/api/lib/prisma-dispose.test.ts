import { describe, expect, test } from "bun:test";
import { Pool } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";

// The main, ack and metrics clients are built on pools this repo creates (so the instance health
// sampler can read their queues), and `$disconnect` must still end them: a script that disconnects
// and finds its sockets still open waits out the idle timeout before it exits. Run in a child process
// so this file's own clients, shared with the rest of the run, stay up.

const url = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
if (url) {
  const probe = new Pool({ connectionString: url, max: 1 });
  try {
    await probe.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  } finally {
    await probe.end();
  }
}

const SCRIPT = `
import prisma from "@/api/lib/prisma";
import ackPrisma from "@/api/lib/prisma-ack";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { poolStats } from "@/lib/pool-stats";
for (const c of [prisma, ackPrisma, metricsPrisma]) {
  await c.$queryRawUnsafe("SELECT 1");
  await c.$disconnect();
}
const open = poolStats()
  .filter((s) => ["main", "ack", "metrics"].includes(s.name))
  .map((s) => [s.name, s.inUse + s.idle]);
console.log(JSON.stringify(Object.fromEntries(open)));
`;

describe.skipIf(!dbUp)("disconnecting the app's clients", () => {
  test("ends the pools the app builds for them (catches a script left holding sockets after $disconnect)", async () => {
    const child = Bun.spawn(["bun", "-e", SCRIPT], {
      env: { ...process.env, DATABASE_URL: url },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(await child.exited, err).toBe(0);
    const line = out.trim().split("\n").at(-1) ?? "";
    expect(JSON.parse(line)).toEqual({ main: 0, ack: 0, metrics: 0 });
  }, 60_000);
});
