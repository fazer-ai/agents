import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the ACTUAL migration file against the test database. What it pins: a row the earlier upgrade
// moved off `run_code` goes back, its audit line is written in the opposite direction, and the three
// rows that must NOT move stay put — one the operator has renamed since, one whose tenant has taken
// the name in the meantime (with a code tool, the kind that made `run_code` free), and one that was
// moved off a DIFFERENT native, which is still a native and still has to stay out of the way.
// A re-run rewrites nothing, and FORCE ROW LEVEL SECURITY is back on every table it touched.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260903150000_restore_http_tools_renamed_off_run_code/migration.sql";

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
// The tenant that has taken `run_code` back: its own, because "the name is free" is a question per
// tenant and a fixture that asks it in the tenant being restored would answer for everyone.
let takenTenantId = 0n;
const ids: Record<string, bigint> = {};

async function tool(
  name: string,
  label: string,
  tenant = tenantId,
): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "tool_definitions" (tenant_id, name, label, url_template, allowed_hosts, created_at, updated_at)
     VALUES ($1, $2, $3, 'https://api.example.com/x', '{api.example.com}', NOW(), NOW()) RETURNING id`,
    [String(tenant), name, label],
  );
  return BigInt(r.rows[0].id);
}

// The line the earlier upgrade wrote when it moved a row: what this migration reads to know what to
// put back, and the only thing that tells a moved row from one that always had that name.
async function movedBy(
  id: bigint,
  from: [string, string],
  to: [string, string],
  tenant = tenantId,
): Promise<void> {
  await suDb.query(
    `INSERT INTO "audit_logs" (tenant_id, actor_id, actor_type, action, target, "before", "after", created_at)
     VALUES ($1, NULL, 'system', 'tool.renamed_by_upgrade', $2, $3::jsonb, $4::jsonb, NOW())`,
    [
      String(tenant),
      `tool:${id}`,
      JSON.stringify({ name: from[0], label: from[1] }),
      JSON.stringify({ name: to[0], label: to[1] }),
    ],
  );
}

async function rowOf(id: bigint): Promise<{ name: string; label: string }> {
  const r = await suDb.query(
    'SELECT name, label FROM "tool_definitions" WHERE id = $1',
    [String(id)],
  );
  return r.rows[0];
}

describe.skipIf(!dbUp)("migration: restore tools renamed off run_code", () => {
  beforeAll(async () => {
    const t = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["RESTORE", `restore-${process.pid}`],
    );
    tenantId = BigInt(t.rows[0].id);
    const t2 = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["RESTORE-B", `restore-b-${process.pid}`],
    );
    takenTenantId = BigInt(t2.rows[0].id);

    ids.moved = await tool("run_code_2", "Run code 2");
    await movedBy(
      ids.moved,
      ["run_code", "Run code"],
      ["run_code_2", "Run code 2"],
    );

    // Renamed by the operator after the move: theirs now.
    ids.edited = await tool("executar_regra", "Executar regra");
    await movedBy(
      ids.edited,
      ["run_code", "Run code"],
      ["run_code_3", "Run code 3"],
    );

    // The name is taken again — by a code tool, the kind that made `run_code` free in the first
    // place — so there is nowhere to go back to.
    ids.blocked = await tool("run_code_4", "Run code 4", takenTenantId);
    await movedBy(
      ids.blocked,
      ["run_code", "Run code"],
      ["run_code_4", "Run code 4"],
      takenTenantId,
    );
    await suDb.query(
      `INSERT INTO "code_tool_definitions" (tenant_id, name, label, description, input_schema, code, created_at, updated_at)
       VALUES ($1, 'run_code', 'Run code', 'd', '{}'::jsonb, 'return 1', NOW(), NOW())`,
      [String(takenTenantId)],
    );

    // Moved off a native that is STILL native: staying out of the way is still the point.
    ids.other = await tool("calculator_2", "Calculator 2");
    await movedBy(
      ids.other,
      ["calculator", "Calculator"],
      ["calculator_2", "Calculator 2"],
    );
  });

  afterAll(async () => {
    if (dbUp && tenantId) {
      for (const id of [tenantId, takenTenantId]) {
        await suDb.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
          String(id),
        ]);
        await suDb.query("DELETE FROM tenants WHERE id = $1", [String(id)]);
      }
      await su?.end();
    }
  });

  test("the moved row goes back, the three others do not, and the trail says so", async () => {
    await suDb.query(sql);
    expect(await rowOf(ids.moved as bigint)).toEqual({
      name: "run_code",
      label: "Run code",
    });
    expect(await rowOf(ids.edited as bigint)).toEqual({
      name: "executar_regra",
      label: "Executar regra",
    });
    expect(await rowOf(ids.blocked as bigint)).toEqual({
      name: "run_code_4",
      label: "Run code 4",
    });
    expect(await rowOf(ids.other as bigint)).toEqual({
      name: "calculator_2",
      label: "Calculator 2",
    });
    const audit = await suDb.query(
      `SELECT target, "before" ->> 'name' AS from_name, "after" ->> 'name' AS to_name
       FROM "audit_logs"
       WHERE tenant_id = $1 AND "after" ->> 'name' = 'run_code'
       ORDER BY id`,
      [String(tenantId)],
    );
    expect(audit.rows).toEqual([
      {
        target: `tool:${ids.moved}`,
        from_name: "run_code_2",
        to_name: "run_code",
      },
    ]);
  });

  // Round 27: "the name is free" is a question about the name the MODEL sees. Names were only
  // canonicalized on write by this PR, so a database reaching this migration can hold `Run_Code`
  // from before, which `sanitizeToolName` derives `run_code` from at assembly. Compared exactly,
  // that row reads as free and the restore lands a SECOND tool answering to one name: the assembly
  // drops whichever comes second and neither can be saved from the console again.
  test("a legacy spelling that normalizes to run_code blocks the restore", async () => {
    const t2 = await suDb.query(
      `INSERT INTO "tenants" (name, slug, created_at, updated_at)
       VALUES ('rc-legacy', 'rc-legacy-' || floor(random() * 1e9)::text, NOW(), NOW()) RETURNING id`,
    );
    const legacyTenant = BigInt(t2.rows[0].id);
    const moved = await tool("run_code_2", "Run code 2", legacyTenant);
    await movedBy(
      moved,
      ["run_code", "Run code"],
      ["run_code_2", "Run code 2"],
      legacyTenant,
    );
    // Legal before this PR, and the model sees `run_code` for it.
    await tool("Run_Code", "Run Code", legacyTenant);

    await suDb.query(sql);

    expect(await rowOf(moved)).toEqual({
      name: "run_code_2",
      label: "Run code 2",
    });
    await suDb.query('DELETE FROM "audit_logs" WHERE tenant_id = $1', [
      String(legacyTenant),
    ]);
    await suDb.query('DELETE FROM "tool_definitions" WHERE tenant_id = $1', [
      String(legacyTenant),
    ]);
    await suDb.query('DELETE FROM "tenants" WHERE id = $1', [
      String(legacyTenant),
    ]);
  });

  test("a re-run rewrites nothing, and FORCE is back on every table it touched", async () => {
    const before = await suDb.query(
      'SELECT id, name, label, updated_at FROM "tool_definitions" WHERE tenant_id = $1 ORDER BY id',
      [String(tenantId)],
    );
    await suDb.query(sql);
    const after = await suDb.query(
      'SELECT id, name, label, updated_at FROM "tool_definitions" WHERE tenant_id = $1 ORDER BY id',
      [String(tenantId)],
    );
    expect(after.rows).toEqual(before.rows);
    const forced = await suDb.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE relname IN ('tool_definitions', 'code_tool_definitions', 'audit_logs')
       ORDER BY relname`,
    );
    expect(forced.rows).toEqual([
      { relname: "audit_logs", relforcerowsecurity: true },
      { relname: "code_tool_definitions", relforcerowsecurity: true },
      { relname: "tool_definitions", relforcerowsecurity: true },
    ]);
  });
});
