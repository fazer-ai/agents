import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { FLEET_ROLE } from "@/lib/tenancy/fleet-role";
import { asSuperAdminOn, runScopedOn } from "@/lib/tenancy/multi-tenant";

// Issue #382. The policy every tenant-scoped table carries decides whether a tenant index is
// reachable at all, and the old shape put a column-free branch in an OR with the tenant predicate:
// the planner cannot turn either side into an index condition, so the whole policy became a Filter
// on top of whatever scan it picked. Measured on 1,000,000 rows before the split: 108 ms and
// 509,949 rows read and discarded to return a page of 51.
//
// The two halves below are separate tests on purpose. That the index is reachable says nothing
// about who can reach the rows, and every arrangement that fixes the plan can also delete the
// isolation — one of them silently (see the inheritance test).

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;

function makeClient(url: string) {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;

if (appUrl && suUrl) {
  try {
    su = makeClient(suUrl);
    await su.$queryRaw`SELECT 1`;
    app = makeClient(appUrl);
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let t1 = 0n;
let t2 = 0n;
const slugPrefix = `rls382-${process.pid}`;

// The plan is read as JSON and reduced to the one distinction that matters: did the tenant
// predicate land ON the index (an `Index Cond`), or on top of a scan that had already read the
// row (a `Filter`)? `enable_seqscan = off` is what keeps the answer about qual PLACEMENT rather
// than about the planner's cost choice on a small table — without it a table this size can be
// scanned either way and the assertion would depend on the seed size.
async function planOf(setup: (tx: PrismaClient) => Promise<void>) {
  return appDb.$transaction(async (tx) => {
    await setup(tx as unknown as PrismaClient);
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    const rows = (await tx.$queryRaw`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM outbound_webhook_deliveries ORDER BY id DESC LIMIT 51`) as Array<{
      "QUERY PLAN": Array<{ Plan: unknown }>;
    }>;
    const json = JSON.stringify(rows[0]?.["QUERY PLAN"]?.[0]?.Plan ?? {});
    const visible = (await tx.$queryRaw`
      SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS tenants
        FROM outbound_webhook_deliveries`) as Array<{
      n: number;
      tenants: number;
    }>;
    return {
      indexCond: json.match(/"Index Cond":"([^"]*)"/)?.[1] ?? null,
      filter: json.match(/"Filter":"([^"]*)"/)?.[1] ?? null,
      rows: visible[0]?.n ?? -1,
      tenants: visible[0]?.tenants ?? -1,
    };
  });
}

describe.skipIf(!dbUp)("RLS policy shape", () => {
  beforeAll(async () => {
    if (!su) return;
    const a = await su.tenant.create({
      data: { name: "RLS382-A", slug: `${slugPrefix}-a` },
    });
    const b = await su.tenant.create({
      data: { name: "RLS382-B", slug: `${slugPrefix}-b` },
    });
    t1 = a.id;
    t2 = b.id;
    for (const t of [a, b]) {
      const sub = await su.webhookSubscription.create({
        data: { tenantId: t.id, url: `https://rls382-${t.id}.invalid` },
      });
      await su.outboundWebhookDelivery.createMany({
        data: Array.from({ length: 200 }, () => ({
          tenantId: t.id,
          subscriptionId: sub.id,
          event: "probe",
        })),
      });
    }
    await su.$executeRaw`ANALYZE outbound_webhook_deliveries`;
  });

  afterAll(async () => {
    if (su && t1) {
      await su.outboundWebhookDelivery.deleteMany({
        where: { tenantId: { in: [t1, t2] } },
      });
      await su.webhookSubscription.deleteMany({
        where: { tenantId: { in: [t1, t2] } },
      });
      await su.tenant.deleteMany({ where: { id: { in: [t1, t2] } } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a tenant-scoped read reaches the tenant index instead of filtering on top", async () => {
    const plan = await planOf(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`;
    });
    expect(plan.indexCond).toContain("tenant_id");
    expect(plan.filter).toBeNull();
    expect(plan.rows).toBe(200);
    expect(plan.tenants).toBe(1);
  });

  // The positive control for the test above, and it has to be a case that genuinely cannot use the
  // index: a probe that reported `Index Cond` no matter what would pass on a policy that had never
  // been split. The fleet path is `USING (true)`, so there is no tenant predicate to put anywhere.
  test("the fleet path has no tenant predicate to index, which is what makes the probe above meaningful", async () => {
    const plan = await planOf(async (tx) => {
      await tx.$executeRaw`SELECT set_config('role', ${FLEET_ROLE}, true)`;
    });
    expect(plan.indexCond).toBeNull();
    // Bounds rather than equalities: this arm sees the WHOLE table, and other files in the suite
    // write to it concurrently. The two seeded tenants are the floor, the count is not a ceiling,
    // and what the assertion is actually about is that this arm crosses tenants at all.
    expect(plan.rows).toBeGreaterThanOrEqual(400);
    expect(plan.tenants).toBeGreaterThanOrEqual(2);
  });

  test("app.is_super_admin no longer elevates the app role", async () => {
    const seen = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.is_super_admin', 'on', true)`;
      await tx.$executeRaw`SELECT set_config('app.tenant_id', ${String(t1)}, true)`;
      return tx.$queryRaw`
        SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS tenants
          FROM outbound_webhook_deliveries`;
    });
    expect((seen as Array<{ n: number; tenants: number }>)[0]).toEqual({
      n: 200,
      tenants: 1,
    });
  });

  test("fail-closed: no tenant and no role change still sees nothing", async () => {
    const seen = (await appDb.$queryRaw`
      SELECT count(*)::int AS n FROM outbound_webhook_deliveries`) as Array<{
      n: number;
    }>;
    expect(seen[0]?.n).toBe(0);
  });

  test("asSuperAdmin still crosses tenants", async () => {
    const seen = await asSuperAdminOn(appDb, (db) =>
      db.outboundWebhookDelivery.findMany({
        where: { tenantId: { in: [t1, t2] } },
        select: { tenantId: true },
      }),
    );
    expect(new Set(seen.map((r) => r.tenantId)).size).toBe(2);
  });

  test("runScoped still fences to one tenant", async () => {
    const seen = await runScopedOn(
      appDb,
      { tenantId: t1, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        db.outboundWebhookDelivery.findMany({ select: { tenantId: true } }),
    );
    expect(seen.length).toBe(200);
    expect(new Set(seen.map((r) => r.tenantId))).toEqual(new Set([t1]));
  });

  test("the fleet role is reachable by SET ROLE and NOT by inheritance", async () => {
    const who = (await appDb.$queryRaw`
      SELECT pg_has_role(session_user, ${FLEET_ROLE}, 'SET')    AS can_set_role,
             pg_has_role(session_user, ${FLEET_ROLE}, 'MEMBER') AS member,
             pg_has_role(session_user, ${FLEET_ROLE}, 'USAGE')  AS usage`) as Array<{
      can_set_role: boolean;
      member: boolean;
      usage: boolean;
    }>;
    // SET, not MEMBER, is what `asSuperAdmin` needs — a grant made `WITH SET FALSE` answers MEMBER
    // true and denies `SET ROLE` (measured on 17.10). USAGE is the opposite failure: with it true
    // the fleet policy applies PASSIVELY to the app role, which reads every tenant's rows with no
    // error and no plan difference, i.e. the whole isolation model gone silently.
    expect(who[0]?.can_set_role).toBe(true);
    expect(who[0]?.member).toBe(true);
    expect(who[0]?.usage).toBe(false);

    // And the mechanism itself, not just the catalog's opinion of it.
    const asFleet = await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('role', ${FLEET_ROLE}, true)`;
      return tx.$queryRaw`SELECT current_user AS u`;
    });
    expect((asFleet as Array<{ u: string }>)[0]?.u).toBe(FLEET_ROLE);
  });

  test("the fleet role holds no privilege of its own", async () => {
    const role = (await suDb.$queryRaw`
      SELECT rolsuper, rolbypassrls, rolcanlogin
        FROM pg_roles WHERE rolname = ${FLEET_ROLE}`) as Array<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>;
    expect(role[0]).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcanlogin: false,
    });
  });

  test("the fleet role is dropped at the end of the transaction, on commit and on rollback", async () => {
    const sessionUser = (
      (await appDb.$queryRaw`SELECT session_user AS u`) as Array<{ u: string }>
    )[0]?.u;
    await appDb.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('role', ${FLEET_ROLE}, true)`;
    });
    const afterCommit = (await appDb.$queryRaw`
      SELECT current_user AS u`) as Array<{ u: string }>;
    expect(afterCommit[0]?.u).toBe(sessionUser as string);

    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('role', ${FLEET_ROLE}, true)`;
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const afterRollback = (await appDb.$queryRaw`
      SELECT current_user AS u`) as Array<{ u: string }>;
    expect(afterRollback[0]?.u).toBe(sessionUser as string);
  });

  // The fence. The plan test above proves ONE table; this one is what makes the next table born
  // with the old shape fail, and what would have caught the whole defect: the `is_super_admin`
  // branch is not a property of a table, it is a property of every policy in the schema.
  test("every table under RLS carries the split policy pair, and no tenant policy names the old GUC", async () => {
    const policies = (await suDb.$queryRaw`
      SELECT c.relname                                   AS table_name,
             p.polname                                   AS policy,
             pg_get_expr(p.polqual, p.polrelid)          AS qual,
             COALESCE(
               (SELECT array_agg(r.rolname::text ORDER BY r.rolname)
                  FROM pg_roles r WHERE r.oid = ANY (p.polroles)),
               ARRAY['public']::text[])                  AS roles
        FROM pg_policy p
        JOIN pg_class c     ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
       ORDER BY 1, 2`) as Array<{
      table_name: string;
      policy: string;
      qual: string;
      roles: string[];
    }>;

    const tables = [...new Set(policies.map((p) => p.table_name))];
    // Positive control: a broken query and a schema with nothing left to check both answer with an
    // empty array, and only this line tells them apart.
    expect(tables.length).toBeGreaterThan(30);

    const tenantPolicies = policies.filter(
      (p) => p.policy === "tenant_isolation",
    );
    const fleetPolicies = policies.filter(
      (p) => p.policy === "fleet_super_admin",
    );
    expect(tenantPolicies.length).toBe(tables.length);
    expect(fleetPolicies.length).toBe(tables.length);
    expect(policies.length).toBe(tables.length * 2);

    // The tenant policy applies to everyone (no TO clause), so the migration never has to know the
    // deployment's app-role name — which is configurable. Only the fleet policy names a role.
    expect(
      tenantPolicies
        .filter((p) => p.roles.join() !== "public")
        .map((p) => p.table_name),
    ).toEqual([]);
    expect(
      fleetPolicies
        .filter((p) => p.roles.join() !== FLEET_ROLE)
        .map((p) => p.table_name),
    ).toEqual([]);
    expect(
      tenantPolicies
        .filter((p) => p.qual.includes("is_super_admin"))
        .map((p) => p.table_name),
    ).toEqual([]);
  });

  // The claim that decides POLICY over BYPASSRLS, which is the design this replaced rather than the
  // one it fixes — so it had no number behind it until here. A table that gets RLS in some future
  // migration and does not get its fleet policy is invisible to the fleet path under this design,
  // and fully visible under the other one.
  test("a table under RLS with no fleet policy fails CLOSED for the fleet path", async () => {
    const probe = `rls382_forgotten_${process.pid}`;
    const bypassRole = `rls382_bypass_${process.pid}`;
    await suDb.$executeRawUnsafe(`
      CREATE TABLE ${probe} (id bigserial PRIMARY KEY, tenant_id bigint NOT NULL);
      INSERT INTO ${probe} (tenant_id) SELECT (g % 3) + 1 FROM generate_series(1, 30) g;
      ALTER TABLE ${probe} ENABLE ROW LEVEL SECURITY;
      ALTER TABLE ${probe} FORCE ROW LEVEL SECURITY;
      CREATE POLICY tenant_isolation ON ${probe}
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
      GRANT SELECT ON ${probe} TO ${FLEET_ROLE};`);
    try {
      const seen = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('role', ${FLEET_ROLE}, true)`;
        return tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${probe}`);
      });
      expect((seen as Array<{ n: number }>)[0]?.n).toBe(0);

      // The counterfactual, measured rather than argued: the same table, reached by a BYPASSRLS role
      // — the design this one was chosen over — hands back every row.
      //
      // The grantee is read from the APP connection, not written as `session_user`: inside the su
      // client that resolves to the migration role, and the grant would land on the wrong account.
      const runtimeRole = (
        (await appDb.$queryRaw`SELECT session_user AS u`) as Array<{
          u: string;
        }>
      )[0]?.u as string;
      await suDb.$executeRawUnsafe(`
        CREATE ROLE ${bypassRole} NOLOGIN NOSUPERUSER BYPASSRLS;
        GRANT SELECT ON ${probe} TO ${bypassRole};
        GRANT ${bypassRole} TO "${runtimeRole}" WITH INHERIT FALSE, SET TRUE;`);
      const viaBypass = await appDb.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('role', ${bypassRole}, true)`;
        return tx.$queryRawUnsafe(`SELECT count(*)::int AS n FROM ${probe}`);
      });
      expect((viaBypass as Array<{ n: number }>)[0]?.n).toBe(30);
    } finally {
      await suDb.$executeRawUnsafe(`DROP TABLE IF EXISTS ${probe}`);
      await suDb.$executeRawUnsafe(`DROP ROLE IF EXISTS ${bypassRole}`);
    }
  });

  test("every table with RLS enabled also FORCES it, so the owner is fenced too", async () => {
    const tables = (await suDb.$queryRaw`
      SELECT c.relname AS table_name, c.relforcerowsecurity AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`) as Array<{
      table_name: string;
      forced: boolean;
    }>;
    expect(tables.length).toBeGreaterThan(30);
    expect(tables.filter((t) => !t.forced).map((t) => t.table_name)).toEqual(
      [],
    );
  });
});
