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
    // A CONFIGURED TAXONOMY WITH NOBODY'S GUIDANCE OVER IT: the one row where something an operator
    // chose would otherwise be deleted with the key (review round 26).
    ids.carried = await agent(
      "carregada",
      JSON.stringify({
        monitoring: {
          window: { messages: 25 },
          labelGroups: [
            {
              name: "assunto",
              values: ["cancelamento", "compra"],
              exclusive: true,
            },
            // NO `exclusive` FIELD: the previous reader asked `!== false`, so this group was
            // EXCLUSIVE — the default, and the opposite of what a missing value casts to.
            { name: "sinal", values: ["urgente"] },
            // Explicitly not exclusive, the only spelling that means "more than one".
            { name: "extra", values: ["vip"], exclusive: false },
            // A LOOSE BAG: an imported agent can carry anything here, and a cast would raise and
            // abort the deployment migration. Reads as exclusive, like every non-`false` value.
            { name: "solto", values: ["x"], exclusive: "custom" },
          ],
        },
      }),
    );
    // ...and the allowlist that the OLD classifier never needed: it applied labels itself and asked
    // no grant, so a watcher could carry an explicit NATIVE allowlist without the label tool and
    // classify anyway (review round 28).
    await suDb.query(
      `INSERT INTO "agent_tool_selections" (tenant_id, agent_id, source, knowledge_base_ids, enabled_tools, created_at, updated_at)
       VALUES ($1, $2, 'NATIVE', '{}', $3, NOW(), NOW())`,
      [String(tenantId), String(ids.carried), ["private_note"]],
    );
    // A watcher with a taxonomy AND the tool already granted: nothing to add, and never twice.
    ids.granted = await agent(
      "ja-concedida",
      JSON.stringify({
        monitoring: { labelGroups: [{ name: "assunto", values: ["a"] }] },
      }),
    );
    await suDb.query(
      `INSERT INTO "agent_tool_selections" (tenant_id, agent_id, source, knowledge_base_ids, enabled_tools, created_at, updated_at)
       VALUES ($1, $2, 'NATIVE', '{}', $3, NOW(), NOW())`,
      [String(tenantId), String(ids.granted), ["set_labels", "private_note"]],
    );
    // A row with neither key: the migration must not touch it.
    ids.clean = await agent(
      "limpa",
      JSON.stringify({ debounce: { windowSeconds: 15 } }),
    );
    // A row whose `monitoring` is not an object. The jsonb_set would raise on it if the WHERE did
    // not ask, and the failure would be a migration that aborts on somebody else's bad data.
    ids.odd = await agent("estranha", JSON.stringify({ monitoring: "nao" }));
    // ...AND ONE WHOSE `labelGroups` IS NOT AN ARRAY, which is the shape that aborts the whole
    // deployment (review round 39): the lateral runs before the WHERE that was supposed to filter
    // it out, and `jsonb_array_elements` on a scalar raises. An import writes `settings` wholesale,
    // so nothing upstream guarantees the type. Two spellings, because the object reaches a
    // different branch of the same error than the string.
    ids.scalarGroups = await agent(
      "grupos-texto",
      JSON.stringify({
        monitoring: { window: { messages: 10 }, labelGroups: "assunto" },
      }),
    );
    ids.objectGroups = await agent(
      "grupos-objeto",
      JSON.stringify({ monitoring: { labelGroups: { assunto: ["a"] } } }),
    );

    for (const statement of statementsOf(sql)) await suDb.query(statement);
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.query(
      'DELETE FROM "agent_tool_selections" WHERE tenant_id = $1',
      [String(tenantId)],
    );
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query("DELETE FROM tenants WHERE id = $1", [String(tenantId)]);
    await suDb.end();
  });

  // The migration RAN, which is most of this test: `beforeAll` executes every statement, so a row
  // that aborts one takes the whole file down with it and every test here fails at once. What is
  // left to assert is that the odd rows were carried through rather than skipped.
  test("a labelGroups that is not an array neither aborts the migration nor survives it", async () => {
    const scalar = await settingsOf(id("scalarGroups"));
    const mon = scalar.monitoring as Record<string, unknown>;
    expect(mon.labelGroups).toBeUndefined();
    expect((mon.window as { messages: number }).messages).toBe(10);
    // Nothing to render, so no guidance is invented from a shape that names no groups.
    expect(scalar.toolGuidance).toBeUndefined();
    const obj = await settingsOf(id("objectGroups"));
    expect(
      (obj.monitoring as Record<string, unknown>).labelGroups,
    ).toBeUndefined();
    expect(obj.toolGuidance).toBeUndefined();
  });

  // THE WINDOW THIS FILE CANNOT SURVIVE IS PROSE, so the prose is what is pinned (review round 41).
  // `migrate deploy` runs in the new container with the old one still serving, and there
  // `observationEnabled` is `labelGroups.length > 0`: with the key cut, that process arms nothing.
  // A reader who takes this migration for an ordinary rolling one loses observations for good.
  test("the rollout note names this migration and says to stop the old process", async () => {
    const deploy = await Bun.file("docs/deploy.md").text();
    const at = deploy.indexOf("20260910140000_drop_retired_label_settings");
    expect(at).toBeGreaterThan(-1);
    const note = deploy.slice(at, at + 1400);
    expect(note).toContain("stop the old process");
    expect(note).toContain("observationEnabled");
    const sqlHead = sql.slice(0, 600);
    expect(sqlHead).toContain("STOP-MIGRATE-START");
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

  test("a configured taxonomy becomes the tool's guidance instead of disappearing", async () => {
    const s = await settingsOf(id("carried"));
    const note = (s.toolGuidance as Record<string, string>).set_labels;
    // Names itself as migrated, because an operator who finds guidance they did not type has to be
    // able to tell where it came from — this migration writes no audit line.
    // THE WHOLE SENTENCE, and not a set of fragments: the import boundary renders the same text in
    // TypeScript (tests/modules/agent-transfer.test.ts asserts this exact string for this exact
    // input), and asserting both against one literal is what keeps a SQL renderer and a TS one from
    // drifting apart (round 28).
    expect(note).toBe(
      "Migrado da taxonomia anterior. Grupos de etiquetas desta conta: assunto (escolha no máximo uma): cancelamento, compra. sinal (escolha no máximo uma): urgente. extra (pode usar mais de uma): vip. solto (escolha no máximo uma): x.",
    );
    expect(note).toContain("Migrado da taxonomia anterior");
    expect(note).toContain(
      "assunto (escolha no máximo uma): cancelamento, compra",
    );
    expect(note).toContain("sinal (escolha no máximo uma): urgente");
    expect(note).toContain("extra (pode usar mais de uma): vip");
    expect(note).toContain("solto (escolha no máximo uma): x");
    // And the key it came from is gone all the same.
    expect(
      (s.monitoring as Record<string, unknown>).labelGroups,
    ).toBeUndefined();
    expect(
      (s.monitoring as { window: { messages: number } }).window.messages,
    ).toBe(25);
    // Under the cap every reader clips at, so the agent's next save cannot fail on it.
    expect((note ?? "").length).toBeLessThanOrEqual(1500);
  });

  test("the watcher that was classifying keeps the tool that does it now", async () => {
    const r = await suDb.query(
      `SELECT enabled_tools FROM "agent_tool_selections"
        WHERE agent_id = $1 AND source = 'NATIVE'`,
      [String(id("carried"))],
    );
    expect(r.rows[0].enabled_tools).toEqual(["private_note", "set_labels"]);
  });

  test("an allowlist that already has it is not given it twice", async () => {
    const r = await suDb.query(
      `SELECT enabled_tools FROM "agent_tool_selections"
        WHERE agent_id = $1 AND source = 'NATIVE'`,
      [String(id("granted"))],
    );
    expect(r.rows[0].enabled_tools).toEqual(["set_labels", "private_note"]);
  });

  test("an agent with NO allowlist row is left without one", async () => {
    // No row means every native is allowed already; writing one would NARROW what the agent can do.
    const r = await suDb.query(
      `SELECT count(*) AS n FROM "agent_tool_selections" WHERE agent_id = $1`,
      [String(id("configured"))],
    );
    expect(Number(r.rows[0].n)).toBe(0);
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
