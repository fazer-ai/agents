import { expect, test } from "bun:test";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";

// A native name is reserved at assembly, refused at write time and renamed on import, none of which
// reaches a row a tenant wrote before the name was native: that row sits in the console and never
// reaches the model. So every name in NATIVE_TOOL_NAMES needs a migration that renames such rows,
// and since each migration's list is a snapshot, this asks that their union covers the catalog.
test("every native tool name is renamed off existing HTTP tools by a migration", async () => {
  const listed = new Set<string>();
  for await (const entry of new Bun.Glob(
    "*_rename_http_tools_named_after_natives/migration.sql",
  ).scan({ cwd: "prisma/migrations" })) {
    const sql = await Bun.file(`prisma/migrations/${entry}`).text();
    for (const m of sql.matchAll(/'([a-z][a-z0-9_]*)'/g))
      listed.add(m[1] as string);
  }
  expect(NATIVE_TOOL_NAMES.filter((n) => !listed.has(n))).toEqual([]);
});

// The migration that moves the name in a tenant's own settings cannot be rolled: `migrate deploy`
// runs with the old container still serving (docs/deploy.md), which reads the precondition under the
// old name, so a fenced `assign_label` runs unfenced until that process exits. Pinned as prose,
// because the instruction is prose.
test("the rename migration is declared stop-migrate-start", async () => {
  const deploy = await Bun.file("docs/deploy.md").text();
  const at = deploy.indexOf(
    "20260909120000_rename_http_tools_named_after_natives",
  );
  expect(at).toBeGreaterThan(-1);
  const note = deploy.slice(at, at + 1600);
  expect(note).toContain("stop the old process");
  expect(note).toContain("UNFENCED");
  const sql = await Bun.file(
    "prisma/migrations/20260909120000_rename_http_tools_named_after_natives/migration.sql",
  ).text();
  expect(sql).toContain("STOP-MIGRATE-START");
});
