import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { normalizeToolName } from "@/graph/tools/toolName";

// Runs the ACTUAL migration file against the test database (a copy pasted here would drift, and
// $executeRawUnsafe rejects multiple statements). What it pins: a row named after a native is moved
// to the first free `<name>_N` in ITS tenant, the grant that references the row by id follows it
// untouched, every other row is byte-identical, the audit trail records the move and names the
// agents whose prompt still uses the old name, a re-run rewrites nothing, and FORCE ROW LEVEL
// SECURITY is back on the three tables it touches — the one it reads included — when the file ends.

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

async function tool(
  tenantId: bigint,
  name: string,
  label = name,
): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "tool_definitions" (tenant_id, name, label, url_template, allowed_hosts, created_at, updated_at)
     VALUES ($1, $2, $3, 'https://api.example.com/x', '{api.example.com}', NOW(), NOW()) RETURNING id`,
    [String(tenantId), name, label],
  );
  return BigInt(r.rows[0].id);
}

async function rowOf(id: bigint): Promise<{ name: string; label: string }> {
  const r = await suDb.query(
    'SELECT name, label FROM "tool_definitions" WHERE id = $1',
    [String(id)],
  );
  return r.rows[0];
}

async function agent(
  tenantId: bigint,
  name: string,
  prompt: string,
): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, NOW(), NOW()) RETURNING id`,
    [String(tenantId), name, prompt],
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

type AuditRow = {
  actor_type: string;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
};

async function auditOf(tenantId: bigint): Promise<AuditRow[]> {
  const r = await suDb.query(
    'SELECT actor_type, action, target, "before", "after" FROM "audit_logs" WHERE tenant_id = $1 ORDER BY id',
    [String(tenantId)],
  );
  return r.rows;
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
      // The console derives the name from the label (`normalizeToolName`, the single source of truth
      // there), so the label decides whether the row can be saved again: "Run code" derives the
      // reserved name and must follow; a label that never derived it is left alone.
      ids.a_run_code = await tool(a, "run_code", "Run code");
      // A label that reaches the reserved name only by shedding a diacritic (round 21): the console\'s
      // NFD step, which the file reproduces with a translate table generated from Unicode.
      ids.a_calc = await tool(a, "calculator", "Calculátor");
      ids.a_run_code_2 = await tool(a, "run_code_2");
      ids.a_handoff = await tool(a, "handoff_to_human");
      ids.a_lookup = await tool(a, "lookup_order");
      // Tenant B: the same native name, and nothing in the way — uniqueness is per tenant.
      ids.b_run_code = await tool(b, "run_code", "Validador");
      agentId = await agent(a, "granted", "p");
      await suDb.query(
        `INSERT INTO "agent_tool_selections" (tenant_id, agent_id, source, tool_definition_id, knowledge_base_ids, enabled_tools, created_at, updated_at)
       VALUES ($1, $2, 'HTTP', $3, '{}', '{}', NOW(), NOW())`,
        [String(a), String(agentId), String(ids.a_run_code)],
      );
      // Two more agents: one whose prompt names the tool that moves, one whose prompt does not.
      ids.agent_names_it = await agent(
        a,
        "names_it",
        "Para validar o documento, chame run_code com o CPF.",
      );
      ids.agent_does_not = await agent(a, "does_not", "Responda com educação.");
    });

    afterAll(async () => {
      for (const t of tenants) {
        await suDb.query('DELETE FROM "audit_logs" WHERE tenant_id = $1', [
          String(t),
        ]);
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

    // Round 20: `ToolEditModal.payloadOf` submits `normalizeToolName(label)` as the name on every
    // save, so a moved row whose label still derived the reserved name could never be saved again
    // from the console — an unrelated edit would submit `run_code` and meet the refusal.
    test("the label follows the name where the console would derive the old one from it", async () => {
      const a = await rowOf(ids.a_run_code as bigint);
      expect(a).toEqual({ name: "run_code_3", label: "Run code 3" });
      expect(normalizeToolName(a.label)).toBe(a.name);
      const h = await rowOf(ids.a_handoff as bigint);
      expect(h).toEqual({
        name: "handoff_to_human_2",
        label: "handoff_to_human 2",
      });
      expect(normalizeToolName(h.label)).toBe(h.name);
      const c = await rowOf(ids.a_calc as bigint);
      expect(c).toEqual({ name: "calculator_2", label: "Calculátor 2" });
      expect(normalizeToolName(c.label)).toBe(c.name);
      // A label that never derived the name is the operator's own; it does not move.
      expect(await rowOf(ids.b_run_code as bigint)).toEqual({
        name: "run_code_2",
        label: "Validador",
      });
    });

    // The file's derivation IS the console's, asked on every character its translate table names

    // (read off the file, so the two cannot drift), on their decomposed spellings, and on words the

    // two would answer differently if the table, the case fold, the collapse or the cap were off.

    test("the file derives a name from a label exactly as the console does", async () => {
      const table = /translate\(label, '([^']+)', '([^']*)'\)/.exec(sql);

      if (!table)
        throw new Error("the migration no longer carries a translate table");

      const named = [...(table[1] as string)];

      expect(named.length).toBeGreaterThan(400);

      const corpus = [
        ...named,

        ...named.map((ch) => ch.normalize("NFD")),

        "Calculátor",

        "Executar código",

        "Run code 2",

        "Ação!",

        "ØL",

        "łódź",

        "Straße",

        "",

        "É",

        "__x__",
        "a  b",

        "a".repeat(70),

        "e\u0301",

        "Ελληνικά",
      ];

      const r = await suDb.query(
        "SELECT x, pg_temp.console_tool_name(x) AS n FROM unnest($1::text[]) AS t(x)",

        [corpus],
      );

      const bySql = new Map<string, string>(
        r.rows.map((row: { x: string; n: string }) => [row.x, row.n]),
      );

      const diff = corpus

        .filter((x) => bySql.get(x) !== normalizeToolName(x))

        .map((x) => [x, bySql.get(x), normalizeToolName(x)]);

      expect(diff).toEqual([]);
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

    // The durable record (round 17). A prompt that names the tool now reaches the native, or a name
    // no tool answers to, and nothing in the console says why; the audit trail is where an upgrade's
    // own change belongs, under the system actor, one line per moved row and one per agent whose
    // prompt still names it — the operator's list of what to edit.
    test("writes the audit trail: one line per moved row, one per agent whose prompt names it", async () => {
      const [a, b] = tenants as [bigint, bigint];
      const inA = await auditOf(a);
      expect(inA.every((r) => r.actor_type === "system")).toBe(true);
      expect(inA.filter((r) => r.action === "tool.renamed_by_upgrade")).toEqual(
        [
          {
            actor_type: "system",
            action: "tool.renamed_by_upgrade",
            target: `tool:${ids.a_run_code}`,
            before: { name: "run_code", label: "Run code" },
            after: { name: "run_code_3", label: "Run code 3" },
          },
          {
            actor_type: "system",
            action: "tool.renamed_by_upgrade",
            target: `tool:${ids.a_calc}`,
            before: { name: "calculator", label: "Calculátor" },
            after: { name: "calculator_2", label: "Calculátor 2" },
          },
          {
            actor_type: "system",
            action: "tool.renamed_by_upgrade",
            target: `tool:${ids.a_handoff}`,
            before: { name: "handoff_to_human", label: "handoff_to_human" },
            after: { name: "handoff_to_human_2", label: "handoff_to_human 2" },
          },
        ],
      );
      expect(
        inA.filter((r) => r.action === "agent.prompt_names_renamed_tool"),
      ).toEqual([
        {
          actor_type: "system",
          action: "agent.prompt_names_renamed_tool",
          target: `agent:${ids.agent_names_it}`,
          before: null,
          after: { tool: "run_code", renamed: "run_code_3" },
        },
      ]);
      expect(inA).toHaveLength(4);
      expect((await auditOf(b)).map((r) => [r.action, r.target])).toEqual([
        ["tool.renamed_by_upgrade", `tool:${ids.b_run_code}`],
      ]);
    });

    test("a re-run rewrites no row at all, and adds no audit line", async () => {
      const versions = () =>
        suDb
          .query(
            'SELECT id::text AS id, xmin::text AS v FROM "tool_definitions" WHERE tenant_id = ANY($1::bigint[]) ORDER BY id',
            [tenants.map(String)],
          )
          .then((r) => r.rows);
      const audits = async () =>
        (await Promise.all(tenants.map(auditOf))).flat().length;
      const before = await versions();
      const lines = await audits();
      await suDb.query(sql);
      expect(await versions()).toEqual(before);
      expect(await audits()).toBe(lines);
    });

    test("FORCE ROW LEVEL SECURITY is back on the three tables when the file ends", async () => {
      const r = await suDb.query(
        "SELECT relname, relforcerowsecurity AS f FROM pg_class WHERE relname IN ('agents', 'audit_logs', 'tool_definitions') ORDER BY relname",
      );
      expect(r.rows).toEqual([
        { relname: "agents", f: true },
        { relname: "audit_logs", f: true },
        { relname: "tool_definitions", f: true },
      ]);
    });
  },
);
