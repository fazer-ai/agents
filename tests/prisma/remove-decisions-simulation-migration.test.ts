import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the actual migration file that removes the decisions engine's simulation mode. Three
// stored shapes: an agent in simulation (`apply: "shadow"`) is disabled with an audit line saying
// why, since its rules would otherwise start writing unreviewed; one already live (`enforce`) only
// loses the key; one with no decisions block is left as it was.
const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20261010180000_remove_decisions_simulation_mode/migration.sql";
const REASON =
  "simulation mode removed; agent disabled so it does not start writing without review";

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
let outsiderTenantId = 0n;
const ids: Record<string, bigint> = {};
const id = (k: string): bigint => ids[k] as bigint;
// What the replay left on this suite's agents, read before the rollback.
const seen = new Map<
  string,
  {
    row: { enabled: boolean; settings: Record<string, unknown> };
    audit: Record<string, unknown>[];
  }
>();
const after = (k: string) => {
  const v = seen.get(k);
  if (!v) throw new Error(`nothing read for ${k}`);
  return v;
};

// One statement at a time, on one connection, as `migrate deploy` runs it. Split at a semicolon
// that ends a line: the audit reason carries one inside its text.
function statementsOf(text: string): string[] {
  return text
    .replace(/^\s*--.*$/gm, "")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `${s};`);
}

const BLOCK = {
  provider: "openai",
  credentialRef: "vault:1",
  questions: [{ name: "q", type: "yes_no", instructions: "q" }],
  rules: [],
};

async function agent(
  name: string,
  settings: unknown,
  tenant = tenantId,
): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, enabled, mode, created_at, updated_at)
     VALUES ($1, $2, 'p', '{}'::jsonb, $3::jsonb, true, 'monitoring', NOW(), NOW()) RETURNING id`,
    [String(tenant), name, JSON.stringify(settings)],
  );
  return BigInt(r.rows[0].id);
}

async function row(
  agentId: bigint,
): Promise<{ enabled: boolean; settings: Record<string, unknown> }> {
  const r = await suDb.query(
    'SELECT enabled, settings FROM "agents" WHERE id = $1',
    [String(agentId)],
  );
  return r.rows[0];
}

async function auditOf(agentId: bigint): Promise<Record<string, unknown>[]> {
  const r = await suDb.query(
    `SELECT action, actor_type, "before", "after" FROM "audit_logs" WHERE tenant_id = $1 AND target = $2`,
    [String(tenantId), `agent:${agentId}`],
  );
  return r.rows;
}

describe.if(dbUp)("remove the decisions simulation mode", () => {
  beforeAll(async () => {
    const t = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["NOSIM", `nosim-${process.pid}`],
    );
    tenantId = BigInt(t.rows[0].id);
    ids.shadow = await agent("simulando", {
      monitoring: {
        engine: "decisions",
        decisions: { ...BLOCK, apply: "shadow" },
      },
    });
    ids.enforce = await agent("ao vivo", {
      monitoring: {
        engine: "decisions",
        decisions: { ...BLOCK, apply: "enforce" },
      },
    });
    // `apply` was optional and read as `shadow`: this one was in simulation without saying so.
    ids.implicit = await agent("simulando sem dizer", {
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    // A draft block left behind the language model governed nothing, so its agent stays on.
    ids.draft = await agent("rascunho no llm", {
      monitoring: { engine: "llm", decisions: BLOCK },
    });
    ids.none = await agent("sem decisoes", {
      monitoring: { engine: "llm", analysis: "incremental" },
    });
    // Another suite's fixture in the same database, in the shape the upgrade disables: the replay
    // must not reach it, or a parallel run fails that suite.
    const o = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["OUTRA", `nosim-outra-${process.pid}`],
    );
    outsiderTenantId = BigInt(o.rows[0].id);
    ids.outsider = await agent(
      "de outra suite",
      { monitoring: { engine: "decisions", decisions: BLOCK } },
      outsiderTenantId,
    );
    // Replayed inside a transaction that is rolled back once this suite has read what it wrote: the
    // migration updates every agent in the database, and another suite's fixtures share it. Its own
    // BEGIN and COMMIT are left out so the rollback covers every statement.
    await suDb.query("BEGIN");
    try {
      for (const statement of statementsOf(sql)) {
        if (/^(BEGIN|COMMIT);$/.test(statement)) continue;
        await suDb.query(statement);
      }
      for (const k of Object.keys(ids)) {
        if (k === "outsider") continue;
        seen.set(k, { row: await row(id(k)), audit: await auditOf(id(k)) });
      }
    } finally {
      await suDb.query("ROLLBACK");
    }
  });

  afterAll(async () => {
    await suDb.query('DELETE FROM "audit_logs" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
      String(outsiderTenantId),
    ]);
    await suDb.query("DELETE FROM tenants WHERE id = ANY($1)", [
      [String(tenantId), String(outsiderTenantId)],
    ]);
    await suDb.end();
  });

  test("an agent in simulation is disabled, loses the key, and the trail says why", async () => {
    const r = after("shadow").row;
    expect(r.enabled).toBe(false);
    expect(r.settings).toEqual({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    expect(after("shadow").audit).toEqual([
      {
        action: "agent.disabled_by_upgrade",
        actor_type: "system",
        before: { enabled: true, "monitoring.decisions.apply": "shadow" },
        after: { enabled: false, reason: REASON },
      },
    ]);
  });

  test("an agent on decisions with no apply was in simulation too, and is disabled", async () => {
    const r = after("implicit").row;
    expect(r.enabled).toBe(false);
    expect(after("implicit").audit).toEqual([
      {
        action: "agent.disabled_by_upgrade",
        actor_type: "system",
        before: {
          enabled: true,
          "monitoring.decisions.apply": "shadow (default)",
        },
        after: { enabled: false, reason: REASON },
      },
    ]);
  });

  test("a draft block behind the language model leaves its agent on", async () => {
    const r = after("draft").row;
    expect(r.enabled).toBe(true);
    expect(after("draft").audit).toEqual([]);
  });

  test("an agent already live keeps running and only loses the key", async () => {
    const r = after("enforce").row;
    expect(r.enabled).toBe(true);
    expect(r.settings).toEqual({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    expect(after("enforce").audit).toEqual([]);
  });

  test("the replay leaves the rest of the database as it was", async () => {
    const r = await row(id("outsider"));
    expect(r.enabled).toBe(true);
  });

  test("an agent without a decisions block is untouched", async () => {
    const r = after("none").row;
    expect(r.enabled).toBe(true);
    expect(r.settings).toEqual({
      monitoring: { engine: "llm", analysis: "incremental" },
    });
    expect(after("none").audit).toEqual([]);
  });
});
