import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { ENTER_FLEET_ROLE_SQL } from "@/lib/tenancy/fleet-role";

// The original `follow_up_armed_at` backfill (20260807032257) ends in a bare
// `UPDATE "agents" SET "follow_up_armed_at" = NOW()`. `agents` carries FORCE ROW LEVEL SECURITY,
// which subjects even the table OWNER to `tenant_isolation`; only a superuser (or BYPASSRLS) is
// exempt. On managed Postgres the migration role is typically the owner WITHOUT rolsuper, so that
// statement matched zero rows and reported success — leaving every pre-existing agent with a null
// watermark, which the sweep reads as "never armed" and skips forever (issue #106).
//
// This suite runs the follow-up migration through the APP connection, which is a non-superuser
// role with RLS in force — the same conditions the affected installs migrate under. Running it as
// the suite's superuser would prove nothing: the bare UPDATE works there, which is exactly why the
// defect shipped unnoticed.
const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const MIGRATION_SQL =
  "prisma/migrations/20260818120000_followup_armed_at_backfill_rls/migration.sql";

// Statements in file order, comments stripped. They must run on ONE connection: the GUC the
// backfill sets is session state, so splitting them across the pool would arm nothing.
async function migrationStatements(): Promise<string[]> {
  return (await Bun.file(MIGRATION_SQL).text())
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

describe.skipIf(!dbUp)("follow_up_armed_at backfill under RLS", () => {
  let tenantId = 0n;
  let strandedId = 0n;
  let alreadyArmedId = 0n;
  const armedLongAgo = new Date("2026-01-01T00:00:00.000Z");

  beforeAll(async () => {
    const tenant = await suDb.tenant.create({
      data: { name: "ARM", slug: `arm-${process.pid}` },
    });
    tenantId = tenant.id;
    // The agent an affected install is left with: created before the deploy, never armed.
    const stranded = await suDb.agent.create({
      data: {
        tenantId,
        name: "stranded",
        systemPrompt: "p",
        followUpArmedAt: null,
      },
    });
    strandedId = stranded.id;
    // An install where the original backfill DID work, or an agent armed later by the app. A
    // re-run must not move its watermark: re-arming would re-open the historical backlog the
    // column exists to fence off.
    const armed = await suDb.agent.create({
      data: {
        tenantId,
        name: "already armed",
        systemPrompt: "p",
        followUpArmedAt: armedLongAgo,
      },
    });
    alreadyArmedId = armed.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await suDb.agent.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // The file's own `SET app.is_super_admin` statement is INERT against today's schema: the policy
  // that read it was split into a role-restricted one (issue #382), and this migration only ever
  // runs BEFORE that split, on a database whose policy still carried the OR. Re-executing it here
  // therefore has to supply the bypass of the era it is being run in — without it both this test
  // and its negative twin would report "armed nothing", for two different reasons, and the pair
  // would stop discriminating.
  test("arms the agents the original backfill left behind", async () => {
    const statements = await migrationStatements();
    await appDb.$transaction(
      [ENTER_FLEET_ROLE_SQL, ...statements].map((s) =>
        appDb.$executeRawUnsafe(s),
      ),
    );

    const stranded = await suDb.agent.findUniqueOrThrow({
      where: { id: strandedId },
    });
    expect(stranded.followUpArmedAt).not.toBeNull();
  });

  test("leaves an already-armed agent's watermark untouched", async () => {
    const armed = await suDb.agent.findUniqueOrThrow({
      where: { id: alreadyArmedId },
    });
    expect(armed.followUpArmedAt?.toISOString()).toBe(
      armedLongAgo.toISOString(),
    );
  });
});
