import { describe, expect, test } from "bun:test";
import {
  CONNECT_ATTEMPT_MS,
  CONNECT_ATTEMPTS,
  DB_GATE_OPT_OUT,
  dbProbeFailed,
  type MigrationRow,
  missingDbConfig,
  PROBE_BACKSTOP_MS,
  PROBE_DEADLINE_MS,
  probePoolConfig,
  probeTargets,
  readMigrationLedger,
  retryConnect,
  unreachableDb,
  withDeadline,
} from "../db-gate";

// The gate runs at PRELOAD, the one place it can refuse a run instead of reporting on one, and so out
// of reach of a test: by the time this file executes it has passed. So the DECISION is a pure
// function proved here with fixtures, in both directions, since a fence passes over an empty set as
// happily as over a correct one.

describe("the database gate's decision", () => {
  const configured = {
    TEST_MIGRATION_DATABASE_URL: "postgresql://u@localhost/x_test",
    TEST_APP_DATABASE_URL: "postgresql://a@localhost/x_test",
  };

  test("a configured run is not stopped", () => {
    expect(missingDbConfig(configured)).toBeNull();
  });

  test("each missing variable is named, and both when both are gone", () => {
    const noSu = missingDbConfig({
      TEST_APP_DATABASE_URL: configured.TEST_APP_DATABASE_URL,
    });
    expect(noSu).toContain("TEST_MIGRATION_DATABASE_URL");
    expect(noSu).not.toContain("TEST_APP_DATABASE_URL is");
    const noApp = missingDbConfig({
      TEST_MIGRATION_DATABASE_URL: configured.TEST_MIGRATION_DATABASE_URL,
    });
    expect(noApp).toContain("TEST_APP_DATABASE_URL");
    expect(missingDbConfig({})).toContain(
      "TEST_MIGRATION_DATABASE_URL and TEST_APP_DATABASE_URL",
    );
  });

  test("the opt-out is what makes a deliberate run without a database silent", () => {
    expect(missingDbConfig({ [DB_GATE_OPT_OUT]: "1" })).toBeNull();
    // NOTE: only the exact value. A variable left at "0" or "false" by a shell profile is not a
    // decision anyone made about this run.
    expect(missingDbConfig({ [DB_GATE_OPT_OUT]: "0" })).not.toBeNull();
    expect(missingDbConfig({ [DB_GATE_OPT_OUT]: "true" })).not.toBeNull();
  });

  // Every message says the same thing, because it is the thing a reader would otherwise not learn:
  // the run would have been GREEN.
  test("both refusals say that the run would have exited 0", () => {
    expect(missingDbConfig({})).toContain("would still exit 0");
    expect(
      unreachableDb(
        "MIGRATION_DATABASE_URL",
        "postgresql://u@localhost/x_test",
        new Error("ECONNREFUSED"),
      ),
    ).toContain("would still exit 0");
  });

  // NOTE: the shape Prisma produces: the message OPENS with a newline, so a first-line trim prints the
  // variable and the database and then stops, which is the one thing a reader cannot act on.
  test("the driver's reason survives, on one line", () => {
    const msg = unreachableDb(
      "TEST_APP_DATABASE_URL",
      "postgresql://u@localhost/secretaria_v4_test",
      new Error(
        '\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `28P01`. Message: `password authentication failed for user "fazerai_app"`',
      ),
    );
    const line = msg
      .split("\n")
      .find((l) => l.includes("TEST_APP_DATABASE_URL")) as string;
    expect(line).toContain("password authentication failed");
    expect(line).toContain("secretaria_v4_test");
  });

  test("a long driver error does not run away with the output", () => {
    const line = unreachableDb(
      "MIGRATION_DATABASE_URL",
      "postgresql://u@localhost/x_test",
      new Error("x".repeat(5_000)),
    )
      .split("\n")
      .find((l) => l.includes("MIGRATION_DATABASE_URL")) as string;
    expect(line.length).toBeLessThan(300);
    expect(line).toContain("...");
  });

  // The two connections point at the SAME database under different roles, so the database name says
  // nothing about which one failed. Only the variable does, and it is the variable a reader has to
  // go and fix.
  test("the refusal names which of the two connections failed", () => {
    expect(
      unreachableDb(
        "TEST_APP_DATABASE_URL",
        "postgresql://u@localhost/secretaria_v4_test",
        new Error('role "fazerai_app" does not exist'),
      ),
    ).toContain("TEST_APP_DATABASE_URL");
    expect(
      unreachableDb(
        "MIGRATION_DATABASE_URL",
        "postgresql://u@localhost/secretaria_v4_test",
        new Error("ECONNREFUSED"),
      ),
    ).not.toContain("TEST_APP_DATABASE_URL");
  });

  test("every refusal says how to fix it", () => {
    for (const msg of [
      missingDbConfig({}) ?? "",
      unreachableDb(
        "MIGRATION_DATABASE_URL",
        "postgresql://u@localhost/x_test",
        new Error("boom"),
      ),
    ]) {
      expect(msg).toContain("db:test:setup");
      expect(msg).toContain(DB_GATE_OPT_OUT);
    }
  });
});

// A refusal that names a variable the reader cannot change is a refusal they cannot act on: the
// preload OVERWRITES `MIGRATION_DATABASE_URL` from `TEST_MIGRATION_DATABASE_URL` on every run, so
// editing the former in a `.env` changes nothing and the same error comes back.
describe("what the probe is called when it fails", () => {
  const derived = {
    TEST_MIGRATION_DATABASE_URL: "postgresql://su@localhost/x_test",
    MIGRATION_DATABASE_URL: "postgresql://su@localhost/x_test",
    TEST_APP_DATABASE_URL: "postgresql://app@localhost/x_test",
  };

  test("every label is a variable a .env actually holds", () => {
    for (const { variable } of probeTargets(derived)) {
      expect(variable.startsWith("TEST_")).toBe(true);
    }
  });

  // The label is not the value: the migration probe must still run against the DERIVED URL, which
  // is the one the guarded files connect with.
  test("the migration probe is labelled by its source and runs on the derived URL", () => {
    const migration = probeTargets({
      ...derived,
      MIGRATION_DATABASE_URL: "postgresql://su@localhost/derived_test",
    }).find((t) => t.variable === "TEST_MIGRATION_DATABASE_URL");
    expect(migration).toBeDefined();
    expect(migration?.url).toContain("derived_test");
  });
});

// Racing a promise stops the WAITING, not the work: the query keeps a client checked out of the
// pool. The driver's own limits are what cancel it, so they have to actually be passed, and the
// outer backstop has to sit above them or it fires first and the cancellation never happens.
describe("what cancels a probe that will not answer", () => {
  test("the driver is given both limits, not just a connection string", () => {
    const config = probePoolConfig("postgresql://u@localhost/x_test");
    expect(config.connectionString).toContain("x_test");
    expect(config.connectionTimeoutMillis).toBe(CONNECT_ATTEMPT_MS);
    expect(config.query_timeout).toBe(PROBE_DEADLINE_MS);
  });

  test("the backstop leaves the driver room to speak first", () => {
    expect(PROBE_BACKSTOP_MS).toBeGreaterThan(PROBE_DEADLINE_MS);
  });
});

// An endpoint that accepts the connection and then never answers is the case the deadline exists
// for: without it the preload hangs with no output. A gate that stalls instead of refusing is not a
// gate.
describe("the probe's deadline", () => {
  test("a promise that never settles is rejected, naming what did not answer", async () => {
    const never = new Promise<never>(() => {});
    await expect(
      withDeadline(never, 20, "TEST_APP_DATABASE_URL"),
    ).rejects.toThrow("TEST_APP_DATABASE_URL did not answer within 0.02s");
  });

  test("an answer inside the deadline passes through, value and all", async () => {
    await expect(
      withDeadline(Promise.resolve("pong"), 5_000, "MIGRATION_DATABASE_URL"),
    ).resolves.toBe("pong");
  });

  // NOTE: the timer has to be cleared on the winning path too: a pending timeout keeps the event loop
  // alive, so a probe that answered would still hold the run open for the whole deadline. Checked
  // from the outside, because Bun's `process.getActiveResourcesInfo` returns an empty list.
  test("the timer does not outlive a settled probe", async () => {
    const module = new URL("../db-gate.ts", import.meta.url).pathname;
    const started = Date.now();
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `const { withDeadline } = await import(${JSON.stringify(module)});
         await withDeadline(Promise.resolve(1), 30_000, "MIGRATION_DATABASE_URL");`,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const code = await proc.exited;
    expect(code).toBe(0);
    // NOTE: without the clearTimeout this process stays alive for the full 30s deadline.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

// A guarded file's own probe runs AFTER the gate, at module load, where a swallowed refusal (Postgres
// at max_connections) skips the file in silence. The decision is proved here; the run below proves a
// refused probe fails its file.
describe("a probe refused after the gate", () => {
  // Shaped like what each driver throws for SQLSTATE 53300: `pg` keeps the code off the message,
  // Prisma writes it into the message and puts its own P2010 on `code`.
  const pgRefusal = Object.assign(
    new Error("sorry, too many clients already"),
    { code: "53300", severity: "FATAL" },
  );
  const prismaRefusal = Object.assign(
    new Error(
      "\nInvalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `53300`. Message: `sorry, too many clients already`",
    ),
    { code: "P2010" },
  );

  test("past the gate it throws, saying the run would have been green", () => {
    expect(() => dbProbeFailed(pgRefusal, {})).toThrow("would still exit 0");
    expect(() => dbProbeFailed(prismaRefusal, {})).toThrow(
      "refused this file's probe",
    );
  });

  test("the refusal's code reaches the message, from either driver, once", () => {
    const thrown = (err: unknown) => {
      try {
        dbProbeFailed(err, {});
      } catch (e) {
        return (e as Error).message;
      }
      throw new Error("dbProbeFailed did not throw");
    };
    const fromPg = thrown(pgRefusal);
    expect(fromPg).toContain(
      "sorry, too many clients already (SQLSTATE 53300)",
    );
    const fromPrisma = thrown(prismaRefusal);
    expect(fromPrisma).toContain("Code: `53300`");
    expect(fromPrisma).not.toContain("SQLSTATE P2010");
    expect(fromPrisma).not.toContain("\n\n");
  });

  test("under the opt-out it keeps the skip", () => {
    expect(dbProbeFailed(pgRefusal, { [DB_GATE_OPT_OUT]: "1" })).toBe(false);
    // NOTE: only the exact value, as for the gate itself.
    expect(() =>
      dbProbeFailed(pgRefusal, { [DB_GATE_OPT_OUT]: "0" }),
    ).toThrow();
  });
});

// The gate is a PRELOAD, so the tests above prove the decision and these prove what ships: a real
// `bun test` invocation with a broken environment refusing to run. Only this level sees the preload
// asking a different question than the guarded files do.
describe("the gate, as a run", () => {
  const noop = new URL("../utils/db-gate-noop.ts", import.meta.url).pathname;
  const repoRoot = new URL("../..", import.meta.url).pathname;

  // Both URLs are the ones this very run is using, which the gate above already proved reachable.
  const suUrl = process.env.MIGRATION_DATABASE_URL as string;
  const appUrl = process.env.TEST_APP_DATABASE_URL as string;

  async function run(env: Record<string, string>, file = noop) {
    // The opt-out is stripped from the INHERITED environment and only set by a caller that
    // means it. Otherwise a parent run started with ALLOW_NO_DB=1 would hand it to every child, and
    // the refusal these tests watch for would never happen.
    const { [DB_GATE_OPT_OUT]: _optOut, ...inherited } = process.env;
    const proc = Bun.spawn(["bun", "test", file], {
      cwd: repoRoot,
      env: { ...inherited, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, err, out] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    return { code, output: `${out}\n${err}` };
  }

  // The one test here that needs a live database, so it is guarded like every other one in this
  // suite. Under ALLOW_NO_DB=1 there is no app URL to break, and a run that DECLARED it has no
  // database is exactly the run this may be silent in.
  test.skipIf(process.env[DB_GATE_OPT_OUT] === "1")(
    "an app role that cannot log in stops the run, even with a healthy migration role",
    async () => {
      const broken = new URL(appUrl);
      broken.username = "no_such_role_351";
      broken.password = "no_such_password";
      const { code, output } = await run({
        TEST_MIGRATION_DATABASE_URL: suUrl,
        TEST_APP_DATABASE_URL: broken.toString(),
      });
      expect(code).not.toBe(0);
      expect(output).toContain("TEST_APP_DATABASE_URL");
      expect(output).toContain("would still exit 0");
    },
    60_000,
  );

  // THE REFUSAL AFTER THE GATE, as a run: the gate passes on this run's own database, and the fixture
  // file's probe is pointed where nothing listens, standing in for a Postgres that answered at setup
  // and is at max_connections by the time the file loads.
  const refusedFixture = new URL(
    "../utils/db-probe-refused.ts",
    import.meta.url,
  ).pathname;
  const nothingListens = "postgresql://u:p@127.0.0.1:1/nothing_test";

  test.skipIf(process.env[DB_GATE_OPT_OUT] === "1")(
    "a probe refused after the gate fails its file instead of skipping it",
    async () => {
      const { code, output } = await run(
        {
          TEST_MIGRATION_DATABASE_URL: suUrl,
          TEST_APP_DATABASE_URL: appUrl,
          DB_PROBE_REFUSED_URL: nothingListens,
        },
        refusedFixture,
      );
      expect(code).not.toBe(0);
      expect(output).toContain("refused this file's probe");
      expect(output).not.toContain("1 skip");
    },
    60_000,
  );

  test("under the opt-out the same refusal still skips, and the run is green", async () => {
    const { code, output } = await run(
      {
        [DB_GATE_OPT_OUT]: "1",
        DB_PROBE_REFUSED_URL: nothingListens,
      },
      refusedFixture,
    );
    expect(code).toBe(0);
    expect(output).toContain("1 skip");
    expect(output).toContain("0 fail");
  }, 60_000);

  test("the opt-out disarms the probe too, not only the variable check", async () => {
    const { code, output } = await run({
      [DB_GATE_OPT_OUT]: "1",
      TEST_MIGRATION_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nothing_test",
      TEST_APP_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nothing_test",
    });
    expect(code).toBe(0);
    // NOTE: the run got past the preload and executed the noop file: the opt-out has to skip the
    // PROBE, not merely the variable check that precedes it.
    expect(output).toContain("1 pass");
    expect(output).toContain("0 fail");
  }, 60_000);
});

// A connect from this machine to the test Postgres can stall before the server ever sees it, while
// every other connection is answered in milliseconds. One stalled attempt must cost a retry, not the
// file: the preload's connections are the ones no test can retry for itself.
describe("a connection attempt that stalls", () => {
  const stalled = () => new Error("timeout expired");

  test("is made again, and the run goes on with the one that answers", async () => {
    let calls = 0;
    const got = await retryConnect(async () => {
      calls++;
      if (calls === 1) throw stalled();
      return "connected";
    });
    expect(got).toBe("connected");
    expect(calls).toBe(2);
  });

  // Prisma's pool words the same lapse differently, and it is the probe's.
  test("worded as the pool words it, too", async () => {
    let calls = 0;
    await retryConnect(async () => {
      calls++;
      if (calls === 1)
        throw new Error("Connection terminated due to connection timeout");
      return 1;
    });
    expect(calls).toBe(2);
  });

  test("gives up after its attempts, with the last error", async () => {
    let calls = 0;
    const err = await retryConnect(async () => {
      calls++;
      throw stalled();
    }).catch((e) => e);
    expect((err as Error).message).toBe("timeout expired");
    expect(calls).toBe(CONNECT_ATTEMPTS);
  });

  // A refusal is an answer: retrying a bad password only delays the message that names it.
  test("a refusal is not retried", async () => {
    let calls = 0;
    await retryConnect(async () => {
      calls++;
      throw new Error('password authentication failed for user "x"');
    }).catch(() => {});
    expect(calls).toBe(1);
  });
});

// THE LEDGER READ, which decides "this database matches the tree". A database never migrated has no
// `_prisma_migrations` and that is a real state; a read that FAILED is not, and reading it as an
// empty ledger names every migration as never applied, on a database that has them all.
describe("reading which migrations a database has", () => {
  const row: MigrationRow = {
    migration_name: "20260101000000_x",
    checksum: "c",
    finished_at: new Date(0),
    rolled_back_at: null,
  };

  test("a database with no ledger table has applied nothing, and the ledger is not read", async () => {
    const asked: string[] = [];
    const rows = await readMigrationLedger(async (sql) => {
      asked.push(sql);
      return [{ present: false }];
    });
    expect(rows).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  test("a database with the table answers with its rows", async () => {
    const rows = await readMigrationLedger(async (sql) =>
      sql.includes("to_regclass") ? [{ present: true }] : [row],
    );
    expect(rows).toEqual([row]);
  });

  test("a read that fails is a failure, never an empty ledger", async () => {
    const err = await readMigrationLedger(async (sql) => {
      if (sql.includes("to_regclass")) return [{ present: true }];
      throw new Error("Query read timeout");
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("Query read timeout");
  });
});
