import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { buildNativeTools } from "@/graph/tools/native";
import { readToolGuidance } from "@/modules/agents/tool-guidance";
import { readHandoffConfig } from "@/modules/handoff/settings";
import { readKanbanConfig } from "@/modules/kanban/settings";
import { classOf, MODEL_WITH_TOOLS } from "../utils/operator-text-classes";

// Runs the ACTUAL migration file, for the reason the sibling file gives: a copy pasted here would
// drift, and `$executeRawUnsafe` rejects multiple statements.
//
// WHAT IS UNDER TEST (issue #604). `20260909120000_rename_http_tools_named_after_natives` moved
// `assign_label` to `set_labels` and rewrote the PROSE of exactly one operator-authored field, the
// system prompt. For `toolGuidance` it moved the KEY and left the value's text alone, so
// `readToolGuidance` went on appending, to the description of `set_labels`, a rule about calling
// `assign_label`, a name the model is never shown and cannot call. This file covers the six
// settings fields whose text reaches a model, and the five that do not.
//
// THE POPULATION IS MEASURED, NOT ASSUMED. The issue's own table lists five prose fields; walking
// `src/modules/agents/text-caps.ts` (which says of itself that it is the one place that knows where
// operator text lives) gives twelve kinds of field, six of them model-facing. Two the issue did not
// name (`guardrails.customPolicy` and `guardrails.output.generationPrompt`) reach an analysis and
// a rewrite prompt, and one it did name (`followUps[].instructions`) is not the stored path, which
// is `followUp.steps[i].instructions`. A migration addressing the path the issue wrote would have
// rewritten nothing at all.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260917120000_rename_tool_names_in_operator_settings_text/migration.sql";

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
// The defect, captured from the seeded rows BEFORE the migration runs. Without it every assertion
// below would also pass on a migration that rewrote nothing and a seed that was already clean: this
// is the control that says the file measures the rewrite.
let staleBefore: string | undefined;
// The serialized bag of the newline agent, read BEFORE the migration: it is the only moment the
// shape that defeats a word-boundary prefilter is still on disk.
let serializedBefore = "";
const ids: Record<string, bigint> = {};
const id = (k: string): bigint => ids[k] as bigint;

async function agent(
  key: string,
  settings: unknown,
  opts: { tenant?: bigint; prompt?: string } = {},
): Promise<void> {
  const r = await suDb.query(
    `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
     VALUES ($1, $2, $3, '{}'::jsonb, $4::jsonb, NOW(), NOW()) RETURNING id`,
    [
      String(opts.tenant ?? tenantId),
      key,
      opts.prompt ?? "p",
      JSON.stringify(settings),
    ],
  );
  ids[key] = BigInt(r.rows[0].id);
}

async function toolDef(
  key: string,
  table: "tool_definitions" | "code_tool_definitions",
  description: string | null,
  inputSchema: unknown,
): Promise<void> {
  const cols =
    table === "tool_definitions"
      ? `(tenant_id, name, label, description, method, url_template, allowed_hosts, headers, input_schema, ack_message, created_at, updated_at)
         VALUES ($1, $2, $2, $3, 'GET', 'https://example.com/v1', ARRAY['example.com'], '{}'::jsonb, $4::jsonb, $5, NOW(), NOW())`
      : `(tenant_id, name, label, description, input_schema, code, created_at, updated_at)
         VALUES ($1, $2, $2, $3, $4::jsonb, 'return {}', NOW(), NOW())`;
  const params: unknown[] = [
    String(tenantId),
    key,
    description,
    JSON.stringify(inputSchema),
  ];
  // The slow-tool acknowledgement is operator text the CUSTOMER reads, seeded with the old name so
  // the exclusion is asserted rather than assumed.
  if (table === "tool_definitions") params.push("Já verifico (assign_label)…");
  const r = await suDb.query(
    `INSERT INTO "${table}" ${cols} RETURNING id`,
    params,
  );
  ids[key] = BigInt(r.rows[0].id);
}

async function toolRow(
  table: "tool_definitions" | "code_tool_definitions",
  toolId: bigint,
): Promise<{
  description: string | null;
  // Deliberately loose: the one column holds the compact field map, standard JSON Schema, and the
  // pathological field literally named `properties`, and a case below asserts what each shape keeps.
  // The per-field spec comes out through `fieldOf`.
  input_schema: Record<string, unknown>;
  ack_message?: string | null;
  updated_at: string;
}> {
  const extra = table === "tool_definitions" ? ", ack_message" : "";
  const r = await suDb.query(
    `SELECT description, input_schema, updated_at${extra} FROM "${table}" WHERE id = $1`,
    [String(toolId)],
  );
  return { ...r.rows[0], updated_at: String(r.rows[0].updated_at) };
}

// One field's spec out of an input_schema of any shape.
function fieldOf(
  schema: Record<string, unknown>,
  name: string,
): { description?: unknown; type?: unknown } {
  return (schema[name] ?? {}) as { description?: unknown; type?: unknown };
}

async function auditPathsFor(target: string): Promise<string[][]> {
  const r = await suDb.query(
    `SELECT "after" FROM "audit_logs"
      WHERE target = $1 AND action = 'tool.text_renamed_tool'
      ORDER BY id ASC`,
    [target],
  );
  return r.rows.map(
    (row) => (row.after as { paths?: string[] }).paths as string[],
  );
}

async function settingsOf(agentId: bigint): Promise<Record<string, unknown>> {
  const r = await suDb.query('SELECT settings FROM "agents" WHERE id = $1', [
    String(agentId),
  ]);
  return r.rows[0].settings as Record<string, unknown>;
}

async function updatedAtOf(agentId: bigint): Promise<string> {
  const r = await suDb.query('SELECT updated_at FROM "agents" WHERE id = $1', [
    String(agentId),
  ]);
  return String(r.rows[0].updated_at);
}

async function auditPaths(agentId: bigint): Promise<string[][]> {
  const r = await suDb.query(
    `SELECT "after" FROM "audit_logs"
      WHERE target = $1 AND action = 'agent.settings_text_renamed_tool'
      ORDER BY id ASC`,
    [`agent:${agentId}`],
  );
  return r.rows.map(
    (row) => (row.after as { paths?: string[] }).paths as string[],
  );
}

// Every string leaf of a settings bag, as a dotted path. Used to ask which paths a run CHANGED,
// which is the behavioural form of "the migration addressed the model-facing class": a question
// about the rows, not about the text of the `.sql`.
function leaves(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value === "string") {
    out[prefix] = value;
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      Object.assign(out, leaves(v, `${prefix}[${i}]`));
    });
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      Object.assign(out, leaves(v, prefix ? `${prefix}.${k}` : k));
    }
  }
  return out;
}

// The site a stored path belongs to, with the array index dropped: `classOf` classifies sites.
const siteOf = (path: string) => path.replace(/\[\d+\]/g, "[*]");

async function forced(table: string): Promise<boolean> {
  const r = await suDb.query(
    "SELECT relforcerowsecurity FROM pg_class WHERE relname = $1",
    [table],
  );
  return r.rows[0].relforcerowsecurity as boolean;
}

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

// The note the issue measured on a real installation: the key is the new one, the text is the old
// one. Every case below starts from that shape, because that is what an upgraded install holds.
// One value per stored path the walker knows, each naming the old tool. Written out rather than
// generated, so the file says which paths it is asking about.
const ALL_PATHS_STALE = {
  handoff: { instructions: "h assign_label" },
  availability: { awayMessage: "a assign_label" },
  contactAuth: { denyMessage: "c assign_label" },
  kanban: { instructions: "k assign_label" },
  toolGuidance: { set_labels: "g assign_label" },
  guardrails: {
    customPolicy: "p assign_label",
    input: { templateMessage: "i assign_label" },
    output: {
      templateMessage: "o assign_label",
      generationPrompt: "r assign_label",
    },
  },
  signature: { text: "s assign_label" },
  vision: { extractionPrompt: "v assign_label" },
  followUp: { steps: [{ instructions: "f assign_label" }] },
};

const NOTE_STALE =
  "Uma etiqueta por chamada: nunca chame assign_label em paralelo com outra assign_label.";
const NOTE_FIXED =
  "Uma etiqueta por chamada: nunca chame set_labels em paralelo com outra set_labels.";

describe.skipIf(!dbUp)(
  "migration: the rename follows the operator's prose, not only the keys",
  () => {
    beforeAll(async () => {
      const t = await suDb.query(
        "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
        ["STXT", `stxt-${process.pid}`],
      );
      tenantId = BigInt(t.rows[0].id);
      const t2 = await suDb.query(
        "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
        ["STXT2", `stxt2-${process.pid}`],
      );
      tenant2Id = BigInt(t2.rows[0].id);

      await agent("guidance", {
        toolGuidance: {
          set_labels: NOTE_STALE,
          set_custom_attribute: "Só o estágio do lead.",
        },
      });
      await agent("handoff", {
        handoff: {
          mode: "route",
          instructions: "Antes de transferir, chame assign_label com 'humano'.",
        },
      });
      await agent("kanban", {
        kanban: { instructions: "Mova o cartão só depois de assign_label." },
      });
      await agent("guardrails", {
        guardrails: {
          customPolicy: "Nunca prometa etiqueta sem assign_label.",
          output: {
            generationPrompt: "Reescreva sem citar assign_label ao cliente.",
            templateMessage: "Não posso responder isso (assign_label).",
          },
          input: { templateMessage: "Mensagem barrada (assign_label)." },
        },
      });
      await agent("followup", {
        followUp: {
          steps: [
            { delayValue: 1, instructions: "Passo 1: chame assign_label." },
            {
              delayValue: 2,
              instructions: "Passo 2: nada de assign_label aqui.",
            },
            { delayValue: 3, instructions: "Passo 3 sem menção." },
          ],
        },
      });
      // ELEVEN STEPS, so the last one is past `FOLLOW_UP_MAX_STEPS` where the reader cuts and where
      // the text-caps walker stops on purpose. The migration crosses that line on purpose too, and
      // the header says why: the cut is on position, so a removed step promotes this one into range.
      await agent("eleven_steps", {
        followUp: {
          steps: Array.from({ length: 11 }, (_v, i) => ({
            delayValue: i + 1,
            instructions:
              i === 0 || i === 10
                ? `Passo ${i + 1}: chame assign_label.`
                : `Passo ${i + 1} sem menção.`,
          })),
        },
      });
      // Customer-facing copy and the toolless vision prompt: the old name is in all of them and none
      // is rewritten. This is the exclusion the migration header states, asserted rather than
      // trusted.
      await agent("excluded", {
        availability: { awayMessage: "Fora do horário (assign_label)." },
        contactAuth: { denyMessage: "Sem acesso (assign_label)." },
        signature: { text: "Equipe assign_label" },
        vision: { extractionPrompt: "Extraia os dados e chame assign_label." },
      });
      // `_` is a word character to `\y`, so neither of these is a word boundary match.
      await agent("boundary", {
        handoff: {
          instructions: "xassign_labelx e assign_labelx e xassign_label",
        },
      });
      // A bag whose shapes the walk must step over instead of rewriting: a non-string note, a
      // non-object toolGuidance is covered by its own agent below.
      // A NON-STRING WHOSE TEXT CARRIES THE NAME is the shape that makes the type guards live, and
      // the mutation battery is what found it: with `42` and `null` alone, dropping
      // `jsonb_typeof(...) = 'string'` killed no test, because neither renders text the pattern
      // matches. An array or an object does, and without the guard `jsonb_set` would replace the
      // whole value with a rewritten STRING: the operator's stored shape destroyed by a rename.
      await agent("shapes", {
        toolGuidance: {
          set_labels: 42,
          private_note: null,
          kanban_move_card: ["chame assign_label"],
          handoff_to_human: { nota: "chame assign_label" },
          set_custom_attribute: NOTE_STALE,
        },
        handoff: { instructions: ["chame assign_label"] },
        followUp: {
          steps: [{ delayValue: 1, instructions: ["chame assign_label"] }],
        },
      });
      await agent("notobject", { toolGuidance: "assign_label" });
      await agent("nosteps", { followUp: { steps: "assign_label" } });
      // Two tenants, because a data migration that reads or writes under FORCE ROW LEVEL SECURITY
      // and forgot the lift reaches zero rows, and one tenant cannot tell that from a no-op.
      await agent(
        "other_tenant",
        { toolGuidance: { set_labels: NOTE_STALE } },
        { tenant: tenant2Id },
      );

      // THE WHOLE SURFACE THE MODEL RECEIVES, on one agent: the prompt as an upgraded install holds
      // it (already rewritten by the earlier migration) plus the three tool notes it left stale.
      await agent(
        "surface",
        {
          toolGuidance: { set_labels: NOTE_STALE },
          handoff: {
            mode: "route",
            instructions:
              "Antes de transferir, chame assign_label com 'humano'.",
          },
          kanban: { instructions: "Mova o cartão só depois de assign_label." },
        },
        { prompt: "Você etiqueta com set_labels quando o assunto fica claro." },
      );
      // Every stored path at once, so the question "which paths did this run change" can be asked of
      // the ROWS. This is the behavioural form of the claim a test over the `.sql` text would make,
      // and unlike that test it survives a reformat of the file.
      await agent("all_paths", ALL_PATHS_STALE);

      // A NOTE WITH A NEWLINE BEFORE THE NAME. On the serialized bag that newline comes out as `\`
      // followed by `n`, so a word-boundary PREFILTER over `settings::text` finds nothing and skips
      // the agent entirely (review round 1 of PR #687). The boundary belongs on the decoded value.
      await agent("newline", {
        toolGuidance: {
          set_labels: "Allowed tool:\nassign_label\tassign_label",
        },
      });
      // An agent whose only occurrence is glued to a word character: nothing to rewrite, and no
      // updated_at stamp for an edit that did not happen.
      await agent("untouched", {
        handoff: { instructions: "xassign_labelx e nada mais" },
      });

      // The operator's own tools, which are prose on two other tables.
      await toolDef(
        "http_tool",
        "tool_definitions",
        "Use no lugar de assign_label.",
        {
          etiqueta: {
            type: "string",
            description: "a etiqueta que assign_label aplicaria",
          },
          nota: { type: "string" },
          quebrado: { type: "string", description: 42 },
        },
      );
      await toolDef(
        "code_tool",
        "code_tool_definitions",
        "Faz o que assign_label fazia.",
        {
          campo: { type: "string", description: "idem assign_label" },
        },
      );
      await toolDef("tool_glued", "tool_definitions", "xassign_labelx", {});
      // A LEGACY ROW IN STANDARD JSON SCHEMA. The runtime still supports it (`normalizeToolShapes`
      // converts on read and copies each property's `description` across), so the model receives
      // these hints verbatim and a one-level walk would leave every one of them stale.
      await toolDef("tool_legacy", "tool_definitions", "legado", {
        type: "object",
        required: ["etiqueta"],
        properties: {
          etiqueta: {
            type: "string",
            description: "a que assign_label aplicaria",
          },
          sem_hint: { type: "string" },
        },
      });
      // The pathological compact field literally NAMED `properties`, which the runtime's own shape
      // test is written to protect: its sub-values are the strings of its FieldSpec, not fields.
      await toolDef(
        "tool_props_field",
        "code_tool_definitions",
        "campo chamado properties",
        {
          properties: {
            type: "object",
            description: "o que assign_label recebia",
          },
        },
      );

      serializedBefore = String(
        (
          await suDb.query(
            'SELECT settings::text AS t FROM "agents" WHERE id = $1',
            [String(id("newline"))],
          )
        ).rows[0].t,
      );
      staleBefore = readToolGuidance(
        await settingsOf(id("guidance")),
      ).set_labels;
    });

    afterAll(async () => {
      for (const t of [tenantId, tenant2Id]) {
        await suDb.query('DELETE FROM "audit_logs" WHERE tenant_id = $1', [
          String(t),
        ]);
        await suDb.query(
          'DELETE FROM "tool_definitions" WHERE tenant_id = $1',
          [String(t)],
        );
        await suDb.query(
          'DELETE FROM "code_tool_definitions" WHERE tenant_id = $1',
          [String(t)],
        );
        await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
          String(t),
        ]);
        await suDb.query("DELETE FROM tenants WHERE id = $1", [String(t)]);
      }
      await suDb.end();
    });

    test("BEFORE the migration, the reader hands the tool a rule about a tool that does not exist", () => {
      // The issue's measurement, reproduced: the key moved to `set_labels` and the text still names
      // `assign_label`, so this is what `prepare` appends to that tool's description.
      expect(staleBefore).toBe(NOTE_STALE);
      expect(staleBefore).toContain("assign_label");
    });

    test("the guidance note's own TEXT is rewritten, and the reader hands the tool a clean rule", async () => {
      await runMigration(sql);
      const s = await settingsOf(id("guidance"));
      expect((s.toolGuidance as Record<string, string>).set_labels).toBe(
        NOTE_FIXED,
      );
      // The other note is the operator's and says nothing about the renamed tool.
      expect(
        (s.toolGuidance as Record<string, string>).set_custom_attribute,
      ).toBe("Só o estágio do lead.");
      // THE EFFECT THE ISSUE NAMES, through the REAL reader rather than a re-read of the column:
      // `readToolGuidance` is what `prepare` appends to the tool's description.
      const note = readToolGuidance(s).set_labels;
      expect(note).toBe(NOTE_FIXED);
      expect(note).not.toContain("assign_label");
    });

    test("the two tool notes that live in their own block are rewritten too", async () => {
      expect(
        (await settingsOf(id("handoff"))).handoff as Record<string, string>,
      ).toEqual({
        mode: "route",
        instructions: "Antes de transferir, chame set_labels com 'humano'.",
      });
      expect(
        ((await settingsOf(id("kanban"))).kanban as Record<string, string>)
          .instructions,
      ).toBe("Mova o cartão só depois de set_labels.");
    });

    test("the two guardrail prompts the issue did not name are rewritten, and its customer copy is not", async () => {
      const g = (await settingsOf(id("guardrails"))).guardrails as {
        customPolicy: string;
        output: { generationPrompt: string; templateMessage: string };
        input: { templateMessage: string };
      };
      expect(g.customPolicy).toBe("Nunca prometa etiqueta sem set_labels.");
      expect(g.output.generationPrompt).toBe(
        "Reescreva sem citar set_labels ao cliente.",
      );
      // Same block, and deliberately untouched: a customer reads these two.
      expect(g.output.templateMessage).toContain("assign_label");
      expect(g.input.templateMessage).toContain("assign_label");
    });

    test("every follow-up step is rewritten IN PLACE, so the sequence still fires in order", async () => {
      const steps = (
        (await settingsOf(id("followup"))).followUp as {
          steps: { delayValue: number; instructions: string }[];
        }
      ).steps;
      expect(steps.map((s) => s.delayValue)).toEqual([1, 2, 3]);
      expect(steps.map((s) => s.instructions)).toEqual([
        "Passo 1: chame set_labels.",
        "Passo 2: nada de set_labels aqui.",
        "Passo 3 sem menção.",
      ]);
    });

    test("a step past the reader's cut is rewritten too, because the cut is on POSITION", async () => {
      const steps = (
        (await settingsOf(id("eleven_steps"))).followUp as {
          steps: { delayValue: number; instructions: string }[];
        }
      ).steps;
      expect(steps).toHaveLength(11);
      expect(steps.map((s) => s.delayValue)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
      ]);
      expect(steps[0]?.instructions).toBe("Passo 1: chame set_labels.");
      expect(steps[10]?.instructions).toBe("Passo 11: chame set_labels.");
      // Neither the reader nor the walker goes that far, so the audit line is the only place the
      // operator can see that an upgrade edited a step they cannot currently reach.
      expect(await auditPaths(id("eleven_steps"))).toEqual([
        ["followUp.steps[0].instructions", "followUp.steps[10].instructions"],
      ]);
    });

    test("text a PERSON reads is left alone, and so is the prompt of a model with no tools", async () => {
      const s = await settingsOf(id("excluded"));
      expect((s.availability as Record<string, string>).awayMessage).toContain(
        "assign_label",
      );
      expect((s.contactAuth as Record<string, string>).denyMessage).toContain(
        "assign_label",
      );
      expect((s.signature as Record<string, string>).text).toContain(
        "assign_label",
      );
      expect((s.vision as Record<string, string>).extractionPrompt).toContain(
        "assign_label",
      );
      // And nothing was written for it: the row carries the old name and no field this file owns.
      expect(await auditPaths(id("excluded"))).toEqual([]);
    });

    test("a word that merely CONTAINS the old name is left alone", async () => {
      expect(
        ((await settingsOf(id("boundary"))).handoff as Record<string, string>)
          .instructions,
        // Unchanged, all three: `\y` is required at BOTH ends, and `_` is a word character to it,
        // so a run of letters glued to either side of the name is not a match.
      ).toBe("xassign_labelx e assign_labelx e xassign_label");
    });

    test("a value that is not a string is stepped over, not rewritten", async () => {
      const s = await settingsOf(id("shapes"));
      const g = s.toolGuidance as Record<string, unknown>;
      expect(g.set_labels).toBe(42);
      expect(g.private_note).toBeNull();
      expect(g.set_custom_attribute).toBe(NOTE_FIXED);
      // The two that carry the name INSIDE a shape: they keep the shape, name and all. Rewriting
      // them would be a rename that edits the operator's data structure.
      expect(g.kanban_move_card).toEqual(["chame assign_label"]);
      expect(g.handoff_to_human).toEqual({ nota: "chame assign_label" });
      // Same question at the other two seams: a scalar path and a follow-up step.
      expect((s.handoff as Record<string, unknown>).instructions).toEqual([
        "chame assign_label",
      ]);
      expect(
        (s.followUp as { steps: { instructions: unknown }[] }).steps[0]
          ?.instructions,
      ).toEqual(["chame assign_label"]);
      expect(await auditPaths(id("shapes"))).toEqual([
        ["toolGuidance.set_custom_attribute"],
      ]);
    });

    test("a block whose SHAPE is wrong is left exactly as it was", async () => {
      expect((await settingsOf(id("notobject"))).toolGuidance).toBe(
        "assign_label",
      );
      expect(
        ((await settingsOf(id("nosteps"))).followUp as Record<string, unknown>)
          .steps,
      ).toBe("assign_label");
      expect(await auditPaths(id("notobject"))).toEqual([]);
      expect(await auditPaths(id("nosteps"))).toEqual([]);
    });

    test("the walk crosses tenants, which is what the RLS lift buys", async () => {
      expect(
        (
          (await settingsOf(id("other_tenant"))).toolGuidance as Record<
            string,
            string
          >
        ).set_labels,
      ).toBe(NOTE_FIXED);
      expect(await forced("agents")).toBe(true);
      expect(await forced("audit_logs")).toBe(true);
    });

    test("the audit line names the operator's own paths, one line per agent", async () => {
      expect(await auditPaths(id("guidance"))).toEqual([
        ["toolGuidance.set_labels"],
      ]);
      expect(await auditPaths(id("handoff"))).toEqual([
        ["handoff.instructions"],
      ]);
      expect(await auditPaths(id("kanban"))).toEqual([["kanban.instructions"]]);
      expect(await auditPaths(id("guardrails"))).toEqual([
        ["guardrails.customPolicy", "guardrails.output.generationPrompt"],
      ]);
      expect(await auditPaths(id("followup"))).toEqual([
        ["followUp.steps[0].instructions", "followUp.steps[1].instructions"],
      ]);
    });

    test("THE SURFACE HANDED TO THE MODEL no longer names a tool that does not exist", async () => {
      const st = await settingsOf(id("surface"));
      const r = await suDb.query(
        'SELECT system_prompt FROM "agents" WHERE id = $1',
        [String(id("surface"))],
      );
      // Built the way `prepare` builds it: the same three readers, folded into one map, then the
      // real native tools. Asserting the column would only re-read what the case above read.
      const toolInstructions = {
        ...readToolGuidance(st),
        handoff_to_human: readHandoffConfig(st).instructions ?? undefined,
        kanban_move_card: readKanbanConfig(st).instructions ?? undefined,
      };
      const tools = buildNativeTools(
        {
          client: {} as never,
          conversationId: 1,
          tenantId,
          toolInstructions,
        } as never,
        ["set_labels", "handoff_to_human", "kanban_move_card"],
      );
      const surface = [
        String(r.rows[0].system_prompt),
        ...tools.map((t) => `${t.name}: ${t.description}`),
      ].join("\n\n");
      // Half one: the old name is nowhere in what the model reads.
      expect(surface).not.toContain("assign_label");
      // Half two, and it is the half a deletion would pass without: each note is still THERE, in the
      // operator's own words, on the tool it was written for.
      const desc = (name: string) =>
        tools.find((t) => t.name === name)?.description ?? "";
      expect(desc("set_labels")).toContain(`Operator guidance: ${NOTE_FIXED}`);
      expect(desc("handoff_to_human")).toContain(
        "Operator guidance: Antes de transferir, chame set_labels com 'humano'.",
      );
      expect(desc("kanban_move_card")).toContain(
        "Operator guidance: Mova o cartão só depois de set_labels.",
      );
    });

    test("the paths this run CHANGED are exactly the model-facing ones", async () => {
      const before = leaves(ALL_PATHS_STALE);
      const after = leaves(await settingsOf(id("all_paths")));
      expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
      const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
      // Nothing outside the model-facing class moved, and every one inside it did. The classes come
      // from the registry the surface fence asserts is complete, so a site added later cannot slip
      // past both files.
      for (const path of changed) {
        expect(classOf(siteOf(path))).toBe("model_with_tools");
      }
      const shouldChange = Object.keys(before).filter(
        (k) => classOf(siteOf(k)) === "model_with_tools",
      );
      expect(changed.sort()).toEqual(shouldChange.sort());
      // The control: the seed really did carry the old name in every path, so "unchanged" is a
      // decision and not an empty fixture.
      expect(
        Object.values(before).every((v) => v.includes("assign_label")),
      ).toBeTrue();
      expect(shouldChange.length).toBe(MODEL_WITH_TOOLS.length);
    });

    test("a note whose only occurrence follows a newline is still rewritten", async () => {
      // The control is the SHAPE of the seed, captured before the migration ran: on the serialized
      // bag the character before the name is `n`, not a boundary, which is what made a `\y`
      // prefilter skip the whole row.
      expect(serializedBefore).toContain("\\nassign_label");
      // `\b`, not Postgres's `\y`: JavaScript has no `\y` and reads it as the letter `y`, so the
      // first version of this line asserted that the text does not contain `yassign_labely`, which
      // passes without measuring anything. This is the same predicate spelled in the language the
      // test is written in: the serialized bag has NO word-boundary match, the decoded value does.
      expect(serializedBefore).not.toMatch(/\bassign_label\b/);
      expect("Allowed tool:\nassign_label").toMatch(/\bassign_label\b/);
      expect(
        (
          (await settingsOf(id("newline"))).toolGuidance as Record<
            string,
            string
          >
        ).set_labels,
      ).toBe("Allowed tool:\nset_labels\tset_labels");
    });

    test("a row with nothing to rewrite keeps its updated_at", async () => {
      const s = await settingsOf(id("untouched"));
      expect((s.handoff as Record<string, string>).instructions).toBe(
        "xassign_labelx e nada mais",
      );
      expect(await auditPaths(id("untouched"))).toEqual([]);
      const r = await suDb.query(
        'SELECT updated_at = created_at AS untouched FROM "agents" WHERE id = $1',
        [String(id("untouched"))],
      );
      expect(r.rows[0].untouched).toBeTrue();
    });

    test("the operator's OWN tools are prose too, description and argument hints alike", async () => {
      const http = await toolRow("tool_definitions", id("http_tool"));
      expect(http.description).toBe("Use no lugar de set_labels.");
      expect(fieldOf(http.input_schema, "etiqueta").description).toBe(
        "a etiqueta que set_labels aplicaria",
      );
      // A field with no description, and one whose description is not a string: both survive.
      expect(http.input_schema.nota).toEqual({ type: "string" });
      expect(http.input_schema.quebrado).toEqual({
        type: "string",
        description: 42,
      });
      // The slow-tool ack is read by the CUSTOMER, so it keeps the old name like the other
      // person-facing copy.
      expect(http.ack_message).toContain("assign_label");

      const code = await toolRow("code_tool_definitions", id("code_tool"));
      expect(code.description).toBe("Faz o que set_labels fazia.");
      expect(fieldOf(code.input_schema, "campo").description).toBe(
        "idem set_labels",
      );

      expect(await auditPathsFor(`tool:${id("http_tool")}`)).toEqual([
        ["description", "input_schema.*.description"],
      ]);
      expect(await auditPathsFor(`code_tool:${id("code_tool")}`)).toEqual([
        ["description", "input_schema.*.description"],
      ]);
    });

    test("a legacy JSON Schema row has its argument hints rewritten too", async () => {
      const legacy = await toolRow("tool_definitions", id("tool_legacy"));
      const props = legacy.input_schema.properties as Record<string, unknown>;
      expect(fieldOf(props, "etiqueta").description).toBe(
        "a que set_labels aplicaria",
      );
      // The shape survives: the keyword keys are still keywords, and a property with no hint is
      // left exactly as it was.
      expect(legacy.input_schema.type).toBe("object");
      expect(legacy.input_schema.required).toEqual(["etiqueta"]);
      expect(props.sem_hint).toEqual({ type: "string" });
      expect(await auditPathsFor(`tool:${id("tool_legacy")}`)).toEqual([
        ["input_schema.*.description"],
      ]);
    });

    test("a compact field literally named `properties` keeps its own description", async () => {
      const row = await toolRow(
        "code_tool_definitions",
        id("tool_props_field"),
      );
      // ONE rewrite, of that field's own description, and no invented nesting: the nested walk only
      // descends into an object, and `type`/`description` here are strings.
      expect(row.input_schema.properties).toEqual({
        type: "object",
        description: "o que set_labels recebia",
      });
    });

    test("a tool whose occurrence is glued to a word character is not touched at all", async () => {
      const glued = await toolRow("tool_definitions", id("tool_glued"));
      expect(glued.description).toBe("xassign_labelx");
      expect(await auditPathsFor(`tool:${id("tool_glued")}`)).toEqual([]);
      const r = await suDb.query(
        'SELECT updated_at = created_at AS untouched FROM "tool_definitions" WHERE id = $1',
        [String(id("tool_glued"))],
      );
      expect(r.rows[0].untouched).toBeTrue();
    });

    test("re-running it rewrites nothing and writes no second line", async () => {
      const before = await updatedAtOf(id("guidance"));
      await runMigration(sql);
      expect(
        (
          (await settingsOf(id("guidance"))).toolGuidance as Record<
            string,
            string
          >
        ).set_labels,
      ).toBe(NOTE_FIXED);
      expect(await updatedAtOf(id("guidance"))).toBe(before);
      expect(await auditPaths(id("guidance"))).toEqual([
        ["toolGuidance.set_labels"],
      ]);
    });

    // WHAT THE `BEGIN` BUYS, asserted by making the file fail on purpose rather than by trusting the
    // keyword is there. `migrate deploy` runs the `.sql` outside a transaction, so without one a
    // failure between the lift and the restore leaves `agents` no longer binding its own owner to
    // the tenant policy, with the migration marked applied and nothing in any log.
    test("a failure after the RLS lift restores FORCE instead of leaving it off", async () => {
      expect(await forced("agents")).toBe(true);
      const broken = sql.replace(
        'ALTER TABLE "agents" FORCE ROW LEVEL SECURITY;',
        'SELECT 1 / 0;\nALTER TABLE "agents" FORCE ROW LEVEL SECURITY;',
      );
      expect(broken).not.toBe(sql);
      await expect(runMigration(broken)).rejects.toThrow();
      expect(await forced("agents")).toBe(true);
      expect(await forced("audit_logs")).toBe(true);
    });
  },
);
