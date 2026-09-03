import { expect, test } from "bun:test";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";

// A native name is reserved at assembly (#457), refused at write time and renamed on import — none
// of which reaches a row a tenant wrote BEFORE the name was native. That row sits in the console
// and never reaches the model, so a name added to NATIVE_TOOL_NAMES ships with a migration that
// renames such rows (PR #485, round 15: `run_code`, and the thirteen names #457 reserved without
// one). The migration's list is a snapshot by nature, so this asks that the union of every such
// migration covers the catalog: a fifteenth name without its migration is red here, not in a
// tenant's toolset.
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
