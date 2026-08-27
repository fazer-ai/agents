import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { ENTER_FLEET_ROLE_SQL } from "@/lib/tenancy/fleet-role";
import { seedChatwootInstance } from "../utils/chatwoot";

// Runs the ACTUAL migration file against the test database. The dashboard tells the operator that N
// conversations predate the recording, which is the whole defence against the Resolution funnel
// appearing to collapse on upgrade day. That promise rests on one UPDATE, and on the `SET` that lets
// it see anything at all:
//
//   * `conversations` carries FORCE ROW LEVEL SECURITY, so `tenant_isolation` binds the table OWNER
//     as well. A managed-Postgres admin role (RDS/Neon/Supabase) is typically owner WITHOUT
//     rolsuper, and there the backfill matches zero rows and reports success. The negative twin
//     below runs the file as the APP role with and without the `SET`, so the guard cannot be dropped
//     without a red test. This is the same silent failure as issue #106.
//   * A backfill that ran but stamped the wrong rows is just as wrong as one that ran on none, hence
//     the row-by-row assertion over every status an install can hold.
//
// The file is executed from DISK on purpose: a copy pasted in here would drift, and Prisma's
// $executeRawUnsafe rejects multiple statements anyway, which would silently swallow the `SET`.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20260822150000_conversation_resolved_by/migration.sql";

let dbUp = false;
let sql = "";
let su: Client | undefined;
let prisma: PrismaClient | undefined;
if (suUrl && appUrl) {
  try {
    // Two handles on the same superuser connection string, for two different jobs: `pg` runs the
    // migration file (multi-statement, which Prisma refuses), Prisma seeds the fixture without this
    // test having to know the current column list of three tables.
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await prisma.$queryRaw`SELECT 1`;
    sql = await Bun.file(MIGRATION).text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;
const db = prisma as PrismaClient;

// The column already exists (the test DB was built by running every migration), so only the data
// half of the file is replayed here. Splitting on the DDL keeps the `SET`/`UPDATE`/`RESET` trio
// intact — that trio is what is under test.
function dataHalf(file: string): string {
  const i = file.indexOf("SET app.is_super_admin");
  if (i < 0) throw new Error("the migration no longer sets the RLS bypass");
  return file.slice(i);
}

const STATUSES = ["resolved", "open", "pending", "snoozed"] as const;
let tenantId = 0n;
let instanceId = 0n;
const ids: Record<string, bigint> = {};

async function originOf(name: string): Promise<string | null> {
  const r = await suDb.query(
    'SELECT "resolved_by" FROM "conversations" WHERE id = $1',
    [String(ids[name])],
  );
  return r.rows[0]?.resolved_by ?? null;
}

async function clearOrigins(): Promise<void> {
  await suDb.query(
    'UPDATE "conversations" SET "resolved_by" = NULL WHERE tenant_id = $1',
    [String(tenantId)],
  );
}

describe.skipIf(!dbUp)("migration: conversations.resolved_by", () => {
  beforeAll(async () => {
    const t = await db.tenant.create({
      data: { name: "RESBY", slug: `resby-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await seedChatwootInstance(db, {
      tenantId,
      accountId: 91,
      baseUrl: "https://cw.example",
      adminToken: "enc",
    });
    instanceId = inst.id;
    let convId = 8100;
    for (const status of STATUSES) {
      convId += 1;
      const conv = await db.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: convId,
          status,
          threadId: `${tenantId}:${instanceId}:${convId}`,
        },
      });
      ids[status] = conv.id;
    }
    await clearOrigins();
  });

  afterAll(async () => {
    if (tenantId) {
      await db.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    }
    await suDb.end();
    await db.$disconnect();
  });

  test("stamps every already-resolved row and nothing else", async () => {
    await suDb.query(dataHalf(sql));
    expect(await originOf("resolved")).toBe("legacy_unknown");
    for (const status of ["open", "pending", "snoozed"] as const) {
      expect(await originOf(status)).toBeNull();
    }
  });

  // The negative twin, run through the FILE rather than a copy of the UPDATE, so deleting the
  // `SET app.is_super_admin` line turns this red. FORCE RLS binds a non-superuser owner exactly like
  // any other role, which is what a managed-Postgres migration role usually is.
  describe("run by a NON-superuser role (managed Postgres)", () => {
    async function runAsApp(statements: string): Promise<void> {
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
    // discriminating: both halves would report "matched nothing", for two different reasons, and
    // the guard would be green by invisibility rather than by working.
    test("with no bypass the backfill silently matches nothing", async () => {
      await clearOrigins();
      // The file exactly as shipped. No error, no warning: that is the whole problem.
      expect(dataHalf(sql)).toMatch(/^\s*SET\s+app\.is_super_admin/m);
      await runAsApp(dataHalf(sql));
      expect(await originOf("resolved")).toBeNull();
    });

    test("under the bypass of the era it runs in, it reaches the historical rows", async () => {
      await clearOrigins();
      await runAsApp(`${ENTER_FLEET_ROLE_SQL};\n${dataHalf(sql)}`);
      expect(await originOf("resolved")).toBe("legacy_unknown");
      expect(await originOf("open")).toBeNull();
    });
  });
});
