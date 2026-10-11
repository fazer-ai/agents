import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { routeByPoolClass } from "@/api/lib/prisma";
import { runInPoolClass } from "@/lib/pool-class";
import { dbProbeFailed } from "@/tests/db-gate";

// The client every module imports resolves, on each use, to the pool of the work running now: work
// that entered as background holds at most the background pool, and a turn still starts while every
// background connection is held.

const appUrl = process.env.TEST_APP_DATABASE_URL;
let dbUp = false;
let main: PrismaClient | undefined;
let background: PrismaClient | undefined;
if (appUrl) {
  try {
    main = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    background = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl, max: 1 }),
    });
    await main.$queryRaw`SELECT 1`;
    await background.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
afterAll(async () => {
  await main?.$disconnect();
  await background?.$disconnect();
});

describe.skipIf(!dbUp)("the client routed by class of work", () => {
  test("with the background pool held, background work waits and a turn's transaction starts", async () => {
    const db = routeByPoolClass({
      main: main as PrismaClient,
      background: background as PrismaClient,
    });
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let holding!: () => void;
    const held = new Promise<void>((r) => {
      holding = r;
    });
    // Background work stuck on its one connection.
    const stuck = runInPoolClass("background", () =>
      db.$transaction(
        async () => {
          holding();
          await released;
        },
        { maxWait: 1_000, timeout: 10_000 },
      ),
    );
    await held;
    try {
      // More background work does not get a connection of the turns' pool...
      const more = await runInPoolClass("background", () =>
        db.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, {
          maxWait: 300,
          timeout: 1_000,
        }),
      ).then(
        () => "ran",
        (e: Error) => e.message,
      );
      expect(more).toContain("Unable to start a transaction");
      // ...and a turn's does, while the background pool is still held.
      const turn = await db.$transaction(async (tx) => tx.$queryRaw`SELECT 1`, {
        maxWait: 300,
        timeout: 1_000,
      });
      expect(turn).toHaveLength(1);
    } finally {
      release();
      await stuck;
    }
  });
});
