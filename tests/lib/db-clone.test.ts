import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { FLEET_ROLE_EXPR } from "@/lib/tenancy/fleet-role";
import {
  CLONE_APP,
  CLONE_MARKER_ENV,
  type CloneOwner,
  clonesToDrop,
  cloneVerdict,
  ensureWorkerClone,
  fastPath,
  ownerComment,
  processStart,
  reapClones,
  workerCloneTarget,
} from "../db-clone";
import { DB_GATE_OPT_OUT, withDeadline } from "../db-gate";
import { checkoutRootFrom, testDbNameFor, withDbName } from "../db-name";
import { until } from "../utils/poll";
import { ROLE_CATALOG_LOCK } from "../utils/role-catalog-lock";

// Under `bun test --parallel` every worker runs on its own copy of the checkout's test database
// (tests/db-clone.ts). These prove the name each worker gets, which leftover copies a run removes,
// and that a `bun test` started from inside a worker stays on that worker's copy.

const ROOT = checkoutRootFrom(import.meta.url, "../..");
const LONG = `/dev/${"w".repeat(40)}/agents-master/1384-a-very-long-worktree-name-indeed`;

describe("the worker's database name", () => {
  const checkout = testDbNameFor("secretaria_v4_test", LONG);

  // The checkout's own name is already close to 63 bytes, so appending the worker would push the
  // hash past the limit, where Postgres cuts it silently and two workers share one database.
  test("stays inside 63 bytes and distinct when two long checkouts share a prefix", () => {
    const names = ["1", "18", "123456789012"].flatMap((w) =>
      [LONG, `${LONG}-two`].map((root) =>
        testDbNameFor(testDbNameFor("secretaria_v4_test", root), root, w),
      ),
    );
    for (const n of names) {
      expect(Buffer.byteLength(n, "utf8")).toBeLessThanOrEqual(63);
      expect(n).toMatch(/^[a-z0-9_]+_test$/);
    }
    expect(new Set(names).size).toBe(names.length);
  });

  test("is a different database from the checkout's, and per worker", () => {
    const one = testDbNameFor(checkout, LONG, "1");
    expect(one).not.toBe(checkout);
    expect(testDbNameFor(checkout, LONG, "2")).not.toBe(one);
    // The readable label keeps eight characters of the id; past them only the hash tells two apart.
    expect(testDbNameFor(checkout, LONG, "123456789012")).not.toBe(
      testDbNameFor(checkout, LONG, "123456789013"),
    );
  });

  // A `bun test` started by a test inside a worker inherits BUN_TEST_WORKER_ID and the URLs the
  // worker already switched. Deriving again from the clone would name a database nobody created.
  test("derived from a worker's name, with or without the worker, is that name", () => {
    const clone = testDbNameFor(checkout, LONG, "3");
    expect(testDbNameFor(clone, LONG, "3")).toBe(clone);
    expect(testDbNameFor(clone, LONG)).toBe(clone);
  });

  // The idempotence above must not adopt ANOTHER checkout's clone: its name is not this one's.
  test("another checkout's worker name is re-derived, not adopted", () => {
    const theirs = testDbNameFor(
      testDbNameFor("secretaria_v4_test", "/elsewhere"),
      "/elsewhere",
      "3",
    );
    expect(testDbNameFor(theirs, LONG, "3")).not.toBe(theirs);
  });
});

describe("whether this process runs on a clone", () => {
  const checkout = testDbNameFor("secretaria_v4_test", ROOT);

  test("only a worker of a parallel run clones, and never under the opt-out", () => {
    expect(workerCloneTarget({}, checkout, ROOT)).toBeNull();
    expect(workerCloneTarget({ BUN_TEST_WORKER_ID: "4" }, checkout, ROOT)).toBe(
      testDbNameFor(checkout, ROOT, "4"),
    );
    expect(
      workerCloneTarget(
        { BUN_TEST_WORKER_ID: "4", [DB_GATE_OPT_OUT]: "1" },
        checkout,
        ROOT,
      ),
    ).toBeNull();
  });

  // A nested run handed the worker's environment keeps whatever database its caller pointed it at:
  // tests/lib/test-db-identity.test.ts points one at a deliberately broken scratch database to watch
  // the gate refuse it, and a copy of that scratch would be neither what it asked for nor ever removed.
  test("a run nested in a worker that already switched does not clone again", () => {
    const scratch = testDbNameFor("fzgate417_p1_test", ROOT);
    expect(
      workerCloneTarget(
        { BUN_TEST_WORKER_ID: "4", [CLONE_MARKER_ENV]: "x" },
        scratch,
        ROOT,
      ),
    ).toBeNull();
    // And one that arrives already on a clone, without the marker, has nothing left to clone.
    const clone = testDbNameFor(checkout, ROOT, "4");
    expect(
      workerCloneTarget({ BUN_TEST_WORKER_ID: "4" }, clone, ROOT),
    ).toBeNull();
  });
});

const TEMPLATE = testDbNameFor("secretaria_v4_test", "/dev/agents/main");
const owner = (o: Partial<CloneOwner>): CloneOwner => ({
  template: TEMPLATE,
  pid: 100,
  start: "Sat Oct 11 10:00:00 2026",
  workerPid: 200,
  ready: true,
  ...o,
});
const cloneName = (w: string, root = "/dev/agents/main") =>
  testDbNameFor(testDbNameFor("secretaria_v4_test", root), root, w);
const alive =
  (running: Record<number, string>) =>
  (pid: number): string | null =>
    running[pid] ?? null;

describe("which leftover clones a run removes", () => {
  const scope = { root: "/dev/agents/main", template: TEMPLATE };

  test.each([
    ["the owner run is gone", owner({}), {}, true],
    [
      "the owner is running",
      owner({}),
      { 100: "Sat Oct 11 10:00:00 2026" },
      false,
    ],
    // A pid the kernel handed to a new process after the owner died: alive by `kill -0`, and not
    // the run that made the copy.
    [
      "the pid was reused",
      owner({}),
      { 100: "Sun Oct 12 09:00:00 2026" },
      true,
    ],
    [
      "the clone is another template's",
      owner({ template: "other_test" }),
      {},
      false,
    ],
  ] as const)("%s", (_why, o, running, dropped) => {
    const rows = [{ name: cloneName("1"), comment: ownerComment(o) }];
    expect(clonesToDrop(rows, scope, alive(running))).toEqual(
      dropped ? [cloneName("1")] : [],
    );
  });

  // Created and not yet commented: a worker that died between the two statements. Run under the
  // clone lock, so nobody is half-way through creating it.
  test("a clone of this checkout with no ownership record is removed", () => {
    expect(
      clonesToDrop([{ name: cloneName("2"), comment: null }], scope, alive({})),
    ).toEqual([cloneName("2")]);
  });

  // Names are tied to the checkout, so another checkout's leftovers are its own run's business,
  // even when its record names this template and its owner is gone.
  test("another checkout's clone, or a database that is no clone, is never touched", () => {
    const rows = [
      {
        name: cloneName("1", "/dev/agents/other"),
        comment: ownerComment(owner({})),
      },
      { name: TEMPLATE, comment: null },
      {
        name: testDbNameFor("fzgate417_p1_test", "/dev/agents/main"),
        comment: null,
      },
    ];
    expect(clonesToDrop(rows, scope, alive({}))).toEqual([]);
  });
});

describe("what a worker does with the clone it is about to use", () => {
  const me = { pid: 200, ancestors: [200, 100] };
  const running = alive({ 100: "Sat Oct 11 10:00:00 2026" });

  test("absent, it is created", () => {
    expect(cloneVerdict(undefined, me, running)).toBe("create");
  });

  test("this run's, ready, is used", () => {
    expect(cloneVerdict(owner({}), me, running)).toBe("use");
  });

  // A nested `bun test` whose worker is its parent: the worker's run owns the copy.
  test("an ancestor run's is used", () => {
    expect(
      cloneVerdict(
        owner({}),
        { pid: 300, ancestors: [300, 200, 100] },
        running,
      ),
    ).toBe("use");
  });

  test("half-provisioned, or with no record, it is rebuilt", () => {
    expect(cloneVerdict(owner({ ready: false }), me, running)).toBe("recreate");
    expect(cloneVerdict(null, me, running)).toBe("recreate");
  });

  // Two `bun test --parallel` from one checkout at once would share every worker's copy, which is the
  // collision this exists to remove; the second refuses and names the first.
  test("a live run that is not an ancestor makes this one refuse", () => {
    expect(
      cloneVerdict(
        owner({ pid: 999 }),
        me,
        alive({ 999: "Sat Oct 11 10:00:00 2026" }),
      ),
    ).toBe("refuse");
  });
});

// The decisions above, against a real cluster: a database left by a dead run is dropped together with
// the fleet role named after it, and one whose run is alive stays. The copies belong to a checkout
// that does not exist, because a worker of a real `--parallel` run reaps its own checkout's leftovers,
// unmarked ones included, and would take these between their CREATE and the reap under test.
describe("removing leftovers, on the database", () => {
  const suUrl = process.env.MIGRATION_DATABASE_URL;
  const live = process.env[DB_GATE_OPT_OUT] !== "1" && Boolean(suUrl);

  test.skipIf(!live)(
    "a dead run's clone and its fleet role go, a live run's clone stays",
    async () => {
      const root = `/nonexistent/fzclone1384-p${process.pid}`;
      const template = testDbNameFor(`fzclone1384_p${process.pid}_test`, root);
      const dead = testDbNameFor(template, root, "1");
      const kept = testDbNameFor(template, root, "2");
      const finished = Bun.spawn(["true"]);
      await finished.exited;
      const maintUrl = withDbName(suUrl as string, "postgres");
      const maint = new Client({ connectionString: maintUrl });
      await maint.connect();
      const fleetOf = async (db: string) =>
        (
          await maint.query<{ role: string }>(
            `SELECT ${FLEET_ROLE_EXPR.replaceAll("current_database()::text", "$1::text")} AS role`,
            [db],
          )
        ).rows[0]?.role as string;
      const deadRole = await fleetOf(dead);
      try {
        const owners = [
          [dead, owner({ template, pid: finished.pid, start: "gone" })],
          [
            kept,
            owner({
              template,
              pid: process.pid,
              start: (await processStart(process.pid)) as string,
            }),
          ],
        ] as const;
        for (const [db] of owners) await maint.query(`CREATE DATABASE "${db}"`);
        // NOTE: unmarked, these are what a worker of this checkout would reap; it must not reach them.
        await reapClones({
          maintUrl,
          root: ROOT,
          template: testDbNameFor("fzclone1384_none_test", ROOT),
        });
        for (const [db, o] of owners) {
          await maint.query(
            `COMMENT ON DATABASE "${db}" IS ${maint.escapeLiteral(ownerComment(o))}`,
          );
        }
        await maint.query(`CREATE ROLE "${deadRole}" NOLOGIN`);

        const dropped = await reapClones({ maintUrl, root, template });

        expect(dropped).toEqual([dead]);
        const { rows } = await maint.query<{ datname: string }>(
          "SELECT datname FROM pg_database WHERE datname = ANY($1)",
          [[dead, kept]],
        );
        expect(rows.map((r) => r.datname)).toEqual([kept]);
        const role = await maint.query(
          "SELECT 1 FROM pg_roles WHERE rolname = $1",
          [deadRole],
        );
        expect(role.rowCount).toBe(0);
      } finally {
        for (const db of [dead, kept]) {
          await maint.query(`DROP DATABASE IF EXISTS "${db}"`).catch(() => {});
        }
        await maint.query(`DROP ROLE IF EXISTS "${deadRole}"`).catch(() => {});
        await maint.end();
      }
    },
    60_000,
  );
});

// What only a real run shows: the preload of a `bun test` started from a test inside a worker, given
// the worker's environment, lands on the worker's own copy for every connection URL. Only exists under
// `--parallel`; a serial run has no copy for it to land on.
describe("a run nested inside a worker", () => {
  const inWorker =
    Boolean(process.env.BUN_TEST_WORKER_ID) &&
    process.env[DB_GATE_OPT_OUT] !== "1";
  const fixture = fileURLToPath(
    new URL("../utils/db-clone-nested.ts", import.meta.url),
  );

  test.skipIf(!inWorker)(
    "stays on the worker's clone",
    async () => {
      const dbOf = (v: string) =>
        new URL(process.env[v] as string).pathname.slice(1);
      const clone = dbOf("MIGRATION_DATABASE_URL");
      // This worker is on its own copy, not on the checkout's database.
      expect(process.env[CLONE_MARKER_ENV]).toBe(clone);
      expect(clone).toBe(
        testDbNameFor(clone, ROOT, process.env.BUN_TEST_WORKER_ID),
      );
      // Without the marker: the inherited URL alone has to keep it on the copy.
      const { [CLONE_MARKER_ENV]: _marker, ...env } = process.env;
      const proc = Bun.spawn(["bun", "test", fixture], {
        cwd: ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [code, out, err] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      expect(code, err).toBe(0);
      const line = `${out}\n${err}`.match(/NESTED_DBS (.*)/)?.[1];
      expect(JSON.parse(line as string)).toEqual({
        MIGRATION_DATABASE_URL: clone,
        TEST_MIGRATION_DATABASE_URL: clone,
        TEST_APP_DATABASE_URL: clone,
        LANGGRAPH_DATABASE_URL: clone,
      });
    },
    120_000,
  );
});

// The clone runs before the gate, so nothing else bounds it: an endpoint that takes the socket and
// never answers has to be refused, not waited on.
describe("the clone's deadlines", () => {
  test("an endpoint that accepts and never answers is refused, not waited on", async () => {
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data() {} },
    });
    try {
      // NOTE: the outer bound turns a client with no deadline into a failure with another message,
      // instead of a test that hangs.
      await expect(
        withDeadline(
          ensureWorkerClone({
            suUrl: `postgres://postgres:x@127.0.0.1:${server.port}/silent_test`,
            appRole: "app",
            root: ROOT,
            template: "silent_test",
            clone: "silent_w1_test",
            deadlines: { connectMs: 200, queryMs: 200 },
          }),
          5_000,
          "the clone client",
        ),
      ).rejects.toThrow("timeout expired");
    } finally {
      server.stop(true);
    }
  });
});

// The start time is the ownership token, so it has to read the same from every process that compares
// it: a run, a nested run and the detached reaper may each carry a different `TZ`.
test("a process's start time reads the same whatever TZ the caller has", async () => {
  const saved = process.env.TZ;
  try {
    process.env.TZ = "Asia/Tokyo";
    const tokyo = await processStart(process.pid);
    process.env.TZ = "America/Sao_Paulo";
    const saoPaulo = await processStart(process.pid);
    expect(tokyo).not.toBeNull();
    expect(saoPaulo).toBe(tokyo);
  } finally {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  }
});

// A WORKER WITH NO TEMPLATE TO COPY FAILS ITS FILE AT ONCE. Without the checkout's database every
// file of every worker would otherwise walk the whole slow path (process table, lock, reap) only to
// learn that again at CREATE, and a run of a thousand files does that a thousand times.
describe("what a worker decides before taking the lock", () => {
  const me = { pid: 200, ppid: 100 };
  const live = alive({ 100: "Sat Oct 11 10:00:00 2026" });

  test("its own ready copy is used, with or without the template", () => {
    expect(fastPath({ template: true, clone: owner({}) }, me, live)).toBe(
      "use",
    );
    // NOTE: a template reprovisioned mid-run does not take the copy away from the worker using it.
    expect(fastPath({ template: false, clone: owner({}) }, me, live)).toBe(
      "use",
    );
  });

  test("with no template and no copy of its own, it stops there", () => {
    expect(fastPath({ template: false, clone: undefined }, me, live)).toBe(
      "no-template",
    );
    expect(
      fastPath({ template: false, clone: owner({ workerPid: 999 }) }, me, live),
    ).toBe("no-template");
  });

  test("with the template and no copy of its own, it goes on to make one", () => {
    expect(fastPath({ template: true, clone: undefined }, me, live)).toBe(
      "slow",
    );
    expect(
      fastPath({ template: true, clone: owner({ ready: false }) }, me, live),
    ).toBe("slow");
  });

  test("a copy whose pids match but whose owner started at another time is not its own", () => {
    // After a reboot the kernel can hand a dead run's pids to the new run; only the start time
    // tells them apart, and the slow path is where the leftover is dropped.
    const recycled = alive({ 100: "Mon Oct 13 09:00:00 2026" });
    expect(fastPath({ template: true, clone: owner({}) }, me, recycled)).toBe(
      "slow",
    );
  });
});

describe("a worker whose checkout has no test database", () => {
  const suUrl = process.env.MIGRATION_DATABASE_URL;
  const live = process.env[DB_GATE_OPT_OUT] !== "1" && Boolean(suUrl);

  test.skipIf(!live)(
    "is refused with the command that provisions it, and copies nothing",
    async () => {
      const root = `/nonexistent/fznotemplate1384-p${process.pid}`;
      const template = testDbNameFor(
        `fznotemplate1384_p${process.pid}_test`,
        root,
      );
      const clone = testDbNameFor(template, root, "1");
      const maint = new Client({
        connectionString: withDbName(suUrl as string, "postgres"),
      });
      await maint.connect();
      try {
        // NOTE: this checkout's clone lock, held elsewhere: a worker that went on to the slow path
        // would wait on it and lapse on its statement deadline, never reaching the message below.
        await maint.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
          `fazerai-test-clone:${testDbNameFor("x_test", root)}`,
        ]);
        const err = await ensureWorkerClone({
          suUrl: withDbName(suUrl as string, template),
          appRole: "app",
          root,
          template,
          clone,
          deadlines: { connectMs: 5_000, queryMs: 2_000 },
        }).catch((e) => e);
        expect((err as Error).message).toContain(
          `"${template}" does not exist`,
        );
        expect((err as Error).message).toContain("bun run db:test:setup");
        const { rowCount } = await maint.query(
          "SELECT 1 FROM pg_database WHERE datname = $1",
          [clone],
        );
        expect(rowCount).toBe(0);
      } finally {
        await maint.end();
      }
    },
    60_000,
  );
});

// WAITING FOR A BUSY TEMPLATE DOES NOT HOLD THE ROLE CATALOG LOCK. A copy waits up to a minute for the
// template's connections to close, and every suite that writes roles allows less than that to take
// the catalog lock, so the lock is taken only around the copy's role DDL, never around the wait.
describe("a copy waiting on a busy template", () => {
  const suUrl = process.env.MIGRATION_DATABASE_URL;
  const live = process.env[DB_GATE_OPT_OUT] !== "1" && Boolean(suUrl);

  test.skipIf(!live)(
    "leaves the role catalog lock to everyone else while it waits",
    async () => {
      const root = `/nonexistent/fzbusy1384-p${process.pid}`;
      const template = testDbNameFor(`fzbusy1384_p${process.pid}_test`, root);
      const clone = testDbNameFor(template, root, "1");
      const maint = new Client({
        connectionString: withDbName(suUrl as string, "postgres"),
      });
      await maint.connect();
      await maint.query(`CREATE DATABASE "${template}"`);
      const busy = new Client({
        connectionString: withDbName(suUrl as string, template),
      });
      await busy.connect();
      let copying: Promise<unknown> | undefined;
      try {
        copying = ensureWorkerClone({
          suUrl: withDbName(suUrl as string, template),
          appRole: "app",
          root,
          template,
          clone,
        }).catch((e) => e);
        const waiter = await until(
          "the copy to be retrying its CREATE",
          async () => {
            const { rows } = await maint.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity
              WHERE datname = $1 AND application_name = $2 AND query LIKE $3`,
              [
                "postgres",
                CLONE_APP,
                `CREATE DATABASE "${clone}" TEMPLATE "${template}"%`,
              ],
            );
            return rows[0]?.pid;
          },
        );
        const { rowCount } = await maint.query(
          `SELECT 1 FROM pg_locks
            WHERE locktype = 'advisory' AND objid = $1 AND granted AND pid = $2`,
          [ROLE_CATALOG_LOCK, waiter],
        );
        expect(rowCount).toBe(0);
      } finally {
        await busy.end();
        await copying;
        await maint
          .query(`DROP DATABASE IF EXISTS "${clone}" WITH (FORCE)`)
          .catch(() => {});
        await maint
          .query(`DROP DATABASE IF EXISTS "${template}" WITH (FORCE)`)
          .catch(() => {});
        await maint.end();
      }
    },
    90_000,
  );
});
