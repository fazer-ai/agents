import { describe, expect, test } from "bun:test";
import { Client } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";

// A guarded test file in miniature, on purpose. It is the target of the subprocess runs in
// tests/lib/db-gate.test.ts that prove a probe refused AFTER the preload's gate: the run's own
// database passes the gate, and this file's probe is pointed at `DB_PROBE_REFUSED_URL`, where
// nothing listens. Shaped like the probes it stands for: connect, `SELECT 1`, `dbUp = true`.
const url = process.env.DB_PROBE_REFUSED_URL;
let dbUp = false;
if (url) {
  try {
    const c = new Client({ connectionString: url });
    await c.connect();
    await c.query("SELECT 1");
    await c.end();
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

describe.skipIf(!dbUp)("a database-backed block", () => {
  test("ran against the database", () => {
    expect(dbUp).toBe(true);
  });
});
