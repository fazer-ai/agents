import { describe, expect, test } from "bun:test";

// `conversation_readings` can already hold an installation's readings when the canonicals arrive,
// and the migration that adds `canonical_id` holds the column's ACCESS EXCLUSIVE lock for its whole
// transaction. Nothing that scans the table may run inside it: the index is built concurrently in a
// file of its own, and the foreign key is added NOT VALID there and validated in a later file, whose
// SHARE UPDATE EXCLUSIVE lets the observer read and write while the rows are checked.

const DDL =
  "prisma/migrations/20261020150000_occurrence_themes_and_canonicals/migration.sql";
const INDEX =
  "prisma/migrations/20261020150400_conversation_readings_canonical_id_idx/migration.sql";
const VALIDATE =
  "prisma/migrations/20261020150600_validate_conversation_readings_canonical_id_fkey/migration.sql";

const statements = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

describe("migration: the readings' canonical column", () => {
  test("the transaction that adds the column scans nothing of the table", async () => {
    const onReadings = statements(await Bun.file(DDL).text()).filter((s) =>
      s.includes('"conversation_readings"'),
    );
    expect(onReadings.some((s) => s.startsWith("CREATE INDEX"))).toBe(false);
    const fk = onReadings.find((s) =>
      s.includes('"conversation_readings_canonical_id_fkey"'),
    );
    expect(fk).toBeDefined();
    expect(fk).toEndWith("NOT VALID");
  });

  test("the index builds concurrently and the key is validated, each alone in its file", async () => {
    const index = statements(await Bun.file(INDEX).text());
    expect(index.at(-1)).toStartWith("CREATE INDEX CONCURRENTLY");
    expect(statements(await Bun.file(VALIDATE).text())).toEqual([
      'ALTER TABLE "conversation_readings" VALIDATE CONSTRAINT "conversation_readings_canonical_id_fkey"',
    ]);
  });
});
