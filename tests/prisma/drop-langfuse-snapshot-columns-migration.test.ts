import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// The eight Langfuse-era columns of `spend_cost_snapshots` are gone: nothing writes or reads them, and
// the snapshot table keeps only what the poll and the console use. History in docs/spend-ceiling.md.

const suUrl = process.env.MIGRATION_DATABASE_URL;

const DROPPED = [
  "traced_calls",
  "costed_calls",
  "unpriced_models",
  "project_key",
  "carried_usd",
  "carried_traced_calls",
  "carried_costed_calls",
  "carried_unpriced_models",
];
// What the poll and the console still read and write.
const KEPT = [
  "id",
  "tenant_id",
  "source",
  "month_start",
  "cost_usd",
  "polled_at",
  "poll_error",
  "poll_failed_at",
  "poll_last_failed_at",
  "created_at",
  "updated_at",
];

let dbUp = false;
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

describe.skipIf(!dbUp)("migration: the snapshot's Langfuse-era columns", () => {
  test("are gone from the catalog, and every column the ledger poll uses is still there", async () => {
    const r = await suDb.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'spend_cost_snapshots'`,
    );
    const columns = r.rows.map((row) => row.column_name).sort();
    expect(columns).toEqual([...KEPT].sort());
    for (const name of DROPPED) expect(columns).not.toContain(name);
  });
});
