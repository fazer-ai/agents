import { describe, expect, test } from "bun:test";

// `scripts/db-bootstrap.ts` and `scripts/db-bootstrap.sql` provision the same thing by two routes:
// the first runs unattended on every container boot, the second is the by-hand psql equivalent for
// a bare Postgres. Two copies of one answer drift silently (the `.sql` has no test of its own): a
// membership RECONCILE in one and not the other leaves a recreated database readable by the
// previous installation's runtime role. The psql script cannot run here (`\set` / `:'var'` are psql
// features), so this asks whether each file CONTAINS the construct for each invariant; a rename
// breaks it loudly, which is the failure mode to want.

const INVARIANTS: Array<{
  what: string;
  ts: RegExp;
  sql: RegExp;
}> = [
  {
    what: "creates the fleet role when it is absent",
    ts: /CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS/,
    sql: /CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS/,
  },
  {
    what: "derives the fleet role's name from the database",
    // The TypeScript derives it by IMPORTING the shared expression rather than repeating it, which
    // is the arrangement `@/lib/tenancy/fleet-role` documents and a test there holds to the
    // function's own answer. What this fence asks is that it does not grow a second spelling.
    ts: /FLEET_ROLE_EXPR/,
    sql: /fazerai_fleet_'\s*\n?\s*\|\|\s*left\(regexp_replace\(current_database\(\)/s,
  },
  {
    what: "grants it to the runtime role WITHOUT inheriting",
    ts: /GRANT \$\{fleet\} TO \$\{ident\} WITH INHERIT FALSE, SET TRUE/,
    sql: /GRANT %I TO %I WITH INHERIT FALSE, SET TRUE/,
  },
  {
    what: "grants it to the administrator too, for data migrations",
    ts: /GRANT \$\{fleet\} TO CURRENT_USER/,
    sql: /GRANT %I TO CURRENT_USER/,
  },
  {
    what: "refuses an INHERITING membership",
    ts: /INHERITS/,
    sql: /INHERITS/,
  },
  {
    // NOTE: The half that covers the FIRST boot: the grant below is skipped there because the migration
    // has not created the function yet, and on an install that revoked PUBLIC's default the function
    // would then carry nothing. ALTER DEFAULT PRIVILEGES is scoped to the role that runs it, the same
    // role that creates the function one step later, so it reaches forward.
    what: "sets a DEFAULT privilege so the resolver is executable when it is created",
    ts: /ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO \$\{ident\}/,
    sql: /ALTER DEFAULT PRIVILEGES IN SCHEMA public'\s*\n?\s*' GRANT EXECUTE ON FUNCTIONS TO %I/,
  },
  {
    // Functions carry EXECUTE for PUBLIC by default, so this is a no-op on an ordinary install and
    // the whole difference on one that revoked it — asSuperAdmin calls the resolver every time.
    what: "grants EXECUTE on the resolver to the runtime role",
    ts: /GRANT EXECUTE ON FUNCTION public\.fazerai_fleet_role\(\) TO \$\{ident\}/,
    sql: /GRANT EXECUTE ON FUNCTION public\.fazerai_fleet_role\(\) TO %I/,
  },
  {
    what: "refuses a runtime role that cannot SET ROLE into it",
    ts: /cannot SET ROLE to/,
    sql: /cannot SET ROLE to/,
  },
  {
    what: "asks for the SET capability, not mere membership, on 16+",
    ts: /pg_has_role\(\$1, \$2, 'SET'\)/,
    sql: /THEN 'SET' ELSE 'MEMBER' END/,
  },
  {
    what: "refuses a pre-existing fleet role that is privileged",
    ts: /already exists and is privileged/,
    sql: /already exists and is privileged/,
  },
  {
    // Every attribute that outlives a SET ROLE, not just the two that defeat RLS.
    what: "refuses CREATEDB, CREATEROLE and REPLICATION as well",
    ts: /"CREATEDB"[\s\S]{0,120}"CREATEROLE"[\s\S]{0,120}"REPLICATION"/,
    sql: /'CREATEDB'[\s\S]{0,200}'CREATEROLE'[\s\S]{0,200}'REPLICATION'/,
  },
  {
    // NOTE: PL/pgSQL's RAISE knows only `%`, so an identifier it prints has to be quoted in the
    // ARGUMENT: `%I` there emits the value followed by a literal `I` and quotes nothing.
    what: "quotes identifiers it PRINTS, in the argument rather than the format string",
    ts: /quote_ident\(\$1::text\)/,
    sql: /quote_ident\(v_fleet\), quote_ident\(v_fleet\)/,
  },
  {
    what: "quotes catalog role names through the server, not by hand",
    ts: /format\('REVOKE %I FROM %I CASCADE'/,
    sql: /format\('REVOKE %I FROM %I CASCADE'/,
  },
  {
    what: "reconciles memberships this database did not grant",
    // Anchored on the QUERY rather than on the prose around it: the reconcile is "every member of
    // the fleet role that is neither this database's runtime role nor the administrator", and that
    // predicate is the thing that must exist in both, however each file words its message.
    ts: /pg_auth_members[\s\S]{0,400}?r\.rolname <> current_user/,
    sql: /pg_auth_members[\s\S]{0,400}?r\.rolname <> current_user/,
  },
  {
    what: "re-reads after revoking, because a non-grantor REVOKE is a silent no-op",
    ts: /still a member of/,
    sql: /are still members of/,
  },
  {
    // A stray with an OPEN SESSION is the OUTGOING role of a rotation, which docs/deploy.md promises
    // stays alive through the transfer. Cutting its fleet access mid-deploy takes that away.
    what: "leaves alone a stray that still has a session in this database",
    ts: /pg_stat_activity[\s\S]{0,200}?a\.usename = r\.rolname/,
    sql: /pg_stat_activity[\s\S]{0,200}?a\.usename = r\.rolname/,
  },
  {
    // NOTE: And the session is only HALF of it. A stale installation whose database was dropped and
    // recreated under the same name reconnects with the same open session as a rotation, so the
    // exemption is DECLARED by the operator and the session only bounds it. Reachability is asked with
    // the SAME attribute set the direct list refuses, minus LOGIN (it does not survive a SET ROLE):
    // asking only about the two that defeat RLS calls a fleet role that can become CREATEROLE
    // unprivileged, and the runtime role could mint a cluster role through it.
    what: "counts CREATEDB, CREATEROLE and REPLICATION as reachable privilege too",
    // By the CONSTANT on this side, because the columns live in the shared module the two callers
    // import — which is the arrangement, not a gap. The test below holds that module to them.
    ts: /privilegedReachSql\("r\.oid", undefined, OUTLIVES_SET_ROLE\)/,
    sql: /rolcreatedb[\s\S]{0,120}?rolcreaterole[\s\S]{0,120}?rolreplication\)[\s\S]{0,200}?pg_has_role/,
  },
  {
    what: "keeps a serving stray only where the operator DECLARED it",
    ts: /retained\.has\(r\.rolname\)/,
    sql: /r\.rolname = ANY \(v_retained\)/,
  },
  {
    // NOTE: A `fleet_super_admin` policy naming SOMEONE ELSE's fleet role is what a restore or a clone
    // under a different name leaves behind, and through it the source installation's runtime role
    // reads every row of the restored one.
    what: "revokes the privileges of a FOREIGN fleet role named by the policies here",
    ts: /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I/,
    sql: /REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I/,
  },
  {
    // Only names the derivation itself could have produced are candidates, so an operator role that
    // happens to appear in a policy is never one.
    what: "considers only names matching the fleet-role prefix",
    ts: /LIKE 'fazerai\\\\_fleet\\\\_%'/,
    sql: /LIKE 'fazerai\\_fleet\\_%'/,
  },
  {
    // NOTE: The foreign role's CLUSTER-WIDE membership is deliberately untouched: it belongs to a
    // source installation still running on its own database, and revoking it from here would break it.
    what: "says it leaves the foreign role's cluster-wide membership alone",
    ts: /cluster-wide membership is[\s\S]{0,40}?deliberately untouched/,
    sql: /cluster-wide[\s\S]{0,200}?left\s*\n?--\s*alone on purpose/,
  },
  {
    // NOTE: Severity, not just presence: one file raising and the other warning past a membership that
    // can read every tenant is the divergence to catch, and a fence that only asks whether both mention
    // the state passes it.
    what: "REFUSES a membership it could not clear, rather than warning past it",
    ts: /if \(after\.length > 0\) \{[\s\S]{0,600}?throw new Error\(/,
    sql: /IF v_left IS NOT NULL THEN[\s\S]{0,200}?RAISE EXCEPTION/,
  },
];

const reach = await Bun.file(
  new URL("../../src/lib/tenancy/privileged-reach.ts", import.meta.url)
    .pathname,
).text();
const ts = await Bun.file(
  new URL("../../scripts/db-bootstrap.ts", import.meta.url).pathname,
).text();
const sql = await Bun.file(
  new URL("../../scripts/db-bootstrap.sql", import.meta.url).pathname,
).text();

// PL/pgSQL's `RAISE` knows only `%`. `%I` there is not an identifier placeholder: it emits the value
// followed by a literal `I` and quotes nothing (`DROP ROLE some_roleI;`, which the operator cannot
// run). It reads exactly like the `format()` spelling one line away, so it is easy to miss.
const migration = await Bun.file(
  new URL(
    "../../prisma/migrations/20260827000000_rls_split_tenant_and_fleet_policies/migration.sql",
    import.meta.url,
  ).pathname,
).text();
const FILES = [
  ["scripts/db-bootstrap.sql", sql],
  [
    "prisma/migrations/20260827000000_rls_split_tenant_and_fleet_policies/migration.sql",
    migration,
  ],
] as const;

describe("no RAISE prints an identifier through %I", () => {
  function raisesWithFormatI(source: string): string[] {
    const stripped = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    return [
      ...stripped.matchAll(/RAISE\s+(?:EXCEPTION|NOTICE|WARNING)([\s\S]*?);/g),
    ]
      .map((m) => m[1] as string)
      .filter((body) => body.includes("%I"));
  }

  test("neither file does", () => {
    for (const [name, source] of FILES) {
      expect([name, ...raisesWithFormatI(source)]).toEqual([name]);
    }
  });

  // The positive control: the predicate must reject the spelling it exists for, and accept the one
  // beside it — `format()` DOES take `%I`, and this must not flag that.
  test("the predicate tells RAISE from format", () => {
    expect(
      raisesWithFormatI("RAISE EXCEPTION 'drop %I;', v_role;"),
    ).toHaveLength(1);
    expect(
      raisesWithFormatI("RAISE EXCEPTION 'drop %;', quote_ident(v_role);"),
    ).toHaveLength(0);
    expect(
      raisesWithFormatI("EXECUTE format('DROP ROLE %I', v_role);"),
    ).toHaveLength(0);
  });
});

// The columns the invariant above names by constant. Kept here rather than inlined into the pattern
// pair, because only one of the twins has a module to import from and a fence that pretended
// otherwise would be asking the `.ts` about text that is correctly not in it.
describe("the reachable-privilege set matches the direct one", () => {
  const definition = reach.slice(
    reach.indexOf("export const OUTLIVES_SET_ROLE"),
  );

  test("it carries every attribute that survives a SET ROLE", () => {
    for (const column of [
      "rolsuper",
      "rolbypassrls",
      "rolcreatedb",
      "rolcreaterole",
      "rolreplication",
    ]) {
      expect([column, definition.includes(column)]).toEqual([column, true]);
    }
  });

  // And NOT the one that does not: a session is already open by the time a SET ROLE happens, so
  // LOGIN is refused directly on the fleet role and is meaningless on a role it can become.
  test("and not LOGIN, which does not", () => {
    expect(definition.split(";")[0]).not.toContain("rolcanlogin");
  });

  // The boot guard's set stays narrower on purpose: it refuses to SERVE when RLS is a no-op, and
  // CREATEDB does not make it one. A single shared set would newly refuse installs that work.
  test("the guard's set stays the RLS pair", () => {
    const rls = reach.slice(
      reach.indexOf("export const RLS_DEFEATING"),
      reach.indexOf("export const OUTLIVES_SET_ROLE"),
    );
    expect(rls).toContain("rolsuper");
    expect(rls).toContain("rolbypassrls");
    expect(rls).not.toContain("rolcreatedb");
  });
});

// The repair has to OUTLIVE the refusal: in one DO block the RAISE rolls the revoke back with it.
// At psql's top level each statement is its own transaction, so the two stay two blocks.
describe("the foreign-fleet repair survives the refusal", () => {
  // Top-level `DO $$ ... $$;` blocks. The script has no nested dollar-quoting, so splitting on the
  // terminator is exact; a future nested `$tag$` would break this loudly rather than quietly.
  const blocks = [...sql.matchAll(/DO \$\$([\s\S]*?)\$\$;/g)].map(
    (m) => m[1] as string,
  );

  test("the block that revokes does not also raise", () => {
    const repairing = blocks.filter((b) =>
      b.includes("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I"),
    );
    expect(repairing).toHaveLength(1);
    expect(repairing[0]).not.toContain("RAISE EXCEPTION");
  });

  // NOTE: And it comes after the block that CREATES this database's fleet role: the statement the
  // refusal prints names that role, so raised any earlier the script would abort before provisioning
  // it and pasting the repair would answer `role … does not exist`. At the end, the same paste
  // rewrites every policy to the name the copy derives.
  test("the refusal comes after both the repair and the provisioning", () => {
    const refusing = blocks.filter(
      (b) =>
        b.includes("RAISE EXCEPTION") &&
        b.includes("carries fleet_super_admin policies naming"),
    );
    expect(refusing).toHaveLength(1);
    const at = blocks.indexOf(refusing[0] as string);
    expect(at).toBeGreaterThan(
      blocks.findIndex((b) =>
        b.includes("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I"),
      ),
    );
    expect(at).toBeGreaterThan(
      blocks.findIndex((b) =>
        b.includes("CREATE ROLE %I NOLOGIN NOSUPERUSER NOBYPASSRLS"),
      ),
    );
    // It is the LAST block, so a statement added later cannot land between the provisioning and the
    // refusal and be skipped on every restored database without anyone noticing.
    expect(at).toBe(blocks.length - 1);
  });

  // The TypeScript twin reaches the same place by a different route: it runs in autocommit, so its
  // revokes are already durable, and it must NOT throw — db-guard refuses at runtime on this exact
  // condition, ahead of every override.
  test("the TypeScript reports rather than throwing", () => {
    const fn = ts.slice(
      ts.indexOf("async function revokeForeignFleetAccess"),
      ts.indexOf("async function provisionFleetRole"),
    );
    expect(fn).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I");
    expect(fn).not.toContain("throw new Error");
  });
});

describe("db-bootstrap.ts and db-bootstrap.sql provision the same thing", () => {
  test("every invariant appears in both", () => {
    const missing = INVARIANTS.flatMap(({ what, ts: t, sql: q }) => [
      ...(t.test(ts) ? [] : [`db-bootstrap.ts: ${what}`]),
      ...(q.test(sql) ? [] : [`db-bootstrap.sql: ${what}`]),
    ]);
    expect(missing).toEqual([]);
  });

  // The positive control. A list of patterns that match nothing would pass the test above whatever
  // the files say, so each side is asked about a construct that must NOT be there.
  test("the patterns can fail", () => {
    expect(INVARIANTS.length).toBeGreaterThan(5);
    expect(/GRANT %I TO %I WITH INHERIT FALSE, SET TRUE/.test(ts)).toBe(false);
    expect(/GRANT \$\{fleet\} TO \$\{ident\}/.test(sql)).toBe(false);
    // And a construct neither carries: the fixed role name this design replaced.
    expect(/fazerai_fleet['"`\s]*;/.test(ts)).toBe(false);
    expect(/TO fazerai_fleet\b/.test(sql)).toBe(false);
  });
});
