import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { dbProbeFailed } from "@/tests/db-gate";

// The account's `occurrences` block becomes its first monitor, and every row of the monitor that
// monitor's. ON A PROBE DATABASE MIGRATED THROUGH EVERY FILE BEFORE THIS ONE, so the rows are seeded
// in the shape the previous release wrote them, uniques and policies included; and THE FILE RUNS
// TWICE, STATEMENT BY STATEMENT as Prisma runs it (a multi-statement string gets an implicit
// transaction, `.claude/rules/prisma.md`), the second time changing nothing.

const MIGRATIONS = "prisma/migrations";
const THIS = "20261023120000_occurrence_monitors";
const MIGRATION = `${MIGRATIONS}/${THIS}/migration.sql`;

const suUrl = process.env.MIGRATION_DATABASE_URL;
const PROBE_DB = `fazerai_occ_monitors_${process.pid}`;
let dbUp = false;
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

function probeUrl(): string {
  const u = new URL(suUrl as string);
  u.pathname = `/${PROBE_DB}`;
  return u.toString();
}

// Comment lines out, then cut on semicolons outside a literal and outside a `$$` body.
function statementsOf(text: string): string[] {
  const bare = text.replace(/^\s*--.*$/gm, "");
  const out: string[] = [];
  let current = "";
  let inLiteral = false;
  let inDollar = false;
  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i] as string;
    if (!inLiteral && ch === "$" && bare[i + 1] === "$") {
      inDollar = !inDollar;
      current += "$$";
      i++;
      continue;
    }
    if (!inDollar && ch === "'") inLiteral = !inLiteral;
    if (ch === ";" && !inLiteral && !inDollar) {
      if (current.trim()) out.push(`${current.trim()};`);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) {
    throw new Error("statementsOf: the file does not end on a terminator");
  }
  return out;
}

let db: Client;

async function migrate(): Promise<void> {
  for (const statement of statementsOf(await Bun.file(MIGRATION).text()))
    await db.query(statement);
}

// The block as the previous release saved it (settings.ts at 20261022120000): reason and reference
// fields, one model, the cadences, and an attribute copied to Chatwoot.
const BLOCK = {
  enabled: true,
  inboxIds: ["__INBOX__"],
  fields: [
    {
      key: "motivo",
      name: "Motivo",
      description: "Por que o cliente escreveu",
      attribute: false,
    },
    {
      key: "evento",
      name: "Evento",
      description: "O evento citado",
      attribute: true,
    },
  ],
  reasonField: "motivo",
  referenceField: "evento",
  cadenceMinutes: 15,
  consolidationMinutes: 360,
  newMinConversations: 3,
  windowMinutes: 120,
  previousDays: 7,
  aboveUsualRatio: 3,
  concentrationShare: 0.5,
  model: {
    provider: "openai",
    model: "gpt-test",
    credentialRef: "vault:1",
    baseURL: null,
  },
  businessContext: "Venda de ingressos",
  recoverMedia: false,
};

const ids: Record<string, string> = {};
const id = (k: string): string => ids[k] as string;

async function one(key: string, q: string, params: unknown[]): Promise<void> {
  const r = await db.query<{ id: string }>(`${q} RETURNING id`, params);
  ids[key] = String(r.rows[0]?.id);
}

async function account(key: string, settings: Record<string, unknown>) {
  await one(
    key,
    `INSERT INTO tenants (name, slug, settings, created_at, updated_at)
     VALUES ($1, $1, $2::jsonb, NOW(), NOW())`,
    [`occ-${key}`, JSON.stringify(settings)],
  );
  await one(
    `${key}.dep`,
    `INSERT INTO chatwoot_deployments (tenant_id, base_url, admin_token, created_at, updated_at)
     VALUES ($1, 'https://cw.test', 'x', NOW(), NOW())`,
    [id(key)],
  );
  await one(
    `${key}.inst`,
    `INSERT INTO chatwoot_instances (tenant_id, deployment_id, account_id, server_key, created_at, updated_at)
     VALUES ($1, $2, 1, $3, NOW(), NOW())`,
    [id(key), id(`${key}.dep`), `sk-${key}`],
  );
  await one(
    `${key}.inbox`,
    `INSERT INTO inboxes (tenant_id, chatwoot_instance_id, chatwoot_inbox_id, name, created_at, updated_at)
     VALUES ($1, $2, 1, 'SAC', NOW(), NOW())`,
    [id(key), id(`${key}.inst`)],
  );
}

async function conversation(key: string, tenant: string, n: number) {
  await one(
    key,
    `INSERT INTO conversations (tenant_id, chatwoot_instance_id, inbox_id, chatwoot_conversation_id, status, thread_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'open', $5, NOW(), NOW())`,
    [
      id(tenant),
      id(`${tenant}.inst`),
      id(`${tenant}.inbox`),
      n,
      `${id(tenant)}:${id(`${tenant}.inst`)}:${n}`,
    ],
  );
}

// Everything the previous release wrote for a monitor that ran: readings with their canonical, read
// marks, two rounds and their ledger lines, a theme with a member and an event, a canonical with an
// alias, the round job, and a saved panel of the source.
async function monitorRows(tenant: string) {
  await conversation(`${tenant}.c1`, tenant, 1);
  await conversation(`${tenant}.c2`, tenant, 2);
  await one(
    `${tenant}.canon`,
    `INSERT INTO occurrence_canonicals (tenant_id, field, name) VALUES ($1, 'evento', 'Show X')`,
    [id(tenant)],
  );
  await one(
    `${tenant}.alias`,
    `INSERT INTO occurrence_aliases (tenant_id, field, raw, canonical_id) VALUES ($1, 'evento', 'show x', $2)`,
    [id(tenant), id(`${tenant}.canon`)],
  );
  for (const c of ["c1", "c2"]) {
    await one(
      `${tenant}.${c}.motivo`,
      `INSERT INTO conversation_readings (tenant_id, conversation_id, field, value) VALUES ($1, $2, 'motivo', 'Ingresso não chegou')`,
      [id(tenant), id(`${tenant}.${c}`)],
    );
    await one(
      `${tenant}.${c}.evento`,
      `INSERT INTO conversation_readings (tenant_id, conversation_id, field, value, canonical_id, canonical_written, written_name)
       VALUES ($1, $2, 'evento', 'show x', $3, true, 'Show X')`,
      [id(tenant), id(`${tenant}.${c}`), id(`${tenant}.canon`)],
    );
    await one(
      `${tenant}.${c}.read`,
      `INSERT INTO occurrence_conversation_reads (tenant_id, conversation_id, read_at, read_inbound_at, read_inbound_message_id)
       VALUES ($1, $2, NOW(), NOW(), 7)`,
      [id(tenant), id(`${tenant}.${c}`)],
    );
  }
  for (const r of ["run1", "run2"]) {
    await one(
      `${tenant}.${r}`,
      `INSERT INTO occurrence_runs (tenant_id, finished_at, duration_ms, status, readings, model_calls, cost_usd, detail, consolidated)
       VALUES ($1, NOW(), 1200, 'ok', 2, 3, 0.012, '{"reading":{"read":2}}'::jsonb, $2)`,
      [id(tenant), r === "run2"],
    );
    await db.query(
      `INSERT INTO llm_usage (tenant_id, thread_id, model, node, source, prompt_tokens, completion_tokens, cost_usd)
       VALUES ($1, $2, 'gpt-test', 'occurrence_reading', 'inbox', 100, 20, 0.004)`,
      [id(tenant), `occurrences:${id(tenant)}:${id(`${tenant}.${r}`)}`],
    );
  }
  await one(
    `${tenant}.theme`,
    `INSERT INTO occurrence_themes (tenant_id, title, first_seen_at, last_seen_at, flags, flag_subject_id, flagged_at)
     VALUES ($1, 'Ingresso não chegou', NOW(), NOW(), ARRAY['new'], $2, NOW())`,
    [id(tenant), id(`${tenant}.canon`)],
  );
  for (const c of ["c1", "c2"])
    await one(
      `${tenant}.${c}.member`,
      `INSERT INTO occurrence_theme_members (tenant_id, theme_id, conversation_id, sentence, read_at)
       VALUES ($1, $2, $3, 'Ingresso não chegou', NOW())`,
      [id(tenant), id(`${tenant}.theme`), id(`${tenant}.${c}`)],
    );
  await one(
    `${tenant}.event`,
    `INSERT INTO occurrence_theme_events (tenant_id, kind, theme_id, run_id) VALUES ($1, 'created', $2, $3)`,
    [id(tenant), id(`${tenant}.theme`), id(`${tenant}.run1`)],
  );
  await one(
    `${tenant}.job`,
    `INSERT INTO scheduler_jobs (tenant_id, kind, dedupe_key, payload, run_at, created_at, updated_at)
     VALUES ($1, 'OCCURRENCE_ROUND', 'occurrences', '{}'::jsonb, NOW(), NOW(), NOW())`,
    [id(tenant)],
  );
  await one(
    `${tenant}.dash`,
    `INSERT INTO dashboards (tenant_id, name, slug, created_at, updated_at) VALUES ($1, 'Painel', 'painel', NOW(), NOW())`,
    [id(tenant)],
  );
  await one(
    `${tenant}.panel`,
    `INSERT INTO dashboard_panels (tenant_id, dashboard_id, position, title, visualization, query, created_at, updated_at)
     VALUES ($1, $2, 0, 'Agora', 'table', '{"source":"occurrences","view":"themes","flaggedOnly":true}'::jsonb, NOW(), NOW())`,
    [id(tenant), id(`${tenant}.dash`)],
  );
  await one(
    `${tenant}.other`,
    `INSERT INTO dashboard_panels (tenant_id, dashboard_id, position, title, visualization, query, created_at, updated_at)
     VALUES ($1, $2, 1, 'Volume', 'number', '{"source":"conversations","groupBy":{"kind":"none"}}'::jsonb, NOW(), NOW())`,
    [id(tenant), id(`${tenant}.dash`)],
  );
}

const MONITOR_TABLES = [
  "conversation_readings",
  "occurrence_conversation_reads",
  "occurrence_runs",
  "occurrence_themes",
  "occurrence_theme_members",
  "occurrence_theme_events",
  "occurrence_canonicals",
  "occurrence_aliases",
];

async function monitorsOf(
  tenant: string,
): Promise<{ id: string; name: string; config: unknown; position: number }[]> {
  return (
    await db.query(
      `SELECT id::text, name, config, position FROM occurrence_monitors WHERE tenant_id = $1 ORDER BY id`,
      [id(tenant)],
    )
  ).rows;
}

async function settingsOf(tenant: string): Promise<Record<string, unknown>> {
  return (
    await db.query("SELECT settings FROM tenants WHERE id = $1", [id(tenant)])
  ).rows[0].settings;
}

// Every row this file touches, as text, to compare a second run against the first.
async function snapshot(): Promise<string> {
  const parts: unknown[] = [];
  for (const t of [
    ...MONITOR_TABLES,
    "occurrence_monitors",
    "tenants",
    "scheduler_jobs",
    "dashboard_panels",
  ]) {
    parts.push(
      t,
      (await db.query(`SELECT to_jsonb(x) AS row FROM ${t} x ORDER BY id`))
        .rows,
    );
  }
  const indexes = await db.query(
    `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
  );
  parts.push(indexes.rows);
  return JSON.stringify(parts);
}

let fleetRole = "";

describe.skipIf(!dbUp)("the occurrence monitors migration", () => {
  beforeAll(async () => {
    const s = su as Client;
    await s.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
    await s.query(`CREATE DATABASE ${PROBE_DB}`);
    db = new Client({ connectionString: probeUrl() });
    await db.connect();
    // The schema of the release before: every migration up to this one, as `migrate deploy` ran them.
    const dirs = [...new Bun.Glob("*/migration.sql").scanSync(MIGRATIONS)]
      .map((p) => p.split("/")[0] as string)
      .filter((d) => d < THIS)
      .sort();
    for (const d of dirs) {
      const text = await Bun.file(`${MIGRATIONS}/${d}/migration.sql`).text();
      // A `CONCURRENTLY` build refuses the implicit transaction of a multi-statement string.
      if (/\bCONCURRENTLY\b/.test(text))
        for (const statement of statementsOf(text)) await db.query(statement);
      else await db.query(text);
    }
    fleetRole = (await db.query("SELECT public.fazerai_fleet_role() AS r"))
      .rows[0].r;

    // A: a monitor that ran. B: no monitor at all. C: rows of the monitor whose block was lost.
    await account("A", { company: { name: "Guichê" } });
    const block = { ...BLOCK, inboxIds: [id("A.inbox")] };
    await db.query(
      `UPDATE tenants SET settings = settings || jsonb_build_object('occurrences', $2::jsonb) WHERE id = $1`,
      [id("A"), JSON.stringify(block)],
    );
    await monitorRows("A");
    await account("B", { company: { name: "Outra" } });
    await conversation("B.c1", "B", 1);
    await account("C", {});
    await conversation("C.c1", "C", 1);
    await one(
      "C.run",
      `INSERT INTO occurrence_runs (tenant_id, status) VALUES ($1, 'ok')`,
      [id("C")],
    );

    await migrate();
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    if (su) {
      await su.query(`DROP DATABASE IF EXISTS ${PROBE_DB} WITH (FORCE)`);
      // The fleet role an earlier file created, whose name carries the probe database: dropping the
      // database does not drop it.
      if (fleetRole) await su.query(`DROP ROLE IF EXISTS "${fleetRole}"`);
      await su.end();
    }
  });

  test("the account's block becomes its first monitor, verbatim, and leaves the settings", async () => {
    const [m, ...more] = await monitorsOf("A");
    expect(more).toEqual([]);
    expect(m?.name).toBe("Ocorrências");
    expect(m?.position).toBe(0);
    expect(m?.config).toEqual({ ...BLOCK, inboxIds: [id("A.inbox")] });
    expect(await settingsOf("A")).toEqual({ company: { name: "Guichê" } });
  });

  test("every row of the monitor is that monitor's, and nothing else moved", async () => {
    const [m] = await monitorsOf("A");
    for (const t of MONITOR_TABLES) {
      const rows = (
        await db.query(
          `SELECT monitor_id::text AS m, count(*)::int AS n FROM ${t} WHERE tenant_id = $1 GROUP BY 1`,
          [id("A")],
        )
      ).rows;
      expect({ t, rows }).toEqual({ t, rows: [{ m: m?.id, n: rows[0]?.n }] });
      expect(rows[0]?.n).toBeGreaterThan(0);
    }
    const reading = (
      await db.query(
        "SELECT value, canonical_id::text, canonical_written, written_name FROM conversation_readings WHERE id = $1",
        [id("A.c1.evento")],
      )
    ).rows[0];
    expect(reading).toEqual({
      value: "show x",
      canonical_id: id("A.canon"),
      canonical_written: true,
      written_name: "Show X",
    });
    const theme = (
      await db.query(
        "SELECT title, flags, flag_subject_id::text AS ref FROM occurrence_themes WHERE id = $1",
        [id("A.theme")],
      )
    ).rows[0];
    expect(theme).toEqual({
      title: "Ingresso não chegou",
      flags: ["new"],
      ref: id("A.canon"),
    });
  });

  test("each ledger line of a round is the monitor's by its thread", async () => {
    const [m] = await monitorsOf("A");
    const r = await db.query(
      `SELECT count(*)::int AS n, sum(cost_usd)::text AS cost FROM llm_usage u
        WHERE u.tenant_id = $1 AND u.thread_id IN (
          SELECT 'occurrences:' || r.tenant_id || ':' || r.id FROM occurrence_runs r WHERE r.monitor_id = $2)`,
      [id("A"), m?.id],
    );
    expect(r.rows[0]).toEqual({ n: 2, cost: "0.0080000000" });
  });

  test("the round job and the saved panel name the monitor; another source's panel is left alone", async () => {
    const [m] = await monitorsOf("A");
    const job = (
      await db.query(
        "SELECT dedupe_key, payload, status::text FROM scheduler_jobs WHERE id = $1",
        [id("A.job")],
      )
    ).rows[0];
    expect(job).toEqual({
      dedupe_key: `occurrences:${m?.id}`,
      payload: { monitorId: m?.id },
      status: "PENDING",
    });
    const panels = (
      await db.query(
        "SELECT id::text, query FROM dashboard_panels WHERE tenant_id = $1 ORDER BY id",
        [id("A")],
      )
    ).rows;
    expect(panels).toEqual([
      {
        id: id("A.panel"),
        query: {
          source: "occurrences",
          view: "themes",
          flaggedOnly: true,
          monitorId: m?.id,
        },
      },
      {
        id: id("A.other"),
        query: { source: "conversations", groupBy: { kind: "none" } },
      },
    ]);
  });

  test("an account with no monitor gets none and keeps its settings", async () => {
    expect(await monitorsOf("B")).toEqual([]);
    expect(await settingsOf("B")).toEqual({ company: { name: "Outra" } });
  });

  test("an account with rows of the monitor but no block keeps them, in a monitor that is off", async () => {
    const [m, ...more] = await monitorsOf("C");
    expect(more).toEqual([]);
    expect(m?.config).toEqual({});
    const run = (
      await db.query(
        "SELECT monitor_id::text AS m FROM occurrence_runs WHERE id = $1",
        [id("C.run")],
      )
    ).rows[0];
    expect(run?.m).toBe(m?.id);
  });

  test("the uniques are per monitor, every column is required, and FORCE is back on every table", async () => {
    const names = (
      await db.query(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
      )
    ).rows.map((r) => r.indexname as string);
    for (const gone of [
      "conversation_readings_conversation_id_field_key",
      "occurrence_conversation_reads_conversation_id_key",
      "occurrence_theme_members_conversation_id_key",
      "occurrence_canonicals_tenant_id_field_name_key",
      "occurrence_aliases_tenant_id_field_raw_key",
    ])
      expect(names).not.toContain(gone);
    for (const kept of [
      "conversation_readings_monitor_id_conversation_id_field_key",
      "occurrence_conversation_reads_monitor_id_conversation_id_key",
      "occurrence_theme_members_monitor_id_conversation_id_key",
      "occurrence_canonicals_monitor_id_field_name_key",
      "occurrence_aliases_monitor_id_field_raw_key",
      "occurrence_monitors_tenant_id_name_key",
    ])
      expect(names).toContain(kept);
    const nullable = (
      await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE column_name = 'monitor_id' AND is_nullable = 'YES' AND table_schema = 'public'`,
      )
    ).rows;
    expect(nullable).toEqual([]);
    const unforced = (
      await db.query(
        `SELECT relname FROM pg_class WHERE relname = ANY($1) AND NOT relforcerowsecurity`,
        [
          [
            ...MONITOR_TABLES,
            "occurrence_monitors",
            "tenants",
            "scheduler_jobs",
            "dashboard_panels",
          ],
        ],
      )
    ).rows;
    expect(unforced).toEqual([]);
    const policies = (
      await db.query(
        "SELECT policyname FROM pg_policies WHERE tablename = 'occurrence_monitors' ORDER BY 1",
      )
    ).rows.map((r) => r.policyname);
    expect(policies).toEqual(["fleet_super_admin", "tenant_isolation"]);
  });

  test("a second run changes nothing", async () => {
    const before = await snapshot();
    await migrate();
    expect(await snapshot()).toBe(before);
  });

  test("a failure half-way leaves the database as it was", async () => {
    const before = await snapshot();
    // The file's last write, failing: the monitors it already created must go with it.
    await db.query(
      `CREATE FUNCTION occ_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$`,
    );
    await db.query(
      `CREATE TRIGGER occ_fail BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION occ_fail()`,
    );
    await db.query(
      `UPDATE occurrence_monitors SET config = '{"x":1}'::jsonb WHERE tenant_id = $1`,
      [id("C")],
    );
    await db.query(
      `INSERT INTO tenants (name, slug, settings, created_at, updated_at)
       VALUES ('occ-D', 'occ-D', $1::jsonb, NOW(), NOW())`,
      [JSON.stringify({ occurrences: { enabled: false } })],
    );
    const withD = await snapshot();
    await expect(migrate()).rejects.toThrow("boom");
    await db.query("ROLLBACK").catch(() => {});
    expect(await snapshot()).toBe(withD);
    expect(withD).not.toBe(before);
    await db.query("DROP TRIGGER occ_fail ON tenants");
  });
});
