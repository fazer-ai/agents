import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { readOccurrencesConfig } from "@/modules/occurrences/settings";
import { dbProbeFailed } from "@/tests/db-gate";

// Runs the ACTUAL migration file, twice: a copy would drift. The occurrence block's `subjectField`,
// `problemField` and per-step `models` become `referenceField`, `reasonField` and the one `model` (the
// reading's), and a stored panel's `subjects` view becomes `references`. A block already renamed, or
// one with no occurrence monitor at all, is left as it was.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20261022120000_occurrence_reason_reference_one_model/migration.sql";

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as Client;

const READING = {
  provider: "openai" as const,
  model: "gpt-test",
  credentialRef: "vault:1",
  baseURL: null,
};
const ASSIGNMENT = { ...READING, model: "gpt-other" };
const FIELDS = [
  { key: "item", name: "Item", description: "x", attribute: true },
  { key: "motivo", name: "Motivo", description: "y", attribute: false },
];

const ids: Record<string, bigint> = {};
const id = (k: string): bigint => ids[k] as bigint;

async function tenant(key: string, settings: unknown): Promise<void> {
  const r = await suDb.query(
    `INSERT INTO "tenants" (name, slug, settings, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW(), NOW()) RETURNING id`,
    [key, `occ-mig-${key}-${process.pid}`, JSON.stringify(settings)],
  );
  ids[key] = BigInt(r.rows[0].id);
}

async function settingsOf(key: string): Promise<Record<string, unknown>> {
  const r = await suDb.query('SELECT settings FROM "tenants" WHERE id = $1', [
    String(id(key)),
  ]);
  return r.rows[0].settings as Record<string, unknown>;
}

async function panelViews(): Promise<Record<string, string>> {
  const r = await suDb.query(
    `SELECT title, query FROM "dashboard_panels" WHERE tenant_id = $1`,
    [String(id("old"))],
  );
  return Object.fromEntries(
    r.rows.map((row) => [row.title, (row.query as { view?: string }).view]),
  );
}

async function forced(table: string): Promise<boolean> {
  const r = await suDb.query(
    "SELECT relforcerowsecurity FROM pg_class WHERE relname = $1",
    [table],
  );
  return r.rows[0].relforcerowsecurity as boolean;
}

const OLD_BLOCK = {
  enabled: true,
  inboxIds: ["1"],
  fields: FIELDS,
  subjectField: "item",
  problemField: "motivo",
  models: {
    reading: READING,
    canonical: null,
    assignment: ASSIGNMENT,
    consolidation: null,
  },
  cadenceMinutes: 20,
};

beforeAll(async () => {
  if (!dbUp) return;
  await tenant("old", { occurrences: OLD_BLOCK, other: { kept: true } });
  // A draft that never named a reference nor a model.
  await tenant("draft", {
    occurrences: { enabled: false, fields: [], subjectField: null },
  });
  // Already under the new names: nothing to do.
  await tenant("renamed", {
    occurrences: {
      enabled: false,
      fields: FIELDS,
      reasonField: "motivo",
      referenceField: null,
      model: READING,
    },
  });
  // Both names, the new one a JSON null: the old value is kept rather than lost.
  await tenant("both", {
    occurrences: {
      enabled: false,
      fields: FIELDS,
      reasonField: null,
      problemField: "motivo",
      model: null,
      models: { reading: READING },
    },
  });
  await tenant("none", { kanban: { enabled: true } });
  const d = await suDb.query(
    `INSERT INTO "dashboards" (tenant_id, name, slug, created_at, updated_at)
     VALUES ($1, 'd', $2, NOW(), NOW()) RETURNING id`,
    [String(id("old")), `occ-mig-${process.pid}`],
  );
  const panel = (title: string, query: unknown, position: number) =>
    suDb.query(
      `INSERT INTO "dashboard_panels" (tenant_id, dashboard_id, position, title, visualization, query, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'table', $5::jsonb, NOW(), NOW())`,
      [String(id("old")), d.rows[0].id, position, title, JSON.stringify(query)],
    );
  await panel("subjects", { source: "occurrences", view: "subjects" }, 0);
  await panel("themes", { source: "occurrences", view: "themes" }, 1);
  // Another source's own `view` is not this one's.
  await panel("elsewhere", { source: "conversations", view: "subjects" }, 2);
});

afterAll(async () => {
  if (!dbUp) return;
  const all = Object.values(ids).map(String);
  if (all.length > 0)
    await suDb.query(`DELETE FROM "tenants" WHERE id = ANY($1::bigint[])`, [
      all,
    ]);
  await suDb.end();
});

describe.skipIf(!dbUp)("the reason and reference migration", () => {
  test("renames the roles, keeps the reading's model as the one model, and leaves the rest of the block", async () => {
    await suDb.query(sql);
    const s = await settingsOf("old");
    const occ = s.occurrences as Record<string, unknown>;
    expect(occ.referenceField).toBe("item");
    expect(occ.reasonField).toBe("motivo");
    expect(occ.model).toEqual(READING);
    for (const old of ["subjectField", "problemField", "models"])
      expect([old, old in occ]).toEqual([old, false]);
    expect(occ.fields).toEqual(FIELDS);
    expect(occ.cadenceMinutes).toBe(20);
    expect(occ.enabled).toBe(true);
    expect(s.other).toEqual({ kept: true });
    // The stored block reads as a monitor that is on, as it was before the rename.
    const read = readOccurrencesConfig(s);
    expect(read.enabled).toBe(true);
    expect(read.reasonField).toBe("motivo");
    expect(read.model).toEqual(READING);
  });

  test("a draft gets null roles, a renamed block is untouched, and a JSON null under the new name does not hide the old value", async () => {
    expect((await settingsOf("draft")).occurrences).toEqual({
      enabled: false,
      fields: [],
      referenceField: null,
      reasonField: null,
      model: null,
    });
    expect((await settingsOf("renamed")).occurrences).toEqual({
      enabled: false,
      fields: FIELDS,
      reasonField: "motivo",
      referenceField: null,
      model: READING,
    });
    expect((await settingsOf("both")).occurrences).toEqual({
      enabled: false,
      fields: FIELDS,
      reasonField: "motivo",
      referenceField: null,
      model: READING,
    });
    expect(await settingsOf("none")).toEqual({ kanban: { enabled: true } });
  });

  test("renames the occurrences panels' view and no other source's", async () => {
    expect(await panelViews()).toEqual({
      subjects: "references",
      themes: "themes",
      elsewhere: "subjects",
    });
  });

  test("applied twice, the second run changes nothing, and row security is forced again", async () => {
    const before = await Promise.all(
      ["old", "draft", "renamed", "both", "none"].map(settingsOf),
    );
    const panels = await panelViews();
    await suDb.query(sql);
    expect(
      await Promise.all(
        ["old", "draft", "renamed", "both", "none"].map(settingsOf),
      ),
    ).toEqual(before);
    expect(await panelViews()).toEqual(panels);
    expect(await forced("tenants")).toBe(true);
    expect(await forced("dashboard_panels")).toBe(true);
  });
});
