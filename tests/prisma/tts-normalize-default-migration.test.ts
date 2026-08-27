import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { ENTER_FLEET_ROLE_SQL } from "@/lib/tenancy/fleet-role";

// Runs the ACTUAL migration file against the test database, over the settings shapes an install can
// really hold. Two failure modes are being pinned, and neither is hypothetical:
//
//   * `#-` RAISES when the path does not land in an object. `PATCH /v1/agents/:id` accepts
//     `settings: z.record(z.string(), z.unknown())` and stores it verbatim, so `{"tts": [1,2]}` is
//     reachable. The container runs `migrate deploy` BEFORE `serve`, so one such row anywhere in the
//     fleet would crash-loop that install's deploy, on a data migration that changes a default.
//   * FORCE ROW LEVEL SECURITY on "agents" binds even the table OWNER. A managed-Postgres admin role
//     (RDS/Neon/Supabase) is typically owner WITHOUT rolsuper, and there the UPDATE would match zero
//     rows and report success. The negative twin below runs the same statement as the APP role with
//     and without the `SET`, so the guard cannot be dropped without a red test.
//
// The migration file is executed from DISK on purpose: a copy pasted in here would drift, and
// Prisma's $executeRawUnsafe rejects multiple statements anyway, which would silently swallow the
// `SET`.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260817210000_tts_normalize_default_on/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
if (suUrl && appUrl) {
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

// Every shape an agent's settings bag can be in when this migration runs. The names are the point:
// each one is a row that has to survive.
const SHAPES: Array<[name: string, settings: unknown]> = [
  ["explicit-false", { tts: { mode: "mirror", normalize: false } }],
  ["explicit-true", { tts: { mode: "mirror", normalize: true } }],
  // The flag is inert at mode never, so it is deliberately NOT spared: leaving it would make this
  // agent permanently ineligible for the new default the moment audio is switched on.
  ["never-with-false", { tts: { mode: "never", normalize: false } }],
  ["tts-without-normalize", { tts: { mode: "mirror" } }],
  ["no-tts-block", { split: { enabled: false } }],
  ["empty-settings", {}],
  ["tts-is-an-array", { tts: [1, 2] }],
  ["tts-is-a-string", { tts: "mirror" }],
  // The two that actually make `#-` throw, and the reason the jsonb_typeof guard is not decoration:
  // the `?` operator (jsonb_exists) reads an ARRAY as "does it contain this element" and a scalar
  // STRING as "is it equal to this", so both of these PASS the exists filter and then reach an
  // operator that only accepts an object. Without the type guard, one such row anywhere in the fleet
  // aborts the migration, and the container's `migrate deploy` runs before `serve`.
  ["tts-array-containing-the-key", { tts: ["normalize"] }],
  ["tts-string-equal-to-the-key", { tts: "normalize" }],
];

async function settingsOf(name: string): Promise<Record<string, unknown>> {
  const r = await suDb.query('SELECT "settings" FROM "agents" WHERE id = $1', [
    String(ids[name]),
  ]);
  return r.rows[0]?.settings ?? {};
}

function ttsBlock(s: Record<string, unknown>): Record<string, unknown> | null {
  const t = s.tts;
  return t && typeof t === "object" && !Array.isArray(t)
    ? (t as Record<string, unknown>)
    : null;
}

describe.skipIf(!dbUp)("migration: tts normalize default on", () => {
  beforeAll(async () => {
    const t = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["TTSMIG", `ttsmig-${process.pid}`],
    );
    tenantId = BigInt(t.rows[0].id);
    for (const [name, settings] of SHAPES) {
      const r = await suDb.query(
        `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
         VALUES ($1, $2, 'p', '{}'::jsonb, $3::jsonb, NOW(), NOW()) RETURNING id`,
        [String(tenantId), `agent-${name}`, JSON.stringify(settings)],
      );
      ids[name] = BigInt(r.rows[0].id);
    }
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.query('DELETE FROM "agents" WHERE tenant_id = $1', [
        String(tenantId),
      ]);
      await suDb.query("DELETE FROM tenants WHERE id = $1", [String(tenantId)]);
    }
    await suDb.end();
  });

  test("runs over every settings shape without raising, including a non-object tts", async () => {
    // No try/catch: a throw here IS the failure being guarded against.
    await suDb.query(sql);
  });

  test("drops the stored flag so the new default reaches the agent", async () => {
    for (const name of [
      "explicit-false",
      "explicit-true",
      "never-with-false",
    ]) {
      const block = ttsBlock(await settingsOf(name));
      expect(block).not.toBeNull();
      expect("normalize" in (block ?? {})).toBe(false);
      // The rest of the block is untouched.
      expect(block?.mode).toBeDefined();
    }
  });

  test("leaves every other shape byte-identical", async () => {
    expect(await settingsOf("tts-without-normalize")).toEqual({
      tts: { mode: "mirror" },
    });
    expect(await settingsOf("no-tts-block")).toEqual({
      split: { enabled: false },
    });
    expect(await settingsOf("empty-settings")).toEqual({});
    expect(await settingsOf("tts-is-an-array")).toEqual({ tts: [1, 2] });
    expect(await settingsOf("tts-is-a-string")).toEqual({ tts: "mirror" });
    expect(await settingsOf("tts-array-containing-the-key")).toEqual({
      tts: ["normalize"],
    });
    expect(await settingsOf("tts-string-equal-to-the-key")).toEqual({
      tts: "normalize",
    });
  });

  // Idempotent means no row is REWRITTEN, not merely that the end state matches: without the
  // jsonb_exists filter every agent with a tts block would be rewritten on every deploy, churning
  // rows (and MVCC dead tuples) across the whole table for no change. xmin is the transaction that
  // last wrote each row, so comparing it is the direct measurement.
  test("a re-run rewrites no row at all", async () => {
    const versions = () =>
      suDb
        .query(
          'SELECT id::text AS id, xmin::text AS v FROM "agents" WHERE tenant_id = $1 ORDER BY id',
          [String(tenantId)],
        )
        .then((r) => r.rows);
    const before = await versions();
    await suDb.query(sql);
    expect(await versions()).toEqual(before);
  });

  // The negative twin, run through the FILE rather than a copy of the UPDATE, so deleting the
  // `SET app.is_super_admin` line turns this red. A managed-Postgres migration role is typically the
  // table owner without rolsuper, which FORCE RLS binds exactly like any other role.
  describe("run by a NON-superuser role (managed Postgres)", () => {
    async function seedProbe(name: string): Promise<bigint> {
      const r = await suDb.query(
        `INSERT INTO "agents" (tenant_id, name, system_prompt, model_config, settings, created_at, updated_at)
         VALUES ($1, $2, 'p', '{}'::jsonb, '{"tts":{"mode":"mirror","normalize":false}}'::jsonb, NOW(), NOW())
         RETURNING id`,
        [String(tenantId), name],
      );
      return BigInt(r.rows[0].id);
    }

    async function normalizeStillStored(id: bigint): Promise<boolean> {
      const r = await suDb.query(
        `SELECT jsonb_exists("settings" -> 'tts', 'normalize') AS present FROM "agents" WHERE id = $1`,
        [String(id)],
      );
      return r.rows[0]?.present === true;
    }

    async function runAsApp(statements: string) {
      const app = new Client({ connectionString: appUrl });
      await app.connect();
      try {
        await app.query(statements);
      } finally {
        await app.end();
      }
    }

    // The file's own `SET app.is_super_admin` line is INERT against today's schema. The policy that
    // read it was split into a role-restricted one (issue #382), and this migration only ever runs
    // BEFORE that split, on a database whose policy still carried the OR. So re-executing it here
    // has to supply the bypass of the era it is being run in, or the pair below stops
    // discriminating: both halves would report "changed nothing", for two different reasons, and
    // the guard would be green by invisibility rather than by working.
    test("the migration's statements reach the rows under the bypass of the era they run in", async () => {
      const id = await seedProbe("rls-probe-with-bypass");
      await runAsApp(`${ENTER_FLEET_ROLE_SQL};\n${sql}`);
      expect(await normalizeStillStored(id)).toBe(false);
    });

    test("the same statements with no bypass silently change nothing", async () => {
      const id = await seedProbe("rls-probe-no-bypass");
      // The file exactly as shipped, which today carries only the inert guard. No error, no rows:
      // exactly the failure this guard exists for, and the reason the fence in
      // migration-rls-bypass.test.ts asks for the CURRENT spelling from the split onward.
      expect(sql).toMatch(/^\s*SET\s+app\.is_super_admin/m);
      await runAsApp(sql);
      expect(await normalizeStillStored(id)).toBe(true);
    });
  });
});
