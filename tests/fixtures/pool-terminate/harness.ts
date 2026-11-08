import { Client } from "pg";
import prisma from "@/api/lib/prisma";
import ackPrisma from "@/api/lib/prisma-ack";
import instanceHealthPrisma from "@/api/lib/prisma-instance-health";
import metricsPrisma from "@/api/lib/prisma-metrics";
import { getCheckpointPool } from "@/graph/checkpointer";
import { runInPoolClass } from "@/lib/pool-class";
import { until } from "../../utils/poll";

// Every pool the app opens, each reached the way the app reaches it, with its connection killed by
// `pg_terminate_backend` while it sits idle in the pool, twice, and then one held inside a transaction. No `uncaughtException` listener on
// purpose: an `error` event nobody handles ends this process, which is what the driving test reads.
// Driven by tests/lib/pool-terminate.test.ts. Prints one `HARNESS result <json>` line and exits 0.
// The work runs in `main()`, never under a top-level await: Bun reports an exception thrown while a
// top-level await is pending and keeps going, which would hide the very crash this harness detects.

type Pid = { pid: number };
const POOLS: Record<string, () => Promise<number>> = {
  main: async () =>
    (await prisma.$queryRaw<Pid[]>`SELECT pg_backend_pid() AS pid`)[0]?.pid ??
    -1,
  background: () =>
    runInPoolClass(
      "background",
      async () =>
        (await prisma.$queryRaw<Pid[]>`SELECT pg_backend_pid() AS pid`)[0]
          ?.pid ?? -1,
    ),
  ack: async () =>
    (await ackPrisma.$queryRaw<Pid[]>`SELECT pg_backend_pid() AS pid`)[0]
      ?.pid ?? -1,
  metrics: async () =>
    (await metricsPrisma.$queryRaw<Pid[]>`SELECT pg_backend_pid() AS pid`)[0]
      ?.pid ?? -1,
  "instance-health": async () =>
    (
      await instanceHealthPrisma.$queryRaw<
        Pid[]
      >`SELECT pg_backend_pid() AS pid`
    )[0]?.pid ?? -1,
  checkpointer: async () =>
    (
      await (
        await getCheckpointPool()
      ).query<Pid>("SELECT pg_backend_pid() AS pid")
    ).rows[0]?.pid ?? -1,
};

const su = new Client({ connectionString: process.env.MIGRATION_DATABASE_URL });

// The backends whose client has emitted its `error`, read off `pg`'s Client, which every pool here
// builds its connections from. Observation only: the event goes on to whatever listens, or to nobody.
const errored = new Set<number>();
const emit = Client.prototype.emit;
Client.prototype.emit = function (
  this: Client & { processID?: number },
  event: string | symbol,
  ...args: unknown[]
) {
  if (event === "error" && this.processID) errored.add(this.processID);
  return emit.call(this, event, ...args);
};

async function terminateAll(pids: number[]): Promise<void> {
  await su.query("SELECT pg_terminate_backend(p) FROM unnest($1::int[]) p", [
    pids,
  ]);
  await until("every terminated connection to report its error", () =>
    pids.every((pid) => errored.has(pid)),
  );
}

async function main(): Promise<void> {
  await su.connect();
  const rounds: Record<string, number>[] = [];
  for (let round = 0; round < 3; round++) {
    const pids: Record<string, number> = {};
    for (const [name, read] of Object.entries(POOLS)) pids[name] = await read();
    rounds.push(pids);
    if (round < 2) await terminateAll(Object.values(pids));
  }
  // A connection checked out and idle inside a transaction, the shape of the checkpoint sweeps:
  // the pool's idle listener is off it, so only a listener on the client keeps the process up.
  const pool = await getCheckpointPool();
  const held = await pool.connect();
  await held.query("BEGIN");
  const heldPid = (await held.query<Pid>("SELECT pg_backend_pid() AS pid"))
    .rows[0]?.pid as number;
  await terminateAll([heldPid]);
  const heldFailed = await held.query("SELECT 1").then(
    () => false,
    () => true,
  );
  held.release(true);
  const after = (await pool.query<Pid>("SELECT pg_backend_pid() AS pid"))
    .rows[0]?.pid;
  const checkedOut = { heldPid, heldFailed, after };
  console.log(`HARNESS result ${JSON.stringify({ rounds, checkedOut })}`);
  await su.end();
  process.exit(0);
}

void main();
