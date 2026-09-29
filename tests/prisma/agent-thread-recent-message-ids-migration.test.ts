import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "pg";
import { INGEST_ID_WINDOW } from "@/graph/ingest-dedup";
import { ENTER_FLEET_ROLE_SQL } from "@/lib/tenancy/fleet-role";

// Runs the ACTUAL backfill of MIGRATION against the test database, and pins three things:
//   * FORCE ROW LEVEL SECURITY binds even the table OWNER: on managed Postgres (owner WITHOUT
//     rolsuper) a bare UPDATE matches zero rows and reports success. The negative twin below runs
//     the statements as the APP role with and without a bypass.
//   * The fill SATURATES the window, or the old watermark stops acting as a floor.
//   * The fill width is frozen at INGEST_ID_WINDOW's value when the migration ran.
// The statements come from the file on DISK minus the DDL: a pasted copy would drift, and the DDL
// cannot be re-run against a database the migration was already applied to.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260822151000_agent_thread_recent_message_ids/migration.sql";

// Comments first (so a `--` line naming a statement cannot be mistaken for one), then split on the
// statement terminator and drop the DDL. Both counts are asserted at the call site: a restructured
// migration must fail loudly here rather than quietly run nothing.
function dataStatementsOf(file: string): { sql: string; dropped: number } {
  const bare = file
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");
  const all = bare
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const kept = all.filter((s) => !/^ALTER\s+TABLE/i.test(s));
  return { sql: `${kept.join(";\n")};`, dropped: all.length - kept.length };
}

let dbUp = false;
let dataSql = "";
let droppedDdl = 0;
let su: Client | undefined;
if (suUrl && appUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    const parsed = dataStatementsOf(await Bun.file(MIGRATION).text());
    dataSql = parsed.sql;
    droppedDdl = parsed.dropped;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

let tenantId = 0n;
let instanceId = 0n;
const SUFFIX = `atrm-${process.pid}`;

interface Window {
  synced: number[];
  agent: number[];
}

async function windowOf(threadId: string): Promise<Window> {
  const r = await suDb.query(
    `SELECT recent_synced_message_ids AS synced, recent_agent_message_ids AS agent
       FROM "agent_threads" WHERE thread_id = $1`,
    [threadId],
  );
  return { synced: r.rows[0]?.synced ?? [], agent: r.rows[0]?.agent ?? [] };
}

async function seedThread(
  name: string,
  syncedMark: number | null,
  agentMark: number | null,
  contactInboxId: number,
): Promise<string> {
  const threadId = `${SUFFIX}-${name}`;
  await suDb.query(
    `INSERT INTO "agent_threads"
       (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id,
        last_synced_message_id, last_agent_message_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [
      String(tenantId),
      String(instanceId),
      contactInboxId,
      threadId,
      syncedMark,
      agentMark,
    ],
  );
  return threadId;
}

describe.skipIf(!dbUp)("migration: agent thread recent message ids", () => {
  beforeAll(async () => {
    await suDb.query("SET app.is_super_admin = 'on'");
    const t = await suDb.query(
      "INSERT INTO tenants (name, slug, created_at, updated_at) VALUES ($1, $2, NOW(), NOW()) RETURNING id",
      ["ATRMMIG", SUFFIX],
    );
    tenantId = BigInt(t.rows[0].id);
    const d = await suDb.query(
      `INSERT INTO chatwoot_deployments (tenant_id, base_url, admin_token, updated_at)
       VALUES ($1, $2, 'token', NOW()) RETURNING id`,
      [String(tenantId), `http://${SUFFIX}.invalid`],
    );
    const i = await suDb.query(
      `INSERT INTO chatwoot_instances (tenant_id, deployment_id, account_id, server_key, updated_at)
       VALUES ($1, $2, 1, $3, NOW()) RETURNING id`,
      [String(tenantId), String(d.rows[0].id), SUFFIX],
    );
    instanceId = BigInt(i.rows[0].id);
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.query("SET app.is_super_admin = 'on'");
      await suDb.query("DELETE FROM tenants WHERE id = $1", [String(tenantId)]);
    }
    await suDb.end();
  });

  test("the file carries exactly one DDL statement, and the rest is the backfill", () => {
    expect(droppedDdl).toBe(1);
    expect(dataSql).toMatch(
      /UPDATE\s+"agent_threads"[\s\S]*recent_synced_message_ids/,
    );
    expect(dataSql).toMatch(
      /UPDATE\s+"agent_threads"[\s\S]*recent_agent_message_ids/,
    );
    expect(dataSql).toMatch(/^\s*SET\s+app\.is_super_admin/m);
  });

  test("seeds each direction's window SATURATED with the mark it already had", async () => {
    const both = await seedThread("both", 700, 650, 90001);
    const syncedOnly = await seedThread("synced-only", 800, null, 90002);
    const neither = await seedThread("neither", null, null, 90003);

    await suDb.query(dataSql);

    const w = await windowOf(both);
    // Saturated, not a single element: a partial window has forgotten nothing, so every id below
    // the old mark would read as new and be appended a second time on a re-delivery.
    expect(w.synced.length).toBe(64);
    expect(new Set(w.synced)).toEqual(new Set([700]));
    expect(w.agent.length).toBe(64);
    expect(new Set(w.agent)).toEqual(new Set([650]));

    // Each direction is filled from its OWN watermark, so a thread the agent never wrote to keeps
    // an empty agent window rather than borrowing the inbound mark.
    const s = await windowOf(syncedOnly);
    expect(new Set(s.synced)).toEqual(new Set([800]));
    expect(s.agent).toEqual([]);

    // A thread that never ingested anything stays genuinely empty: `ingestVerdict` reads a partial
    // window as the complete record, and a filler here would invent a floor that never existed.
    expect(await windowOf(neither)).toEqual({ synced: [], agent: [] });
  });

  // NOTE: the fill width is frozen at what INGEST_ID_WINDOW was when the migration ran, so RAISING the
  // constant reads every migrated row as partial again. Lowering it is free, hence a floor, not an
  // equality.
  test("the frozen fill still saturates the window the code uses", async () => {
    const t = await seedThread("frozen", 900, null, 90004);
    await suDb.query(dataSql);
    const w = await windowOf(t);
    expect(w.synced.length).toBeGreaterThanOrEqual(INGEST_ID_WINDOW);
  });

  // NOTE: the negative twin, run through the FILE's own statements rather than a copy, so deleting the
  // `SET app.is_super_admin` line turns this red.
  describe("run by a NON-superuser role (managed Postgres)", () => {
    async function runAsApp(statements: string) {
      const app = new Client({ connectionString: appUrl });
      await app.connect();
      try {
        await app.query(statements);
      } finally {
        await app.end();
      }
    }

    // NOTE: the file's own `SET app.is_super_admin` line is INERT against today's schema, whose policy is
    // role-restricted; the migration only runs on a database whose policy still read that GUC. So the
    // re-run supplies the bypass of its era, or both halves below report "changed nothing" for two
    // different reasons and the guard is green by invisibility.
    test("the backfill reaches the rows under the bypass of the era it runs in", async () => {
      const t = await seedThread("rls-with-bypass", 1100, null, 90005);
      await runAsApp(`${ENTER_FLEET_ROLE_SQL};\n${dataSql}`);
      expect((await windowOf(t)).synced.length).toBe(64);
    });

    test("the same backfill with no bypass silently changes nothing", async () => {
      const t = await seedThread("rls-no-bypass", 1200, null, 90006);
      // NOTE: the file as it ships, carrying only the inert guard. No error, no rows: the failure this
      // guard exists for.
      expect(dataSql).toMatch(/^\s*SET\s+app\.is_super_admin/m);
      await runAsApp(dataSql);
      expect((await windowOf(t)).synced).toEqual([]);
    });
  });
});
