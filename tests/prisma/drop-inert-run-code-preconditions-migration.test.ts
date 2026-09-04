import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";

// Runs the ACTUAL migration file against the test database. `run_code` stops being a name this
// release owns, so a precondition keyed to it is about to name nothing, and an inert rule is worse
// than no rule: the console lists guardable names and `run_code` is no longer one, so it sits in
// the settings bag where nobody can read it or remove it.
//
// Round 32 is the other half, and it is the half that cost the rewrite. Only a native name passes
// the write boundary, but an agent IMPORT copies a settings bag verbatim and the runtime honours a
// non-native key whose name matches a tool that exists, on purpose. So the key can be a LIVE guard
// on an HTTP tool of that name, and the two migrations around this one move exactly such a tool off
// `run_code` and put it back. Deleting unconditionally handed it back its name without its
// condition: callable, ungated, and nothing anywhere saying a guard had been dropped.
//
// Round 33 widened WHAT answers. An MCP server's tool names live upstream, but what reaches the
// model does not: the grant is fail-closed and allowlisted, so `agent_tool_selections.enabled_tools`
// is the list of names that server can answer to, in this database. A predicate that stopped at the
// two tables with a `name` column reinstated for MCP the exact hole round 32 closed for HTTP.
//
// What it pins: the key goes when nothing answers to the name, STAYS when something does (an HTTP
// tool, a code tool, an MCP grant naming it, and a spelling that only DERIVES the name), the
// agent's other preconditions and settings are untouched, an agent without the key is not
// rewritten, and FORCE ROW LEVEL SECURITY is back on all four tables.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260903150100_drop_inert_run_code_preconditions/migration.sql";

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

const RULE = (attr: string) => ({
  kind: "attribute",
  scope: "conversation",
  key: attr,
});

async function tenant(label: string): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "tenants" (name, slug, created_at, updated_at)
     VALUES ($1, $1 || '-' || floor(random() * 1e9)::text, NOW(), NOW()) RETURNING id`,
    [`rc-${label}`],
  );
  const id = BigInt(r.rows[0].id);
  tenants.push(id);
  return id;
}

async function agent(
  tenantId: bigint,
  name: string,
  settings: unknown,
): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
     VALUES ($1, $2, 'x', '{"provider":"openai","model":"gpt-4o-mini"}'::jsonb, $3::jsonb, NOW(), NOW())
     RETURNING id`,
    [String(tenantId), name, JSON.stringify(settings)],
  );
  return BigInt(r.rows[0].id);
}

async function httpTool(tenantId: bigint, name: string): Promise<void> {
  await suDb.query(
    `INSERT INTO "tool_definitions" (tenant_id, name, label, url_template, allowed_hosts, updated_at)
     VALUES ($1, $2, $2, 'https://example.com/x', ARRAY['example.com'], NOW())`,
    [String(tenantId), name],
  );
}

async function codeTool(tenantId: bigint, name: string): Promise<void> {
  await suDb.query(
    `INSERT INTO "code_tool_definitions" (tenant_id, name, label, description, code, updated_at)
     VALUES ($1, $2, $2, 'd', 'return 1', NOW())`,
    [String(tenantId), name],
  );
}

async function mcpGrant(
  tenantId: bigint,
  agentId: bigint,
  tools: string[],
): Promise<void> {
  const conn = await suDb.query(
    `INSERT INTO "mcp_server_connections" (tenant_id, name, transport, url, updated_at)
     VALUES ($1, 'srv', 'http', 'https://example.com/mcp', NOW()) RETURNING id`,
    [String(tenantId)],
  );
  await suDb.query(
    `INSERT INTO "agent_tool_selections"
       (tenant_id, agent_id, source, mcp_server_connection_id, knowledge_base_ids, enabled_tools, created_at, updated_at)
     VALUES ($1, $2, 'MCP', $3, ARRAY[]::bigint[], $4::text[], NOW(), NOW())`,
    [String(tenantId), String(agentId), conn.rows[0].id, tools],
  );
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

describe.skipIf(!dbUp)("migration: drop INERT run_code preconditions", () => {
  beforeAll(async () => {
    // A tenant where nothing answers to the name: the rule is inert and goes.
    const inert = await tenant("inert");
    ids.guarded = await agent(inert, "guarded", {
      temperature: 0.4,
      toolPreconditions: {
        run_code: RULE("cpf_ok"),
        set_custom_attribute: RULE("consent"),
      },
    });
    ids.untouched = await agent(inert, "untouched", {
      toolPreconditions: { set_custom_attribute: RULE("consent") },
    });
    ids.bare = await agent(inert, "bare", { temperature: 0.2 });
    // A tool of the same tenant under a DIFFERENT name is not the name answering.
    await httpTool(inert, "run_code_2");

    // The restore put an HTTP tool back under the name: the rule guards it and stays.
    const restored = await tenant("restored");
    ids.live = await agent(restored, "live", {
      toolPreconditions: { run_code: RULE("cpf_ok") },
    });
    await httpTool(restored, "run_code");

    // A code tool of the new kind holds the name: same answer, other table.
    const coded = await tenant("coded");
    ids.liveCode = await agent(coded, "live-code", {
      toolPreconditions: { run_code: RULE("cpf_ok") },
    });
    await codeTool(coded, "run_code");

    // Nothing in any table is named `run_code`, but an MCP grant allowlists it: that IS the name
    // reaching the model, and it is the only place this database can learn it.
    const viaMcp = await tenant("mcp");
    ids.liveMcp = await agent(viaMcp, "live-mcp", {
      toolPreconditions: { run_code: RULE("cpf_ok") },
    });
    await mcpGrant(viaMcp, ids.liveMcp as bigint, ["run_code", "search_docs"]);

    // The control for that arm: an MCP grant that allowlists something else leaves the rule inert.
    const otherMcp = await tenant("mcp-other");
    ids.inertMcp = await agent(otherMcp, "inert-mcp", {
      toolPreconditions: { run_code: RULE("cpf_ok") },
    });
    await mcpGrant(otherMcp, ids.inertMcp as bigint, ["search_docs"]);

    // A spelling that only DERIVES the name. The model calls it `run_code` either way, which is why
    // the migration asks the derivation and not the stored text.
    const derived = await tenant("derived");
    ids.liveDerived = await agent(derived, "live-derived", {
      toolPreconditions: { run_code: RULE("cpf_ok") },
    });
    await httpTool(derived, "Run__Code");
  });

  afterAll(async () => {
    if (!dbUp) return;
    for (const t of tenants) {
      await suDb.query('DELETE FROM "tenants" WHERE id = $1', [String(t)]);
    }
    await su?.end();
  });

  test("drops only the inert rule, and leaves every other setting alone", async () => {
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
    // The MCP arm's control: allowlisting other names does not save the rule.
    expect(await settingsOf(ids.inertMcp as bigint)).toEqual({
      toolPreconditions: {},
    });
  });

  test("keeps the rule wherever something still answers to the name", async () => {
    for (const key of ["live", "liveCode", "liveDerived", "liveMcp"] as const) {
      const s = await settingsOf(ids[key] as bigint);
      expect([key, s.toolPreconditions]).toEqual([
        key,
        { run_code: RULE("cpf_ok") },
      ]);
    }
  });

  test("a re-run rewrites nothing, and FORCE RLS is back on", async () => {
    const before = await updatedAtOf(ids.guarded as bigint);
    await suDb.query(sql);
    expect(await updatedAtOf(ids.guarded as bigint)).toBe(before);

    const r = await suDb.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
        WHERE relname IN ('agents', 'agent_tool_selections', 'tool_definitions', 'code_tool_definitions')
        ORDER BY relname`,
    );
    expect(r.rows).toEqual([
      { relname: "agent_tool_selections", relforcerowsecurity: true },
      { relname: "agents", relforcerowsecurity: true },
      { relname: "code_tool_definitions", relforcerowsecurity: true },
      { relname: "tool_definitions", relforcerowsecurity: true },
    ]);
  });
});
