import { expect, test } from "bun:test";
import { Glob } from "bun";

// A module mock lasts for the rest of the worker, so a stub of one of our client contexts written
// for one file is what the next file imports, and a page rendered under the real provider reads the
// stub's role. Tests replace these hooks per file with `stubExports` (tests/utils/module-stub.ts).
const CONTEXTS =
  /mock\.module\(\s*["']@\/client\/(contexts\/(AuthContext|ThemeContext)|hooks\/useTenantEvents)["']/;

test("no test mocks a client context or the tenant events hook with mock.module", async () => {
  const offenders: string[] = [];
  for await (const path of new Glob("tests/**/*.{ts,tsx}").scan(".")) {
    if (path === "tests/lib/auth-mock-sweep.test.ts") continue;
    if (CONTEXTS.test(await Bun.file(path).text())) offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
