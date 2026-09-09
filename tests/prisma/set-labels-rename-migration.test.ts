import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { normalizeToolName } from "@/graph/tools/toolName";

// Runs the ACTUAL migration file (a copy pasted here would drift, and $executeRawUnsafe rejects
// multiple statements). `assign_label` became `set_labels`, and the two halves under test are the
// ones a native rename does not usually need, because the OLD name is stored in tenant rows that
// every reader silently discards when it stops recognising them:
//
//   - the GRANT: an explicit NATIVE row is the exact allowlist, so an agent granted only
//     `assign_label` would come up with NO label tool and nothing anywhere would say why;
//   - the GUIDANCE: `readToolGuidance` drops keys outside the catalog, so the operator's note would
//     vanish from the tool description on the next turn.
//
// Plus the usual half: an HTTP tool a tenant already named `set_labels` is moved off the name the
// assembly now reserves.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260909120000_rename_http_tools_named_after_natives/migration.sql";

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

// The keys are filled in beforeAll; reading one before then is a bug in this file, not a case.
const id = (k: string): bigint => ids[k] as bigint;

async function agent(name: string, settings: string): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
     VALUES ($1, $2, 'p', '{}'::jsonb, $3::jsonb, NOW(), NOW()) RETURNING id`,
    [String(tenantId), name, settings],
  );
  return BigInt(r.rows[0].id);
}

async function grant(agentId: bigint, tools: string[]): Promise<bigint> {
  const r = await suDb.query(
    `INSERT INTO "agent_tool_selections" (tenant_id, agent_id, source, knowledge_base_ids, enabled_tools, created_at, updated_at)
     VALUES ($1, $2, 'NATIVE', '{}', $3, NOW(), NOW()) RETURNING id`,
    [String(tenantId), String(agentId), tools],
  );
  return BigInt(r.rows[0].id);
}

async function grantedTools(id: bigint): Promise<string[]> {
  const r = await suDb.query(
    'SELECT enabled_tools FROM "agent_tool_selections" WHERE id = $1',
    [String(id)],
  );
  return r.rows[0].enabled_tools as string[];
}

async function guidanceOf(id: bigint): Promise<Record<string, unknown>> {
  const r = await suDb.query('SELECT settings FROM "agents" WHERE id = $1', [
    String(id),
  ]);
  return (r.rows[0].settings as Record<string, Record<string, unknown>>)
    .toolGuidance as Record<string, unknown>;
}

describe.skipIf(!dbUp)("migration: assign_label → set_labels", () => {
  beforeAll(async () => {
    const t = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["SETLBL", `setlbl-${process.pid}`],
    );
    tenantId = BigInt(t.rows[0].id);

    // An HTTP tool already carrying the name that is about to become native, and its `_2` taken, so
    // the move has to walk. The label derives the name, so it follows.
    const mk = async (name: string, label: string) => {
      const r = await suDb.query(
        `INSERT INTO "tool_definitions" (tenant_id, name, label, url_template, allowed_hosts, created_at, updated_at)
         VALUES ($1, $2, $3, 'https://api.example.com/x', '{api.example.com}', NOW(), NOW()) RETURNING id`,
        [String(tenantId), name, label],
      );
      return BigInt(r.rows[0].id);
    };
    ids.http = await mk("set_labels", "Set labels");
    ids.http_taken = await mk("set_labels_2", "Outro");

    ids.only_old = await agent("only_old", "{}");
    ids.grant_only_old = await grant(ids.only_old, ["assign_label"]);
    ids.mixed = await agent("mixed", "{}");
    ids.grant_mixed = await grant(ids.mixed, [
      "private_note",
      "assign_label",
      "handoff_to_human",
    ]);
    // Already carries the new name beside the old one (an operator who granted the HTTP tool under
    // the native's name): the old one goes, the new one is not duplicated.
    ids.both = await agent("both", "{}");
    ids.grant_both = await grant(ids.both, ["assign_label", "set_labels"]);
    ids.untouched = await agent("untouched", "{}");
    ids.grant_untouched = await grant(ids.untouched, ["private_note"]);

    ids.noted = await agent(
      "noted",
      JSON.stringify({
        toolGuidance: {
          assign_label: "Use 'vip' só para clientes premium.",
          set_custom_attribute: "Só o estágio do lead.",
        },
        maxToolCalls: 7,
      }),
    );
    ids.noted_both = await agent(
      "noted_both",
      JSON.stringify({
        toolGuidance: { assign_label: "velho", set_labels: "novo" },
      }),
    );
    // toolGuidance that is not an object at all, and one that is absent: neither has a key to move,
    // and a `#>` on them would blank the whole settings bag.
    ids.noted_junk = await agent(
      "noted_junk",
      JSON.stringify({ toolGuidance: "nada", maxToolCalls: 3 }),
    );
    ids.noted_none = await agent(
      "noted_none",
      JSON.stringify({ maxToolCalls: 4 }),
    );
  });

  afterAll(async () => {
    await suDb.query('DELETE FROM "audit_logs" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query(
      'DELETE FROM "agent_tool_selections" WHERE tenant_id = $1',
      [String(tenantId)],
    );
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query('DELETE FROM "tool_definitions" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query("DELETE FROM tenants WHERE id = $1", [String(tenantId)]);
    await suDb.end();
  });

  test("the grant follows the rename, and never lists the new name twice", async () => {
    await suDb.query(sql);
    expect(await grantedTools(id("grant_only_old"))).toEqual(["set_labels"]);
    // Order is the operator's; only the one entry changes.
    expect(await grantedTools(id("grant_mixed"))).toEqual([
      "private_note",
      "set_labels",
      "handoff_to_human",
    ]);
    expect(await grantedTools(id("grant_both"))).toEqual(["set_labels"]);
    expect(await grantedTools(id("grant_untouched"))).toEqual(["private_note"]);
  });

  test("the operator's guidance note moves to the new key, and nothing else in the bag moves", async () => {
    expect(await guidanceOf(id("noted"))).toEqual({
      set_labels: "Use 'vip' só para clientes premium.",
      set_custom_attribute: "Só o estágio do lead.",
    });
    const r = await suDb.query('SELECT settings FROM "agents" WHERE id = $1', [
      String(id("noted")),
    ]);
    expect((r.rows[0].settings as { maxToolCalls: number }).maxToolCalls).toBe(
      7,
    );
    // Both keys: the new one is the operator's most recent word and stands; the old one goes.
    expect(await guidanceOf(id("noted_both"))).toEqual({ set_labels: "novo" });
  });

  test("a toolGuidance that is not an object is left exactly as it was", async () => {
    const junk = await suDb.query(
      'SELECT settings FROM "agents" WHERE id = $1',
      [String(id("noted_junk"))],
    );
    expect(junk.rows[0].settings).toEqual({
      toolGuidance: "nada",
      maxToolCalls: 3,
    });
    const none = await suDb.query(
      'SELECT settings FROM "agents" WHERE id = $1',
      [String(id("noted_none"))],
    );
    expect(none.rows[0].settings).toEqual({ maxToolCalls: 4 });
  });

  test("an HTTP tool already named set_labels is moved off the reserved name", async () => {
    const r = await suDb.query(
      'SELECT name, label FROM "tool_definitions" WHERE id = $1',
      [String(id("http"))],
    );
    expect(r.rows[0]).toEqual({ name: "set_labels_3", label: "Set labels 3" });
    expect(normalizeToolName(r.rows[0].label)).toBe(r.rows[0].name);
  });

  test("re-running it rewrites nothing", async () => {
    await suDb.query(sql);
    expect(await grantedTools(id("grant_mixed"))).toEqual([
      "private_note",
      "set_labels",
      "handoff_to_human",
    ]);
    expect(await guidanceOf(id("noted"))).toEqual({
      set_labels: "Use 'vip' só para clientes premium.",
      set_custom_attribute: "Só o estágio do lead.",
    });
    // The HTTP row moved on the first run, so the second finds nothing named `set_labels` and the
    // row does NOT walk again — a migration that renamed on every apply would rename forever.
    const r = await suDb.query(
      'SELECT name FROM "tool_definitions" WHERE id = $1',
      [String(id("http"))],
    );
    expect(r.rows[0].name).toBe("set_labels_3");
  });

  test("the old name is gone from the catalog, so nothing reads it again", () => {
    expect(NATIVE_TOOL_NAMES).toContain("set_labels");
    expect(NATIVE_TOOL_NAMES as readonly string[]).not.toContain(
      "assign_label",
    );
  });
});
