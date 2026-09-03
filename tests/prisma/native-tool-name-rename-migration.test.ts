import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the ACTUAL migration file against the test database (a copy pasted here would drift, and
// $executeRawUnsafe rejects multiple statements). What it pins: a row named after a native is moved
// to the first free `<name>_N` in ITS tenant, the grant that references the row by id follows it
// untouched, every other row is byte-identical, a re-run rewrites nothing, and FORCE ROW LEVEL
// SECURITY is back on the table when the file ends.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260903120000_rename_http_tools_named_after_natives/migration.sql";

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

const tenants: bigint[] = [];
const ids: Record<string, bigint> = {};
let agentId = 0n;

async function tool(tenantId: bigint, name: string): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "tool_definitions" (tenant_id, name, label, url_template, allowed_hosts, created_at, updated_at)
     VALUES ($1, $2, $2, 'https://api.example.com/x', '{api.example.com}', NOW(), NOW()) RETURNING id`,
    [String(tenantId), name],
  );
  return BigInt(r.rows[0].id);
}

async function nameOf(id: bigint): Promise<string> {
  const r = await suDb.query(
    'SELECT name FROM "tool_definitions" WHERE id = $1',
    [String(id)],
  );
  return r.rows[0]?.name;
}

describe.skipIf(!dbUp)(
  "migration: rename HTTP tools named after natives",
  () => {
    beforeAll(async () => {
      for (const slug of ["a", "b"]) {
        const t = await suDb.query(
          "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
          [`NATMIG-${slug}`, `natmig-${slug}-${process.pid}`],
        );
        tenants.push(BigInt(t.rows[0].id));
      }
      const [a, b] = tenants as [bigint, bigint];
      // Tenant A: the native name, its `_2` already taken, a second native name, and a bystander.
      ids.a_run_code = await tool(a, "run_code");
      ids.a_run_code_2 = await tool(a, "run_code_2");
      ids.a_handoff = await tool(a, "handoff_to_human");
      ids.a_lookup = await tool(a, "lookup_order");
      // Tenant B: the same native name, and nothing in the way — uniqueness is per tenant.
      ids.b_run_code = await tool(b, "run_code");
      const ag = await suDb.query(
        `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
       VALUES ($1, 'ag', 'p', '{}'::jsonb, '{}'::jsonb, NOW(), NOW()) RETURNING id`,
        [String(a)],
      );
      agentId = BigInt(ag.rows[0].id);
      await suDb.query(
        `INSERT INTO "agent_tool_selections" (tenant_id, agent_id, source, tool_definition_id, knowledge_base_ids, enabled_tools, created_at, updated_at)
       VALUES ($1, $2, 'HTTP', $3, '{}', '{}', NOW(), NOW())`,
        [String(a), String(agentId), String(ids.a_run_code)],
      );
    });

    afterAll(async () => {
      for (const t of tenants) {
        await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
          String(t),
        ]);
        await suDb.query(
          'DELETE FROM "tool_definitions" WHERE tenant_id = $1',
          [String(t)],
        );
        await suDb.query("DELETE FROM tenants WHERE id = $1", [String(t)]);
      }
      await suDb.end();
    });

    test("runs, and moves each native-named row to the first free name in its own tenant", async () => {
      await suDb.query(sql);
      expect(await nameOf(ids.a_run_code as bigint)).toBe("run_code_3");
      expect(await nameOf(ids.a_handoff as bigint)).toBe("handoff_to_human_2");
      expect(await nameOf(ids.b_run_code as bigint)).toBe("run_code_2");
    });

    test("leaves every other row alone, the one already carrying the suffix included", async () => {
      expect(await nameOf(ids.a_run_code_2 as bigint)).toBe("run_code_2");
      expect(await nameOf(ids.a_lookup as bigint)).toBe("lookup_order");
    });

    test("the grant follows the row: it references the id, never the name", async () => {
      const r = await suDb.query(
        'SELECT tool_definition_id::text AS id FROM "agent_tool_selections" WHERE agent_id = $1',
        [String(agentId)],
      );
      expect(r.rows.map((x: { id: string }) => x.id)).toEqual([
        String(ids.a_run_code),
      ]);
    });

    test("a re-run rewrites no row at all", async () => {
      const versions = () =>
        suDb
          .query(
            'SELECT id::text AS id, xmin::text AS v FROM "tool_definitions" WHERE tenant_id = ANY($1::bigint[]) ORDER BY id',
            [tenants.map(String)],
          )
          .then((r) => r.rows);
      const before = await versions();
      await suDb.query(sql);
      expect(await versions()).toEqual(before);
    });

    test("FORCE ROW LEVEL SECURITY is back on the table when the file ends", async () => {
      const r = await suDb.query(
        "SELECT relforcerowsecurity AS f FROM pg_class WHERE relname = 'tool_definitions'",
      );
      expect(r.rows[0]?.f).toBe(true);
    });
  },
);
