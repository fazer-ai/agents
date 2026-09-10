import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the ACTUAL migration file. The keys it removes reach no reader, so what is under test is not
// a behaviour change but the UPGRADE: the write boundary refuses a retired key that carries
// configuration, and every agent ever saved through the previous Behavior editor carries
// `monitoring.labelGroups` because `observationToStored` wrote it unconditionally. Both surviving
// writers spread what they read, so a tombstone left in place comes back on the next unrelated save.
const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260910140000_drop_retired_label_settings/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    sql = await Bun.file(MIGRATION).text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;
let tenantId = 0n;
const ids: Record<string, bigint> = {};
const id = (k: string): bigint => ids[k] as bigint;

// One statement at a time, on one connection, because that is what `migrate deploy` does: handing
// the whole text to `pg` goes out over the simple-query protocol, which Postgres wraps in an
// IMPLICIT transaction, so the file would look atomic whatever it says.
function statementsOf(text: string): string[] {
  return text
    .replace(/^\s*--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`);
}

async function agent(name: string, settings: string): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
     VALUES ($1, $2, 'p', '{}'::jsonb, $3::jsonb, NOW(), NOW()) RETURNING id`,
    [String(tenantId), name, settings],
  );
  return BigInt(r.rows[0].id);
}

async function settingsOf(agentId: bigint): Promise<Record<string, unknown>> {
  const r = await suDb.query('SELECT settings FROM "agents" WHERE id = $1', [
    String(agentId),
  ]);
  return r.rows[0].settings as Record<string, unknown>;
}

describe.if(dbUp)("drop retired label settings", () => {
  beforeAll(async () => {
    const t = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["DROPLBL", `droplbl-${process.pid}`],
    );
    tenantId = BigInt(t.rows[0].id);

    // The common row, and the one the finding is about: never configured a taxonomy, still carries
    // the key because the editor wrote it unconditionally.
    ids.tombstone = await agent(
      "tumulo",
      JSON.stringify({
        monitoring: {
          window: { messages: 20 },
          analysis: "incremental",
          labelGroups: [],
          // The key that actually shipped: written for every agent, defaulting to true.
          noteOnChange: true,
        },
        debounce: { windowSeconds: 20 },
      }),
    );
    // A row that really was configured, in both places.
    ids.configured = await agent(
      "configurada",
      JSON.stringify({
        labels: {
          groups: [{ name: "assunto", values: ["a", "b"], exclusive: true }],
          noteOnChange: true,
        },
        monitoring: {
          window: { messages: 30 },
          labelGroups: [{ name: "assunto", values: ["a"] }],
        },
        toolGuidance: { set_labels: "exatamente uma" },
      }),
    );
    // A row with neither key: the migration must not touch it.
    ids.clean = await agent(
      "limpa",
      JSON.stringify({ debounce: { windowSeconds: 15 } }),
    );
    // A row whose `monitoring` is not an object. The jsonb_set would raise on it if the WHERE did
    // not ask, and the failure would be a migration that aborts on somebody else's bad data.
    ids.odd = await agent("estranha", JSON.stringify({ monitoring: "nao" }));

    for (const statement of statementsOf(sql)) await suDb.query(statement);
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query("DELETE FROM tenants WHERE id = $1", [String(tenantId)]);
    await suDb.end();
  });

  test("the empty tombstone is gone and the live monitoring config is not", async () => {
    const s = await settingsOf(id("tombstone"));
    const mon = s.monitoring as Record<string, unknown>;
    expect(mon.labelGroups).toBeUndefined();
    expect(mon.noteOnChange).toBeUndefined();
    // The rest of the block is live configuration; cutting the key must not drop the block.
    expect((mon.window as { messages: number }).messages).toBe(20);
    expect(mon.analysis).toBe("incremental");
    expect((s.debounce as { windowSeconds: number }).windowSeconds).toBe(20);
  });

  test("a configured taxonomy is removed from both places", async () => {
    const s = await settingsOf(id("configured"));
    expect(s.labels).toBeUndefined();
    expect(
      (s.monitoring as Record<string, unknown>).labelGroups,
    ).toBeUndefined();
    // And what is NOT retired survives, including the note the taxonomy became.
    expect(
      (s.monitoring as { window: { messages: number } }).window.messages,
    ).toBe(30);
    expect((s.toolGuidance as Record<string, string>).set_labels).toBe(
      "exatamente uma",
    );
  });

  test("a bag with neither key is left byte-identical", async () => {
    const s = await settingsOf(id("clean"));
    expect(s).toEqual({ debounce: { windowSeconds: 15 } });
  });

  test("a monitoring block that is not an object does not abort the run", async () => {
    // The WHERE asks `jsonb_typeof(...) = 'object'` for exactly this: without it the jsonb_set
    // raises, and one tenant's odd row would stop the upgrade for everybody.
    const s = await settingsOf(id("odd"));
    expect(s.monitoring).toBe("nao");
  });

  test("running it a second time changes nothing", async () => {
    const before = await settingsOf(id("configured"));
    for (const statement of statementsOf(sql)) await suDb.query(statement);
    expect(await settingsOf(id("configured"))).toEqual(before);
  });
});
