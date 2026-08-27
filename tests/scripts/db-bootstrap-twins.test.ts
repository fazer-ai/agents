import { describe, expect, test } from "bun:test";

// `scripts/db-bootstrap.ts` and `scripts/db-bootstrap.sql` provision the same thing by two routes:
// the first runs unattended on every container boot, the second is the by-hand psql equivalent for a
// bare Postgres (both say so in their headers). They are the same question asked in two places, and
// that is the shape that goes stale — measured: the membership RECONCILE was added to the TypeScript
// and not to the SQL, so the documented manual path went on leaving a recreated database readable by
// the previous installation's runtime role. Nothing was red, because the `.sql` has no test at all.
//
// This is the cheapest fence that would have caught it. It cannot execute the psql script (the
// `\set` / `:'var'` syntax is a psql feature, not SQL), so it asks whether each file CONTAINS the
// construct for each invariant. A rename breaks it loudly, which is the failure mode to want here.

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
    // PL/pgSQL's RAISE knows only `%`, so an identifier it prints has to be quoted in the ARGUMENT.
    // Measured: `%I` there emits the value followed by a literal `I` and quotes nothing.
    what: "quotes identifiers it PRINTS, in the argument rather than the format string",
    ts: /quote_ident\(\$1::text\)/,
    sql: /quote_ident\(v_fleet\), quote_ident\(v_fleet\)/,
  },
  {
    what: "quotes catalog role names through the server, not by hand",
    ts: /format\('REVOKE %I FROM %I'/,
    sql: /format\('REVOKE %I FROM %I'/,
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
    ts: /is still a member/,
    sql: /are still members of/,
  },
];

const ts = await Bun.file(
  new URL("../../scripts/db-bootstrap.ts", import.meta.url).pathname,
).text();
const sql = await Bun.file(
  new URL("../../scripts/db-bootstrap.sql", import.meta.url).pathname,
).text();

// PL/pgSQL's `RAISE` knows only `%`. `%I` there is not an identifier placeholder: it emits the value
// followed by a literal `I` and quotes nothing — measured as `DROP ROLE some_roleI;`, a statement the
// operator it was written for cannot run. It reads exactly like the `format()` spelling one line
// away, which is why it survived a review round and appeared TWICE in one file.
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
