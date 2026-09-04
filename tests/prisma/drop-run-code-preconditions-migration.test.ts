import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the ACTUAL migration file against the test database. Round 23: a precondition is keyed by
// tool NAME and the seam that applies it reaches every source, so the rule an operator wrote
// against the native `run_code` (the only kind of name the write boundary accepts) would start
// guarding the HTTP tool the next migration restores under that name — a refusal configured for
// something else, with nothing on screen connecting the two.
//
// What it pins: the key goes, the agent's OTHER preconditions and the rest of its settings stay,
// an agent that never had the key is not rewritten, and FORCE ROW LEVEL SECURITY is back on.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260903141000_drop_run_code_preconditions/migration.sql";

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

const RULE = (attr: string) => ({
  kind: "attribute",
  scope: "conversation",
  key: attr,
});

async function agent(name: string, settings: unknown): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
     VALUES ($1, $2, 'x', '{"provider":"openai","model":"gpt-4o-mini"}'::jsonb, $3::jsonb, NOW(), NOW())
     RETURNING id`,
    [String(tenantId), name, JSON.stringify(settings)],
  );
  return BigInt(r.rows[0].id);
}

async function settingsOf(id: bigint): Promise<Record<string, unknown>> {
  const r = await suDb.query('SELECT settings FROM "agents" WHERE id = $1', [
    String(id),
  ]);
  return r.rows[0].settings as Record<string, unknown>;
}

async function updatedAtOf(id: bigint): Promise<string> {
  const r = await suDb.query('SELECT updated_at FROM "agents" WHERE id = $1', [
    String(id),
  ]);
  return String(r.rows[0].updated_at);
}

describe.skipIf(!dbUp)("migration: drop run_code preconditions", () => {
  beforeAll(async () => {
    const t = await suDb.query(
      `INSERT INTO "tenants" (name, slug, created_at, updated_at)
       VALUES ('rc-precond', 'rc-precond-' || floor(random() * 1e9)::text, NOW(), NOW()) RETURNING id`,
    );
    tenantId = BigInt(t.rows[0].id);

    // The agent the migration is for: a rule on the retired native, beside a rule on a native that
    // is still one, inside a settings bag that carries other keys.
    ids.guarded = await agent("guarded", {
      temperature: 0.4,
      toolPreconditions: {
        run_code: RULE("cpf_ok"),
        set_custom_attribute: RULE("consent"),
      },
    });
    // Never had the key: must not be rewritten at all.
    ids.untouched = await agent("untouched", {
      toolPreconditions: { set_custom_attribute: RULE("consent") },
    });
    // No preconditions bag at all: the WHERE must not match a missing key or a non-object.
    ids.bare = await agent("bare", { temperature: 0.2 });
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query('DELETE FROM "tenants" WHERE id = $1', [String(tenantId)]);
    await su?.end();
  });

  test("drops only the run_code rule, and leaves every other setting alone", async () => {
    const before = await updatedAtOf(ids.untouched as bigint);
    await suDb.query(sql);

    const guarded = await settingsOf(ids.guarded as bigint);
    expect(guarded.toolPreconditions).toEqual({
      set_custom_attribute: RULE("consent"),
    });
    expect(guarded.temperature).toBe(0.4);

    expect(await settingsOf(ids.untouched as bigint)).toEqual({
      toolPreconditions: { set_custom_attribute: RULE("consent") },
    });
    // Not rewritten: an agent the migration has no business touching keeps its timestamp, which is
    // what an operator reads to know when the agent last changed.
    expect(await updatedAtOf(ids.untouched as bigint)).toBe(before);

    expect(await settingsOf(ids.bare as bigint)).toEqual({ temperature: 0.2 });
  });

  test("a re-run rewrites nothing, and FORCE RLS is back on", async () => {
    const before = await updatedAtOf(ids.guarded as bigint);
    await suDb.query(sql);
    expect(await updatedAtOf(ids.guarded as bigint)).toBe(before);

    const r = await suDb.query(
      `SELECT relforcerowsecurity FROM pg_class WHERE relname = 'agents'`,
    );
    expect(r.rows[0].relforcerowsecurity).toBe(true);
  });
});
