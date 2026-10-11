import { expect, test } from "bun:test";
import { Glob } from "bun";

// A mock of the auth context lasts for the rest of the worker, so one that returns only the exports
// its own file needs breaks the next file that imports another one. Every mock of it goes through
// `mockAuthContext` (tests/utils/auth-mock.ts), which keeps the real exports it does not replace.
test("no test mocks the auth context except through mockAuthContext", async () => {
  const offenders: string[] = [];
  for await (const path of new Glob("tests/**/*.{ts,tsx}").scan(".")) {
    if (path === "tests/utils/auth-mock.ts") continue;
    if (path === "tests/lib/auth-mock-sweep.test.ts") continue;
    const src = await Bun.file(path).text();
    if (/mock\.module\(\s*["']@\/client\/contexts\/AuthContext["']/.test(src))
      offenders.push(path);
  }
  expect(offenders).toEqual([]);
});
