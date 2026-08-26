import { describe, expect, test } from "bun:test";
import { DB_GATE_OPT_OUT, missingDbConfig, unreachableDb } from "../db-gate";

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
        "postgresql://u@localhost/x_test",
        new Error("ECONNREFUSED"),
      ),
    ).toContain("would still exit 0");
  });

  test("an unreachable database is named, with the driver's first line", () => {
    const msg = unreachableDb(
      "postgresql://u@localhost/secretaria_v4_test",
      new Error('database "secretaria_v4_test" does not exist\n  at pg'),
    );
    expect(msg).toContain("secretaria_v4_test");
    expect(msg).toContain("does not exist");
    expect(msg).not.toContain("  at pg");
  });

  test("every refusal says how to fix it", () => {
    for (const msg of [
      missingDbConfig({}) ?? "",
      unreachableDb("postgresql://u@localhost/x_test", new Error("boom")),
    ]) {
      expect(msg).toContain("db:test:setup");
      expect(msg).toContain(DB_GATE_OPT_OUT);
    }
  });
});
