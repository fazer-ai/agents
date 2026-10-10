// The recovery message of a migration that raises tells the operator to `prisma migrate resolve
// --rolled-back <name>`. Each such file is copied from an older one, so the name it carries has to be
// its own: resolving another migration leaves this one FAILED and the next deploy stops on P3009.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "../../prisma/migrations");

describe("migration recovery messages", () => {
  const named = readdirSync(DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => ({
      name: d.name,
      sql: readFileSync(join(DIR, d.name, "migration.sql"), "utf8"),
    }))
    .filter((m) => /--rolled-back \d{14}_/.test(m.sql));

  test("there are messages to check", () => {
    expect(named.length).toBeGreaterThan(0);
  });

  test.each(named.map((m) => [m.name, m.sql] as const))(
    "%s resolves itself",
    (name, sql) => {
      const targets = [...sql.matchAll(/--rolled-back (\d{14}_\w+)/g)].map(
        (m) => m[1],
      );
      expect(new Set(targets)).toEqual(new Set([name]));
    },
  );
});
