import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// A sweep, not an example, because the defect it guards is one nobody sees while writing the line.
//
// `window.open("/api/…")` is a plain browser navigation: it carries cookies and nothing else. Every
// tenant-scoped route resolves the tenant from the `X-Tenant-Id` header the Eden client and
// `mediaFetch` add, and a SUPER_ADMIN has no tenant anywhere else — so for them the new tab lands on
// "a target tenant is required" instead of the file. It looks right in every developer's own browser,
// because a TENANT_ADMIN's tenant comes off the session.
//
// The fix is always the same: fetch through `mediaFetch` and open the blob URL. The rule is stated
// here as a sweep so the next byte endpoint gets it for free — a per-page test would only ever cover
// the page that already had the bug.

const ROOT = new URL("../../src/client", import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no client code opens a same-origin API path in a new tab", () => {
  test("window.open is never handed an /api/ path", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(ROOT)) {
      const src = await Bun.file(file).text();
      // The argument as written: a string or template literal starting with /api/. An expression
      // (a variable, a blob URL) is out of reach here and is exactly what the fix produces.
      for (const m of src.matchAll(/window\.open\(\s*[`"']\/api\//g)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file.slice(ROOT.length + 1)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
