import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  ENTER_FLEET_ROLE_SQL,
  FLEET_ROLE_EXPR,
  FLEET_ROLE_FN,
} from "@/lib/tenancy/fleet-role";
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
// Resolved from the database rather than written here: the name carries the database, and a copy in
// this file would be a second spelling of the thing under test.
let fleetRole = "";
const slugPrefix = `rls382-${process.pid}`;
// The plan probe runs on a table of its own. `outbound_webhook_deliveries` is written by other
// files in this suite, and a concurrent DELETE moves the statistics out from under the planner:
// measured, the same policy came out as an `Index Cond` alone and as a bare `Filter` in a full run.
// What is under test is whether the QUAL can be pushed into an index, not which plan the planner
// happens to cost cheapest today — and the real table's shape is held by the catalog fence below.
const PROBE_TABLE = `rls382_plan_${process.pid}`;

// The plan is read as JSON and reduced to the one distinction that matters: did the tenant
// predicate land ON the index (an `Index Cond`), or on top of a scan that had already read the
// row (a `Filter`)? `enable_seqscan = off` is what keeps the answer about qual PLACEMENT rather
// than about the planner's cost choice on a small table — without it a table this size can be
// scanned either way and the assertion would depend on the seed size.
async function planOf(setup: (tx: PrismaClient) => Promise<void>) {
  return appDb.$transaction(async (tx) => {
    await setup(tx as unknown as PrismaClient);
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    const rows = (await tx.$queryRawUnsafe(`
      EXPLAIN (FORMAT JSON)
      SELECT id FROM ${PROBE_TABLE} ORDER BY id DESC LIMIT 51`)) as Array<{
      "QUERY PLAN": Array<{ Plan: unknown }>;
    }>;
    const json = JSON.stringify(rows[0]?.["QUERY PLAN"]?.[0]?.Plan ?? {});
    const visible = (await tx.$queryRawUnsafe(`
      SELECT count(*)::int AS n, count(DISTINCT tenant_id)::int AS tenants
        FROM ${PROBE_TABLE}`)) as Array<{
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
    // The probe table, with the policies this change ships and the skew the issue measured: one
    // small tenant whose rows are spread across the id range, so a backward primary-key scan has to
    // walk the table to fill a page. 200 rows for t1, 3000 for t2.
    for (const statement of [
      `CREATE TABLE ${PROBE_TABLE} (
         id bigserial PRIMARY KEY, tenant_id bigint NOT NULL, status text NOT NULL DEFAULT 'P')`,
      `INSERT INTO ${PROBE_TABLE} (tenant_id)
         SELECT CASE WHEN g % 16 = 7 THEN ${t1} ELSE ${t2} END FROM generate_series(1, 3200) g`,
      `CREATE INDEX ${PROBE_TABLE}_tenant_id_id_idx ON ${PROBE_TABLE} (tenant_id, id)`,
      `ALTER TABLE ${PROBE_TABLE} ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${PROBE_TABLE} FORCE ROW LEVEL SECURITY`,
      `CREATE POLICY tenant_isolation ON ${PROBE_TABLE}
         USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
         WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)`,
      `DO $do$ BEGIN EXECUTE format(
         'CREATE POLICY fleet_super_admin ON ${PROBE_TABLE} TO %I USING (true) WITH CHECK (true)',
         public.fazerai_fleet_role()); END $do$`,
      `DO $do$ BEGIN EXECUTE format(
         'GRANT SELECT ON ${PROBE_TABLE} TO %I', public.fazerai_fleet_role()); END $do$`,
      `GRANT SELECT ON ${PROBE_TABLE} TO PUBLIC`,
      `ANALYZE ${PROBE_TABLE}`,
    ]) {
      await su.$executeRawUnsafe(statement);
    }
    fleetRole = (
      (await su.$queryRawUnsafe(`SELECT ${FLEET_ROLE_FN} AS role`)) as Array<{
        role: string;
      }>
    )[0]?.role as string;
  });

  afterAll(async () => {
    if (su) await su.$executeRawUnsafe(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
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
      await tx.$executeRawUnsafe(ENTER_FLEET_ROLE_SQL);
    });
    expect(plan.indexCond).toBeNull();
    expect(plan.rows).toBe(3200);
    expect(plan.tenants).toBe(2);
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
      SELECT pg_has_role(session_user, ${fleetRole}, 'SET')    AS can_set_role,
             pg_has_role(session_user, ${fleetRole}, 'MEMBER') AS member,
             pg_has_role(session_user, ${fleetRole}, 'USAGE')  AS usage`) as Array<{
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
      await tx.$executeRawUnsafe(ENTER_FLEET_ROLE_SQL);
      return tx.$queryRaw`SELECT current_user AS u`;
    });
    expect((asFleet as Array<{ u: string }>)[0]?.u).toBe(fleetRole);
  });

  // The one duplicate in the design, fenced by measurement rather than by a comment asking for care.
  // `db-bootstrap` runs BEFORE the migration that creates the function, so it carries the derivation
  // inline; every other caller uses the function. If the two ever disagree, bootstrap provisions one
  // role and the policies name another, and every cross-tenant read answers zero rows in silence.
  test("the expression db-bootstrap carries resolves to the same name as the function", async () => {
    const both = (await suDb.$queryRawUnsafe(
      `SELECT ${FLEET_ROLE_EXPR} AS inline, ${FLEET_ROLE_FN} AS fn`,
    )) as Array<{ inline: string; fn: string }>;
    expect(both[0]?.inline).toBe(both[0]?.fn as string);
    // And it is the name actually in use, not just two agreeing strings.
    expect(both[0]?.fn).toBe(fleetRole);
    // It carries the database, which is the whole reason it is derived at all.
    const db = (
      (await suDb.$queryRaw`SELECT current_database() AS d`) as Array<{
        d: string;
      }>
    )[0]?.d as string;
    expect(fleetRole).toContain(db.slice(0, 30));
    expect(fleetRole.length).toBeLessThanOrEqual(63);
  });

  // The derivation has to survive names Postgres accepts and this repository did not think of. Both
  // of these were live defects, measured before the normalisation went in:
  //
  //   * `left(…, 30)` counts CHARACTERS while an identifier is limited to 63 BYTES. A 25-character
  //     Japanese name derived 86 bytes, Postgres truncated it SILENTLY, the truncation cut off the
  //     hash, and the next grant failed with `role does not exist`.
  //   * a database name may contain a double quote, and it landed inside the derived name: the next
  //     `GRANT … TO "<name>"` came out as `syntax error at or near …`.
  //
  // Asked of the EXPRESSION this repository ships, with the database swapped for a parameter, so it
  // cannot pass against a second copy of the rule written to agree with itself.
  test("the derived name stays inside the identifier limit, and safe to interpolate", async () => {
    const expr = FLEET_ROLE_EXPR.replaceAll("current_database()::text", "$1");
    const hostile = [
      "相談記録データベース本番環境用相談記録データベース",
      'quo"te_db',
      "agents_prod",
      `${"a".repeat(60)}_one`,
      `${"a".repeat(60)}_two`,
      "relatórios_de_atendimento_ção_ão",
    ];
    const derived: string[] = [];
    for (const name of hostile) {
      const row = (await suDb.$queryRawUnsafe(
        `SELECT ${expr} AS derived, octet_length(${expr}) AS bytes,
                (${expr})::name AS as_identifier`,
        name,
      )) as Array<{ derived: string; bytes: number; as_identifier: string }>;
      const r = row[0] as (typeof row)[number];
      // Under the limit, so `::name` is not a truncation — and the hash survives, which is what
      // keeps two long names that share a prefix from becoming one role.
      expect(r.bytes).toBeLessThanOrEqual(63);
      expect(r.as_identifier).toBe(r.derived);
      expect(r.derived).toMatch(/^fazerai_fleet_[a-zA-Z0-9_]+_[0-9a-f]{8}$/);
      derived.push(r.derived);
    }
    // Distinct names stay distinct, including the two that agree in their first 60 characters and
    // the pair that differ only in punctuation the prefix normalises away.
    expect(new Set(derived).size).toBe(hostile.length);
  });

  test("the fleet role holds no privilege of its own", async () => {
    const role = (await suDb.$queryRaw`
      SELECT rolsuper, rolbypassrls, rolcanlogin
        FROM pg_roles WHERE rolname = ${fleetRole}`) as Array<{
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
      await tx.$executeRawUnsafe(ENTER_FLEET_ROLE_SQL);
    });
    const afterCommit = (await appDb.$queryRaw`
      SELECT current_user AS u`) as Array<{ u: string }>;
    expect(afterCommit[0]?.u).toBe(sessionUser as string);

    await expect(
      appDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ENTER_FLEET_ROLE_SQL);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const afterRollback = (await appDb.$queryRaw`
      SELECT current_user AS u`) as Array<{ u: string }>;
    expect(afterRollback[0]?.u).toBe(sessionUser as string);
  });

  // WHY the fence asks for exactly one role, and not merely that the fleet role is among them. A
  // policy is a list, and `USING (true)` applies to every role on it — so one extra name is not a
  // cosmetic drift, it is every tenant handed to that name with no `SET ROLE` involved at all. The
  // runtime check in `src/lib/db-guard.ts` asked containment until this was measured.
  test("one extra role on the fleet policy hands it every tenant", async () => {
    const appRole = (
      (await appDb.$queryRaw`SELECT current_user AS u`) as Array<{ u: string }>
    )[0]?.u as string;
    const readsWithNoScope = async () =>
      (
        (await appDb.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM ${PROBE_TABLE}`,
        )) as Array<{ n: number }>
      )[0]?.n as number;

    // The shipped shape first, as the control: the runtime role is subject to the tenant policy and
    // no scope is set, so it sees nothing.
    expect(await readsWithNoScope()).toBe(0);

    await suDb.$executeRawUnsafe(
      `DROP POLICY fleet_super_admin ON ${PROBE_TABLE}`,
    );
    await suDb.$executeRawUnsafe(
      `CREATE POLICY fleet_super_admin ON ${PROBE_TABLE} TO "${fleetRole}", "${appRole}"
         USING (true) WITH CHECK (true)`,
    );
    try {
      // Every row, from the ordinary runtime connection, with no scope and no SET ROLE.
      expect(await readsWithNoScope()).toBe(3200);
    } finally {
      await suDb.$executeRawUnsafe(
        `DROP POLICY fleet_super_admin ON ${PROBE_TABLE}`,
      );
      await suDb.$executeRawUnsafe(
        `DO $do$ BEGIN EXECUTE format(
           'CREATE POLICY fleet_super_admin ON ${PROBE_TABLE} TO %I USING (true) WITH CHECK (true)',
           public.fazerai_fleet_role()); END $do$`,
      );
    }
    expect(await readsWithNoScope()).toBe(0);
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
        .filter((p) => p.roles.join() !== fleetRole)
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
      GRANT SELECT ON ${probe} TO "${fleetRole}";`);
    try {
      const seen = await appDb.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ENTER_FLEET_ROLE_SQL);
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
