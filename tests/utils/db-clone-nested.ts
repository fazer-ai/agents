import { expect, test } from "bun:test";

// The target of the nested run in tests/lib/db-clone.test.ts: prints the database every connection
// URL names after the preload, which is what that test compares with the worker's own copy.
test("reports the databases the preload chose", () => {
  const names = Object.fromEntries(
    [
      "MIGRATION_DATABASE_URL",
      "TEST_MIGRATION_DATABASE_URL",
      "TEST_APP_DATABASE_URL",
      "LANGGRAPH_DATABASE_URL",
    ].map((v) => [v, new URL(process.env[v] as string).pathname.slice(1)]),
  );
  console.log(`NESTED_DBS ${JSON.stringify(names)}`);
  expect(Object.keys(names)).toHaveLength(4);
});
