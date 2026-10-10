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
const ids: Record<string, bigint> = {};
const id = (k: string): bigint => ids[k] as bigint;

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

async function agent(name: string, settings: unknown): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, enabled, mode, created_at, updated_at)
     VALUES ($1, $2, 'p', '{}'::jsonb, $3::jsonb, true, 'monitoring', NOW(), NOW()) RETURNING id`,
    [String(tenantId), name, JSON.stringify(settings)],
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
    ids.none = await agent("sem decisoes", {
      monitoring: { engine: "llm", analysis: "incremental" },
    });
    for (const statement of statementsOf(sql)) await suDb.query(statement);
    // Twice: the file must be safe to run again.
    for (const statement of statementsOf(sql)) await suDb.query(statement);
  });

  afterAll(async () => {
    await suDb.query('DELETE FROM "audit_logs" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query("DELETE FROM tenants WHERE id = $1", [String(tenantId)]);
    await suDb.end();
  });

  test("an agent in simulation is disabled, loses the key, and the trail says why", async () => {
    const r = await row(id("shadow"));
    expect(r.enabled).toBe(false);
    expect(r.settings).toEqual({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    expect(await auditOf(id("shadow"))).toEqual([
      {
        action: "agent.disabled_by_upgrade",
        actor_type: "system",
        before: { enabled: true, "monitoring.decisions.apply": "shadow" },
        after: { enabled: false, reason: REASON },
      },
    ]);
  });

  test("an agent already live keeps running and only loses the key", async () => {
    const r = await row(id("enforce"));
    expect(r.enabled).toBe(true);
    expect(r.settings).toEqual({
      monitoring: { engine: "decisions", decisions: BLOCK },
    });
    expect(await auditOf(id("enforce"))).toEqual([]);
  });

  test("an agent without a decisions block is untouched", async () => {
    const r = await row(id("none"));
    expect(r.enabled).toBe(true);
    expect(r.settings).toEqual({
      monitoring: { engine: "llm", analysis: "incremental" },
    });
    expect(await auditOf(id("none"))).toEqual([]);
  });
});
