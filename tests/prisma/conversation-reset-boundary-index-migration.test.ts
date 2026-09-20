import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// THE INDEX THE THREAD'S RESET BOUNDARY READS (issue #718, PR review round 2), and the assertion that
// says it actually landed.
//
// `threadResetBoundary` asks, for one thread, what the newest `reset_at_message_id` on it is, and it
// runs on every ingest job with the `ingest:<thread>` lock held. The mark lives on conversation rows
// and a thread can hold several, so the lookup is keyed by contact inbox — a shape no index on the
// table served: the unique leads with the same two columns but its third is the conversation id, so
// the prefix narrows to the instance and then rechecks every row of it.
//
// DDL is invisible to every behavioural test in the suite: an index changes no result. Both halves
// are read here, the FILE for what the statement says and the CATALOG for what a database built from
// it holds — and the catalog half is the one that catches an interrupted `CONCURRENTLY`, which leaves
// an index Postgres refuses to use WITHOUT SAYING SO while the migration records as applied.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const INDEX =
  "prisma/migrations/20260919150000_conversation_thread_reset_boundary_idx/migration.sql";
const ASSERT =
  "prisma/migrations/20260919150001_assert_conversation_indexes_valid/migration.sql";
const IDX_NAME =
  "conversations_tenant_id_chatwoot_instance_id_contact_inbox__idx";

let dbUp = false;
let indexSql = "";
let assertSql = "";
let schemaSql = "";
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    indexSql = await Bun.file(INDEX).text();
    assertSql = await Bun.file(ASSERT).text();
    schemaSql = await Bun.file("prisma/schema.prisma").text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

describe.skipIf(!dbUp)("migration: the thread reset boundary index", () => {
  test("builds CONCURRENTLY and can be run again after one fails", () => {
    const creates = [
      ...indexSql.matchAll(/CREATE INDEX(\s+CONCURRENTLY)?\s+"([^"]+)"/g),
    ];
    expect(creates.map((m) => m[2])).toEqual([IDX_NAME]);
    // The lock is the whole reason: a plain build holds SHARE, which blocks INSERT on a table the
    // previous release is still writing on every webhook it receives.
    expect(creates[0]?.[1]?.trim()).toBe("CONCURRENTLY");
    // A failed concurrent build leaves an INVALID index: never used for a query, still maintained on
    // every write, and a bare re-run collides with the name. The DROP is what makes the file
    // re-runnable, and it has to name the same index.
    expect(indexSql).toContain(`DROP INDEX IF EXISTS "${IDX_NAME}";`);
    expect(indexSql).toContain(
      '("tenant_id", "chatwoot_instance_id", "contact_inbox_id")',
    );
    // No name may be long enough for Postgres to shorten it on the way in: a shortened name and the
    // DROP above would stop naming the same thing. This one is already AT the limit, because Prisma's
    // own truncation produced it.
    expect(new TextEncoder().encode(IDX_NAME).length).toBeLessThanOrEqual(63);
  });

  test("the schema declares it, so the next migrate dev does not rename it", () => {
    // Not partial, so unlike the sibling index this one CAN live in schema.prisma — and it has to,
    // or `migrate dev` sees an index the datamodel does not declare and proposes dropping it. The
    // name above is the one Prisma's convention generates for this `@@index`, truncated to 63 the
    // same way `agent_threads_tenant_id_chatwoot_instance_id_contact_inbox__key` is.
    const model = /model Conversation \{[\s\S]*?\n\}/.exec(schemaSql)?.[0];
    expect(model).toBeDefined();
    expect(model).toContain(
      "@@index([tenantId, chatwootInstanceId, contactInboxId])",
    );
    expect(indexSql).not.toContain("WHERE");
  });

  test("a following migration asserts the catalog, in a file of its own", () => {
    // `.claude/rules/prisma.md` asks for exactly this after a concurrent build, and it has to be a
    // SEPARATE file: a `DO $$` block puts the migration in an implicit transaction, which the
    // `CREATE INDEX CONCURRENTLY` it is checking cannot share.
    // Asked of the STATEMENTS, not of the prose: the comment above them names the very thing they
    // are checking for.
    const statements = assertSql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/CREATE INDEX\s+CONCURRENTLY/i);
    expect(assertSql).toContain("indisvalid");
    expect(assertSql).toContain("conversations");
    expect(assertSql).toContain("RAISE EXCEPTION");
    // Asked of the whole table, not of the one index this PR adds: a later concurrent build here is
    // covered without anyone remembering to extend the file.
    expect(indexSql).not.toContain("indisvalid");
  });

  test("the catalog holds it, valid and over the three columns", async () => {
    const r = await suDb.query<{ def: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [IDX_NAME],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.valid).toBe(true);
    // The ORDER is the point, not the membership: `contact_inbox_id` last is what makes the two
    // leading columns a usable prefix for everything else that scopes by instance.
    expect(r.rows[0]?.def).toContain(
      "btree (tenant_id, chatwoot_instance_id, contact_inbox_id)",
    );
    // ...and nothing on this table is invalid, which is what the assertion migration enforces on a
    // real deploy and what this proves it is enforcing here.
    const dead = await suDb.query<{ n: string }>(
      `SELECT c.relname AS n
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'conversations' AND NOT i.indisvalid`,
    );
    expect(dead.rows.map((x) => x.n)).toEqual([]);
  });
});
