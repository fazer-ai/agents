import { describe, expect, test } from "bun:test";
import {
  DB_GATE_OPT_OUT,
  missingDbConfig,
  PROBE_BACKSTOP_MS,
  PROBE_DEADLINE_MS,
  probePoolConfig,
  probeTargets,
  unreachableDb,
  withDeadline,
} from "../db-gate";

// The gate itself runs at PRELOAD, before any test file, which is the one place it can refuse a run
// instead of reporting on one. That also puts it out of reach of a test: by the time this file
// executes, the gate has already passed. So the DECISION is a pure function and this proves it with
// fixtures, in both directions: a fence with no offender left passes over an empty set just as
// happily as over a correct one (issue #351).

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

  // An EMPTY string is the shape a shell hands over when someone clears the variable, and it is not
  // the same falsy as absent for every predicate one could write here.
  test("an empty variable counts as missing", () => {
    expect(
      missingDbConfig({ ...configured, TEST_MIGRATION_DATABASE_URL: "" }),
    ).toContain("TEST_MIGRATION_DATABASE_URL");
  });

  test("the opt-out is what makes a deliberate run without a database silent", () => {
    expect(missingDbConfig({ [DB_GATE_OPT_OUT]: "1" })).toBeNull();
    // Only the exact value. A variable left at "0" or "false" by a shell profile is not a decision
    // anyone made about this run.
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

  // The exact shape Prisma produces, measured: the message OPENS with a newline, so a first-line
  // trim prints the variable and the database and then stops, which is the one thing a reader
  // cannot act on.
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
    expect(config.connectionTimeoutMillis).toBe(PROBE_DEADLINE_MS);
    expect(config.query_timeout).toBe(PROBE_DEADLINE_MS);
  });

  test("the backstop leaves the driver room to speak first", () => {
    expect(PROBE_BACKSTOP_MS).toBeGreaterThan(PROBE_DEADLINE_MS);
  });
});

// An endpoint that accepts the connection and then never answers is the case the deadline exists
// for: measured against a listener that accepts and stays silent, the preload was still hanging at
// 45s. A gate that stalls instead of refusing is not a gate.
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

  // The timer has to be cleared on the winning path too: a pending timeout keeps the event loop
  // alive, so a probe that answered would still hold the run open for the whole deadline. Measured
  // from the outside, because a leaked timer is invisible to the process holding it (Bun's
  // `process.getActiveResourcesInfo` returns an empty list, so asserting on it proves nothing).
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
    // Without the clearTimeout this process stays alive for the full 30s deadline.
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

// The gate itself is a PRELOAD, so the two tests above it prove the decision and these two prove
// the thing that actually ships: a real `bun test` invocation, with a real broken environment,
// refusing to run. This is where the app-role half was missing, and a unit test could not have
// caught it, because the shape of the bug was "the preload asks a different question than the
// guarded files do".
describe("the gate, as a run", () => {
  const noop = new URL("../utils/db-gate-noop.ts", import.meta.url).pathname;
  const repoRoot = new URL("../..", import.meta.url).pathname;

  // Both URLs are the ones this very run is using, which the gate above already proved reachable.
  const suUrl = process.env.MIGRATION_DATABASE_URL as string;
  const appUrl = process.env.TEST_APP_DATABASE_URL as string;

  async function run(env: Record<string, string>) {
    // The opt-out is stripped from the INHERITED environment and only ever set by a caller that
    // means it. Otherwise a parent run started with ALLOW_NO_DB=1 would hand it to every child,
    // and the refusal these tests are watching for would never happen.
    const { [DB_GATE_OPT_OUT]: _optOut, ...inherited } = process.env;
    const proc = Bun.spawn(["bun", "test", noop], {
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

  test("the opt-out disarms the probe too, not only the variable check", async () => {
    const { code, output } = await run({
      [DB_GATE_OPT_OUT]: "1",
      TEST_MIGRATION_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nothing_test",
      TEST_APP_DATABASE_URL: "postgresql://u:p@127.0.0.1:1/nothing_test",
    });
    expect(code).toBe(0);
    // The run got past the preload and executed the noop file, which is the whole claim: the
    // opt-out has to skip the PROBE, not merely the variable check that precedes it.
    expect(output).toContain("1 pass");
    expect(output).toContain("0 fail");
  }, 60_000);
});
