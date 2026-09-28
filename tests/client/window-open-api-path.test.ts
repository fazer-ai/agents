import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// A sweep, not an example, because the defect it guards is one nobody sees while writing the line.
//
// `window.open("/api/…")` is a plain navigation carrying cookies only, while tenant-scoped routes read
// the tenant from the `X-Tenant-Id` header that the Eden client and `mediaFetch` add. A SUPER_ADMIN has
// no tenant anywhere else, so their tab lands on "a target tenant is required"; a TENANT_ADMIN's comes
// off the session, so it looks right in a developer's browser. Fetch through `mediaFetch` and open
// the blob URL instead; as a sweep, the next byte endpoint is covered too.

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
      // NOTE: the argument as written: a string or template literal starting with /api/. An expression
      // (a variable, a blob URL) is out of reach here and is exactly what the `mediaFetch` pattern produces.
      for (const m of src.matchAll(/window\.open\(\s*[`"']\/api\//g)) {
        const line = src.slice(0, m.index).split("\n").length;
        offenders.push(`${file.slice(ROOT.length + 1)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
