import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// A sweep, not an example, because the defect it guards is invisible at the line that causes it.
//
// Every route under v1 resolves its tenant from the `X-Tenant-Id` header, and a SUPER_ADMIN's tenant
// exists nowhere else. So a response the browser may STORE is keyed by a URL that does not mention
// the tenant: switch tenants, hit the same URL, and the cache answers with the previous tenant's
// bytes — without the scoped read that fences them ever running. `private` does not help; it only
// keeps shared proxies out, not the one browser that saw both tenants.
//
// The rule is therefore: under v1, a cacheable response declares `Vary: "X-Tenant-Id"`. Stated as a
// sweep so the next byte-serving endpoint gets it for free, rather than as a test of the one route
// that has it today.

const ROOT = new URL("../../../src/api/v1", import.meta.url).pathname;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(full)));
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

// The header block a `new Response(...)` carries, as source text.
function headerBlocks(src: string): string[] {
  return [...src.matchAll(/headers:\s*\{([\s\S]*?)\n\s*\},/g)].map(
    (m) => m[1] ?? "",
  );
}

describe("a cacheable v1 response is keyed by the tenant", () => {
  test("every stored response declares Vary: X-Tenant-Id", async () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of await sourceFiles(ROOT)) {
      const src = await Bun.file(file).text();
      for (const block of headerBlocks(src)) {
        const control = block.match(/"Cache-Control":\s*"([^"]*)"/)?.[1];
        if (!control) continue;
        seen++;
        // Only responses the browser may keep. `no-store` cannot be replayed at all, so switching a
        // route to it is a valid answer to this rule rather than a violation of it.
        if (/no-store/.test(control)) continue;
        if (!/Vary:\s*"X-Tenant-Id"/.test(block)) {
          offenders.push(`${file.slice(ROOT.length + 1)}: ${control}`);
        }
      }
    }
    expect(offenders).toEqual([]);
    // …and the sweep is actually looking at something. Counted over EVERY Cache-Control, not only
    // the cacheable ones: a rule whose subject can legitimately become empty is a rule that starts
    // passing for the wrong reason the day someone switches the last route to `no-store`.
    expect(seen).toBeGreaterThan(0);
  });
});
