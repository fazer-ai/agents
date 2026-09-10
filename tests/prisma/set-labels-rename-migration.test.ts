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
//     vanish from the tool description on the next turn;
//   - the PRECONDITION, whose loss is not a lost capability but a lost GUARD:
//     `readToolPreconditions` keeps whatever name it finds and the runtime matches by tool name, so
//     a rule left under the old name stops matching and the fenced tool runs unfenced with the
//     editor still showing the fence. The write side is stricter and would refuse the agent's next
//     settings save outright, since it checks the KEY against the native catalog.
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
let tenant2Id = 0n;
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

async function bagOf(
  id: bigint,
  key: "toolGuidance" | "toolPreconditions",
): Promise<Record<string, unknown>> {
  const r = await suDb.query('SELECT settings FROM "agents" WHERE id = $1', [
    String(id),
  ]);
  return (r.rows[0].settings as Record<string, Record<string, unknown>>)[
    key
  ] as Record<string, unknown>;
}

const guidanceOf = (id: bigint) => bagOf(id, "toolGuidance");
const preconditionsOf = (id: bigint) => bagOf(id, "toolPreconditions");

// RUNS THE FILE ONE STATEMENT AT A TIME, on one connection, because that is what `migrate deploy`
// does and it is the only way this file's atomicity means anything. Handing the whole text to `pg`
// proves nothing: a multi-statement string goes out over the simple-query protocol, which Postgres
// wraps in an IMPLICIT transaction, so the file would be atomic whatever it says and deleting its
// `BEGIN` would break no assertion (measured in #555, recorded in `.claude/rules/prisma.md`).
//
// Dollar quoting is the part the scanner in `mcp-oauth-consent-action-rename-migration.test.ts`
// refuses to see through, and this file has two bodies in it (`$fn$` and `$$`), so the tag is
// tracked: inside one, nothing terminates a statement until its matching closer.
function statementsOf(text: string): string[] {
  const bare = text.replace(/^\s*--.*$/gm, "");
  const out: string[] = [];
  let current = "";
  let i = 0;
  let inLiteral = false;
  let tag: string | null = null;
  while (i < bare.length) {
    const ch = bare[i] as string;
    if (tag !== null) {
      if (bare.startsWith(tag, i)) {
        current += tag;
        i += tag.length;
        tag = null;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (!inLiteral && ch === "$") {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(bare.slice(i));
      // `$1` and friends are parameters, not tags; only a well-formed `$tag$` opens a body.
      if (m) {
        tag = m[0];
        current += tag;
        i += tag.length;
        continue;
      }
    }
    // An escaped quote inside a literal is doubled, which toggles twice and lands back inside it.
    if (ch === "'") inLiteral = !inLiteral;
    if (ch === ";" && !inLiteral) {
      if (current.trim()) out.push(`${current.trim()};`);
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) {
    throw new Error(
      "statementsOf: the file does not end on a statement terminator",
    );
  }
  return out;
}

async function runMigration(text: string): Promise<void> {
  try {
    for (const statement of statementsOf(text)) await suDb.query(statement);
  } catch (e) {
    // A failed migration drops the engine's connection, which rolls back whatever transaction the
    // file had open. This is that teardown, on a client the rest of the file shares.
    await suDb.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

async function forced(): Promise<boolean> {
  const r = await suDb.query(
    "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'agents'",
  );
  return r.rows[0].relforcerowsecurity as boolean;
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

    // ...and a CODE tool in the same namespace. `set_labels` is a legal code-tool name on the base
    // branch (the write boundary refuses only the natives of the day), and code tools reach
    // `dropDuplicateToolNames` like every other source, so this row is dropped by the reservation
    // exactly as the HTTP one would be. In a tenant of its own, so the two walks do not interfere.
    const mkCode = async (
      tid: bigint,
      name: string,
      label: string,
    ): Promise<bigint> => {
      const r = await suDb.query(
        `INSERT INTO "code_tool_definitions" (tenant_id, name, label, description, code, created_at, updated_at)
         VALUES ($1, $2, $3, 'd', 'return {}', NOW(), NOW()) RETURNING id`,
        [String(tid), name, label],
      );
      return BigInt(r.rows[0].id);
    };
    const t2 = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["SETLBL2", `setlbl2-${process.pid}`],
    );
    tenant2Id = BigInt(t2.rows[0].id);
    ids.code = await mkCode(tenant2Id, "set_labels", "Set labels");
    // An IMPORTED agent whose rules were written for the custom tool: the write boundary refuses a
    // non-native precondition key, so this bag can only have arrived verbatim from an import. It
    // GRANTS the code tool, which is what makes `set_labels` mean that tool and not the native.
    ids.importer = await (async () => {
      const r = await suDb.query(
        `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
         VALUES ($1, 'importer', 'p', '{}'::jsonb, $2::jsonb, NOW(), NOW()) RETURNING id`,
        [
          String(tenant2Id),
          JSON.stringify({
            toolPreconditions: {
              set_labels: {
                kind: "attribute",
                scope: "conversation",
                key: "pode_etiquetar",
              },
            },
            toolGuidance: { set_labels: "só depois da triagem" },
          }),
        ],
      );
      return BigInt(r.rows[0].id);
    })();
    await suDb.query(
      `INSERT INTO "agent_tool_selections" (tenant_id, agent_id, source, code_tool_definition_id, knowledge_base_ids, enabled_tools, created_at, updated_at)
       VALUES ($1, $2, 'CODE', $3, '{}', '{}', NOW(), NOW())`,
      [String(tenant2Id), String(ids.importer), String(ids.code)],
    );
    // ...and one whose DESTINATION key is already taken (a leftover `set_labels_2` rule from an
    // earlier import). The value has nowhere to go, but the old key still has to leave: left
    // behind, the native move below reads it as the winning native rule and deletes the real one.
    ids.occupied = await (async () => {
      const r = await suDb.query(
        `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
         VALUES ($1, 'occupied', 'p', '{}'::jsonb, $2::jsonb, NOW(), NOW()) RETURNING id`,
        [
          String(tenant2Id),
          JSON.stringify({
            toolPreconditions: {
              set_labels: {
                kind: "attribute",
                scope: "conversation",
                key: "da_custom",
              },
              set_labels_3: {
                kind: "attribute",
                scope: "conversation",
                key: "ja_estava",
              },
              assign_label: {
                kind: "attribute",
                scope: "conversation",
                key: "do_nativo",
              },
            },
          }),
        ],
      );
      return BigInt(r.rows[0].id);
    })();
    await suDb.query(
      `INSERT INTO "agent_tool_selections" (tenant_id, agent_id, source, code_tool_definition_id, knowledge_base_ids, enabled_tools, created_at, updated_at)
       VALUES ($1, $2, 'CODE', $3, '{}', '{}', NOW(), NOW())`,
      [String(tenant2Id), String(ids.occupied), String(ids.code)],
    );

    // ...and one that does NOT grant it. For this agent `set_labels` means the native tool the
    // moment this ships, so its rule is already about the right thing and must not move.
    ids.bystander = await (async () => {
      const r = await suDb.query(
        `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
         VALUES ($1, 'bystander', 'p', '{}'::jsonb, $2::jsonb, NOW(), NOW()) RETURNING id`,
        [
          String(tenant2Id),
          JSON.stringify({
            toolPreconditions: {
              set_labels: {
                kind: "attribute",
                scope: "conversation",
                key: "nativo",
              },
            },
          }),
        ],
      );
      return BigInt(r.rows[0].id);
    })();
    // The candidate `set_labels_2` is free among HTTP tools in THIS tenant and taken by a code
    // tool: a free-name search that scans one table walks the moved row onto this one.
    ids.code_taken = await mkCode(tenant2Id, "set_labels_2", "Outro code");

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

    // The guard. Same three shapes as the guidance, because the same two UPDATEs move it.
    const fence = (key: string) => ({
      kind: "attribute",
      scope: "conversation",
      key,
    });
    ids.fenced = await agent(
      "fenced",
      JSON.stringify({
        toolPreconditions: {
          assign_label: fence("triagem_ok"),
          resolve_conversation: fence("pode_encerrar"),
        },
      }),
    );
    ids.fenced_both = await agent(
      "fenced_both",
      JSON.stringify({
        toolPreconditions: {
          assign_label: fence("velho"),
          set_labels: fence("novo"),
        },
      }),
    );
    ids.fenced_junk = await agent(
      "fenced_junk",
      JSON.stringify({ toolPreconditions: 7, maxToolCalls: 5 }),
    );
  });

  afterAll(async () => {
    await suDb.query('DELETE FROM "audit_logs" WHERE tenant_id = ANY($1)', [
      [String(tenantId), String(tenant2Id)],
    ]);
    await suDb.query(
      'DELETE FROM "agent_tool_selections" WHERE tenant_id = ANY($1)',
      [[String(tenantId), String(tenant2Id)]],
    );
    await suDb.query('DELETE FROM "agents" WHERE tenant_id = ANY($1)', [
      [String(tenantId), String(tenant2Id)],
    ]);
    await suDb.query('DELETE FROM "tool_definitions" WHERE tenant_id = $1', [
      String(tenantId),
    ]);
    await suDb.query(
      'DELETE FROM "code_tool_definitions" WHERE tenant_id = $1',
      [String(tenant2Id)],
    );
    await suDb.query("DELETE FROM tenants WHERE id = ANY($1)", [
      [String(tenantId), String(tenant2Id)],
    ]);
    await suDb.end();
  });

  test("the grant follows the rename, and never lists the new name twice", async () => {
    await runMigration(sql);
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

  test("the operator's tool FENCE moves with the name, so the tool stays guarded", async () => {
    // The half whose loss is silent in the opposite direction from the note: the editor keeps
    // showing the rule, the runtime stops matching it, and the tool the operator fenced runs.
    expect(await preconditionsOf(id("fenced"))).toEqual({
      set_labels: {
        kind: "attribute",
        scope: "conversation",
        key: "triagem_ok",
      },
      resolve_conversation: {
        kind: "attribute",
        scope: "conversation",
        key: "pode_encerrar",
      },
    });
    expect(await preconditionsOf(id("fenced_both"))).toEqual({
      set_labels: { kind: "attribute", scope: "conversation", key: "novo" },
    });
    const junk = await suDb.query(
      'SELECT settings FROM "agents" WHERE id = $1',
      [String(id("fenced_junk"))],
    );
    expect(junk.rows[0].settings).toEqual({
      toolPreconditions: 7,
      maxToolCalls: 5,
    });
  });

  test("the custom tool's old key leaves even when its destination is taken", async () => {
    const conds = await preconditionsOf(id("occupied"));
    // The destination keeps the value it already had: it is the operator's most recent word.
    expect((conds.set_labels_3 as { key?: string })?.key).toBe("ja_estava");
    // And `set_labels` now holds the NATIVE's rule, because the custom tool's key left first. Left
    // behind, it would have been read as the winning native rule and the real one deleted.
    expect((conds.set_labels as { key?: string })?.key).toBe("do_nativo");
    expect(conds.assign_label).toBeUndefined();
  });

  test("no agent is left holding the old key under either name", async () => {
    // The write side checks the KEY against the native catalog, so a leftover `assign_label` there
    // does not just go unread: it refuses the agent's next settings save entirely.
    const r = await suDb.query(
      `SELECT count(*)::int AS n FROM "agents"
        WHERE tenant_id = $1
          AND (jsonb_exists(settings -> 'toolGuidance', 'assign_label')
            OR jsonb_exists(settings -> 'toolPreconditions', 'assign_label'))`,
      [String(tenantId)],
    );
    expect(r.rows[0].n).toBe(0);
  });

  test("a CODE tool on the reserved name is moved too, and the walk sees both tables", async () => {
    const r = await suDb.query(
      'SELECT name, label FROM "code_tool_definitions" WHERE id = $1',
      [String(id("code"))],
    );
    // `set_labels_2` is taken by a code tool in this tenant, so the walk has to reach `_3` — which
    // a search scanning only `tool_definitions` would never do, since that table is empty here.
    expect(r.rows[0]).toEqual({ name: "set_labels_3", label: "Set labels 3" });
    expect(normalizeToolName(r.rows[0].label)).toBe(r.rows[0].name);
    const untouched = await suDb.query(
      'SELECT name FROM "code_tool_definitions" WHERE id = $1',
      [String(id("code_taken"))],
    );
    expect(untouched.rows[0].name).toBe("set_labels_2");
    // The audit target carries the kind: the two tables have independent id sequences.
    const audit = await suDb.query(
      `SELECT target FROM "audit_logs" WHERE tenant_id = $1 AND action = 'tool.renamed_by_upgrade'`,
      [String(tenant2Id)],
    );
    expect(audit.rows.map((x) => x.target)).toEqual([
      `code_tool:${id("code")}`,
    ]);
  });

  test("an imported rule follows the custom tool it was written for", async () => {
    // Left behind it would not go inert: `set_labels` is a native name after this migration, so the
    // operator's guard would re-attach to a tool nobody guarded, with no unmatched warning either.
    const moved = await suDb.query(
      'SELECT settings FROM "agents" WHERE id = $1',
      [String(id("importer"))],
    );
    const s = moved.rows[0].settings as Record<string, Record<string, unknown>>;
    expect(s.toolPreconditions).toEqual({
      set_labels_3: {
        kind: "attribute",
        scope: "conversation",
        key: "pode_etiquetar",
      },
    });
    expect(s.toolGuidance).toEqual({ set_labels_3: "só depois da triagem" });
    // The agent that does not grant the renamed tool keeps its rule where it is.
    const kept = await suDb.query(
      'SELECT settings FROM "agents" WHERE id = $1',
      [String(id("bystander"))],
    );
    expect(
      (kept.rows[0].settings as Record<string, Record<string, unknown>>)
        .toolPreconditions,
    ).toEqual({
      set_labels: { kind: "attribute", scope: "conversation", key: "nativo" },
    });
  });

  test("re-running it rewrites nothing", async () => {
    await runMigration(sql);
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

  // WHAT THE `BEGIN` BUYS, asserted by making the file fail on purpose rather than by trusting the
  // keyword is there. `migrate deploy` runs the `.sql` outside a transaction, so without one a
  // failure between the lift and the restore leaves four tables no longer binding their own owner
  // to the tenant policy — with the migration marked applied and nothing in any log.
  test("a failure after the RLS lift restores FORCE instead of leaving it off", async () => {
    expect(await forced()).toBe(true);
    const broken = sql.replace(
      'ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;',
      'SELECT 1 / 0;\nALTER TABLE "agents" FORCE ROW LEVEL SECURITY;',
    );
    expect(broken).not.toBe(sql);
    await expect(runMigration(broken)).rejects.toThrow();
    expect(await forced()).toBe(true);
  });

  test("the old name is gone from the catalog, so nothing reads it again", () => {
    expect(NATIVE_TOOL_NAMES).toContain("set_labels");
    expect(NATIVE_TOOL_NAMES as readonly string[]).not.toContain(
      "assign_label",
    );
  });
});
