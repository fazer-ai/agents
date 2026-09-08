import { describe, expect, test } from "bun:test";
import { Client } from "pg";

// THE SIBLING LOOKUP'S SECOND HALF (issue #540, PR review round 9), and the assertion that says it
// actually landed (round 11).
//
// `responderSiblingRemembers` asks what the responder's own delivery of the same message decided. On
// a customer message that is keyed by `inbound_message_id` and served by the retire index; on a
// colleague's reply it is keyed by `human_reply_message_id`, which had no index at all. The case that
// hurts is the ORDINARY one: the fan-out has no order, so the observer's delivery arrives first about
// half the time and the query finds NOTHING — and an absence has to read every candidate row before
// it can be stated, over a ledger nothing prunes.
//
// DDL is invisible to every behavioural test in the suite: an index changes no result. Both halves
// are read here, the FILE for what the statement says and the CATALOG for what a database built from
// it holds — and the catalog half is the one that catches an interrupted `CONCURRENTLY`, which leaves
// an index Postgres refuses to use WITHOUT SAYING SO while the migration records as applied.

const suUrl = process.env.MIGRATION_DATABASE_URL;
const INDEX =
  "prisma/migrations/20260908170004_human_reply_sibling_idx/migration.sql";
const ASSERT =
  "prisma/migrations/20260908170005_assert_delivery_indexes_valid/migration.sql";
const IDX_NAME = "chatwoot_webhook_deliveries_reply_sibling_idx";

let dbUp = false;
let indexSql = "";
let assertSql = "";
let su: Client | undefined;
if (suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    await su.query("SELECT 1");
    indexSql = await Bun.file(INDEX).text();
    assertSql = await Bun.file(ASSERT).text();
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const suDb = su as Client;

describe.skipIf(!dbUp)("migration: the reply sibling index", () => {
  test("builds CONCURRENTLY, partial, and can be run again after one fails", () => {
    const creates = [
      ...indexSql.matchAll(/CREATE INDEX(\s+CONCURRENTLY)?\s+"([^"]+)"/g),
    ];
    expect(creates.map((m) => m[2])).toEqual([IDX_NAME]);
    // The lock is the whole reason: a plain build holds SHARE, which blocks INSERT on a table the
    // previous release is still writing after every 200 it sends.
    expect(creates[0]?.[1]?.trim()).toBe("CONCURRENTLY");
    // A failed concurrent build leaves an INVALID index: never used for a query, still maintained on
    // every write, and a bare re-run collides with the name. The DROP is what makes the file
    // re-runnable, and it has to name the same index.
    expect(indexSql).toContain(`DROP INDEX IF EXISTS "${IDX_NAME}";`);
    // PARTIAL, which is why it lives in raw SQL and not in schema.prisma: the column is null on
    // nearly every row of this table.
    expect(indexSql).toMatch(
      /WHERE\s+"human_reply_message_id"\s+IS\s+NOT\s+NULL/i,
    );
    // ...and account-leading, because message ids are numbered per Chatwoot account.
    expect(indexSql).toContain(
      '("chatwoot_instance_id", "conversation_id", "human_reply_message_id")',
    );
    // No name may be long enough for Postgres to shorten it on the way in: a shortened name and the
    // DROP above would stop naming the same thing.
    expect(new TextEncoder().encode(IDX_NAME).length).toBeLessThanOrEqual(63);
  });

  test("a following migration asserts the catalog, in a file of its own", () => {
    // `.claude/rules/prisma.md` asks for exactly this after a concurrent build, and it has to be a
    // SEPARATE file: a `DO $$` block puts the migration in an implicit transaction, which the
    // `CREATE INDEX CONCURRENTLY` it is checking cannot share.
    // Asked of the STATEMENTS, not of the prose: the comment above them names the very thing they
    // are checking for, and the exception text tells an operator to run `DROP INDEX CONCURRENTLY`.
    const statements = assertSql
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(statements).not.toMatch(/CREATE INDEX\s+CONCURRENTLY/i);
    expect(assertSql).toContain("indisvalid");
    expect(assertSql).toContain("chatwoot_webhook_deliveries");
    expect(assertSql).toContain("RAISE EXCEPTION");
    // Asked of the whole table, not of the one index this PR adds: the two beside it were built
    // concurrently too, and an invalid one there is the same silent outage.
    expect(indexSql).not.toContain("indisvalid");
  });

  test("the catalog holds it, valid and partial", async () => {
    const r = await suDb.query<{ def: string; valid: boolean }>(
      `SELECT pg_get_indexdef(i.indexrelid) AS def, i.indisvalid AS valid
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [IDX_NAME],
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.valid).toBe(true);
    expect(r.rows[0]?.def).toContain("human_reply_message_id");
    expect(r.rows[0]?.def).toMatch(
      /WHERE .*human_reply_message_id IS NOT NULL/,
    );
    // ...and nothing on this table is invalid, which is what the assertion migration enforces on a
    // real deploy and what this proves it is enforcing here.
    const dead = await suDb.query<{ n: string }>(
      `SELECT c.relname AS n
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_class t ON t.oid = i.indrelid
        WHERE t.relname = 'chatwoot_webhook_deliveries' AND NOT i.indisvalid`,
    );
    expect(dead.rows.map((x) => x.n)).toEqual([]);
  });
});
