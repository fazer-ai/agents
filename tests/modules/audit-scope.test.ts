import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { ForbiddenError } from "@/lib/errors";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { listAudit, recordAudit } from "@/modules/audit/service";
import { syntheticAction } from "../utils/audit-action";

// WHICH TRAIL THE READ ANSWERS FOR (issue #520).
//
// The rows keyed to no tenant are not filtered out of the console, they are UNREACHABLE from it: the
// policy is `tenant_id = current_setting('app.tenant_id')` and NULL satisfies no comparison.
// Measured on a dev deployment before this: six rows written by six families -- `tenant.create`,
// `mcp_token.revoke`, `mcp_client.*`, `mcp_approval.revoke`, `branding.set` -- none of them on any
// page. The families that write them are the ones whose record must OUTLIVE a tenant, which is why
// they are keyed to none: an audit row is `ON DELETE CASCADE` on its tenant, so a `tenant.delete`
// filed under the tenant it deletes is erased by the same statement.
//
// So the scope is a question the caller asks, and the three answers are different QUERIES rather
// than three filters over one: `tenant` keeps the RLS read, `fleet` and `all` enter the fleet role,
// which is the only role the `fleet_super_admin` policy (`USING true`) admits.
//
// The refusal is asserted per scope and not once, because a scope that quietly degraded to the
// caller's own tenant would be the same silent omission this issue is about, wearing a new name.

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

let mine = 0n;
let theirs = 0n;
const USER = 9520n;

// The rows this file owns. `audit_logs` is shared and the fleet half of it is GLOBAL, so every
// assertion here counts its own targets rather than the table: another suite's fleet row is a real
// row and would make a count-the-table assertion pass or fail for reasons that are not this test's.
const TAG = `s520-${process.pid}`;
const OURS = (target: string) => target.startsWith(TAG);

const ctx = (over: Partial<TenantContext> = {}): TenantContext => ({
  tenantId: mine,
  userId: USER,
  role: "TENANT_ADMIN",
  ...over,
});

async function seedTenant(tenantId: bigint, name: string) {
  await runScopedOn(
    appDb,
    { tenantId, userId: USER, role: "TENANT_ADMIN" },
    (db) =>
      recordAudit(db, tenantId, {
        action: syntheticAction("scope.tenant"),
        target: `${TAG}:${name}`,
        actorId: USER,
        actorType: "user",
        after: { a: 1 },
      }),
  );
}

async function seedFleet(name: string) {
  await asSuperAdminOn(appDb, (db) =>
    recordAudit(db, null, {
      action: syntheticAction("scope.fleet"),
      target: `${TAG}:${name}`,
      actorId: USER,
      actorType: "user",
      after: { a: 1 },
    }),
  );
}

async function targetsOf(scope: "tenant" | "fleet" | "all", over = {}) {
  const page = await listAudit(
    ctx({ role: "SUPER_ADMIN", ...over }),
    { scope, limit: 500 },
    appDb,
  );
  return page.entries
    .map((e) => e.target ?? "")
    .filter(OURS)
    .sort();
}

describe.skipIf(!dbUp)("which trail the read answers for", () => {
  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "SCOPE520A", slug: `scope520a-${process.pid}` },
    });
    const b = await suDb.tenant.create({
      data: { name: "SCOPE520B", slug: `scope520b-${process.pid}` },
    });
    mine = a.id;
    theirs = b.id;
    await seedTenant(mine, "mine");
    await seedTenant(theirs, "theirs");
    await seedFleet("fleet");
    // MY TENANT ROW IS STAMPED AFTER EVERY FLEET ROW IN THE TABLE, which is what makes the
    // `latestAt` assertion below sharp. The fleet trail is global, so its maximum cannot be pinned
    // to a value; what CAN be pinned is that it must stay BELOW a tenant row, and an aggregate that
    // forgot the scope's predicate would answer with this one.
    const [top] = await suDb.$queryRaw<{ at: Date | null }[]>`
      SELECT max(created_at) AS at FROM audit_logs WHERE tenant_id IS NULL`;
    const after = new Date((top?.at ?? new Date()).getTime() + 3_600_000);
    await suDb.$executeRawUnsafe(
      `UPDATE audit_logs SET created_at = '${after.toISOString()}'::timestamptz
         WHERE target = '${TAG}:mine'`,
    );
  });

  afterAll(async () => {
    if (mine) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM audit_logs WHERE target LIKE '${TAG}%'`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id IN (${mine}, ${theirs})`,
      );
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("the default is the caller's own tenant, and it is what the page had", async () => {
    expect(await targetsOf("tenant")).toEqual([`${TAG}:mine`]);
  });

  // The whole point: these rows exist and no scope the console could ask for reached them.
  test("fleet reaches the rows keyed to no tenant, and only those", async () => {
    expect(await targetsOf("fleet")).toEqual([`${TAG}:fleet`]);
  });

  test("all reaches every tenant and the fleet rows together", async () => {
    expect(await targetsOf("all")).toEqual([
      `${TAG}:fleet`,
      `${TAG}:mine`,
      `${TAG}:theirs`,
    ]);
  });

  // A SUPER_ADMIN operating fleet-wide has NO tenant selected, and that is the shape a fleet-scoped
  // API key gives. Requiring a tenant target there would refuse the caller the scope exists for.
  test("fleet and all do not need a tenant to be selected", async () => {
    const page = await listAudit(
      { tenantId: null, userId: USER, role: "SUPER_ADMIN" },
      { scope: "fleet", limit: 500 },
      appDb,
    );
    expect(page.entries.map((e) => e.target ?? "").filter(OURS)).toEqual([
      `${TAG}:fleet`,
    ]);
  });

  for (const scope of ["fleet", "all"] as const) {
    test(`a tenant admin asking for ${scope} is refused, not narrowed`, async () => {
      await expect(
        listAudit(ctx(), { scope, limit: 500 }, appDb),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  }

  test("a tenant admin may still ask for its own tenant", async () => {
    const page = await listAudit(ctx(), { scope: "tenant", limit: 500 }, appDb);
    expect(page.entries.map((e) => e.target ?? "").filter(OURS)).toEqual([
      `${TAG}:mine`,
    ]);
  });

  // `latestAt` is documented as the newest row of the trail past any filter, and the TRAIL is now
  // whichever one the scope named. Reporting the tenant's newest row on a fleet read would describe
  // a trail the page is not showing.
  test("latestAt follows the scope", async () => {
    const t = await listAudit(
      ctx({ role: "SUPER_ADMIN" }),
      { scope: "tenant", limit: 500 },
      appDb,
    );
    // The tenant is fresh and owns exactly one row, so its trail's maximum IS that row.
    const ours = t.entries.filter((e) => OURS(e.target ?? ""));
    expect(ours).toHaveLength(1);
    expect(t.latestAt).toBe(ours[0]?.createdAt ?? "");

    const f = await listAudit(
      ctx({ role: "SUPER_ADMIN" }),
      { scope: "fleet", limit: 500 },
      appDb,
    );
    // THE ASSERTION THAT KILLS THE MUTATION. Under the fleet role an aggregate with no predicate
    // answers for the whole table, and the tenant row above was deliberately stamped later than
    // every fleet row — so a `latestAt` that reached it is one that forgot which trail it is on.
    // ISO-8601 sorts lexicographically, which is why the shape is fixed.
    expect((f.latestAt ?? "") < (t.latestAt ?? "")).toBe(true);
    const fleetRow = f.entries.find((e) => OURS(e.target ?? ""));
    expect(fleetRow).toBeDefined();
    expect((f.latestAt ?? "") >= (fleetRow?.createdAt ?? "")).toBe(true);
  });

  // `all` has no predicate BY DESIGN, so its maximum is the table's and must reach the tenant row.
  test("and on `all` it is the whole table's newest", async () => {
    const a = await listAudit(
      ctx({ role: "SUPER_ADMIN" }),
      { scope: "all", limit: 500 },
      appDb,
    );
    const t = await listAudit(
      ctx({ role: "SUPER_ADMIN" }),
      { scope: "tenant", limit: 500 },
      appDb,
    );
    expect((a.latestAt ?? "") >= (t.latestAt ?? "")).toBe(true);
  });
});
