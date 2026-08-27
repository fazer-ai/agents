import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// The spelling this API is not allowed to write again.
//
// `src/lib/db-id.ts` has named `BigInt(params.id)` as the one to avoid since it was written, and the
// count when this fence was added was ONE HUNDRED sites across eighteen controllers. A rule stated in
// a header is a rule the next route inherits only if its author reads that header; this file is the
// half that does not depend on their reading it.
//
// It is a source sweep and not a request sweep on purpose. The behaviour is covered over the real
// route table in tests/api/v1/route-id-refusal.test.ts, and that file can only reach routes it can
// call: a POST whose body is required, or a route added tomorrow, is invisible to it. What a route
// WROTE is visible here the moment it is written. Issue #371.
const OFFENDING = /BigInt\(\s*params\./;

const sources = async (): Promise<string[]> => {
  const glob = new Glob("**/*.ts");
  const out: string[] = [];
  for await (const file of glob.scan({ cwd: "src/api" })) out.push(file);
  return out.sort();
};

describe("a route parameter is parsed, not cast", () => {
  test("no controller casts a path parameter with BigInt", async () => {
    const offenders: string[] = [];
    for (const file of await sources()) {
      const text = await Bun.file(`src/api/${file}`).text();
      text.split("\n").forEach((line, i) => {
        if (OFFENDING.test(line)) offenders.push(`src/api/${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  // The sweep above is worth nothing if it reads no files, and a wrong cwd or a moved directory is
  // exactly how that happens silently.
  test("the sweep reads the controllers", async () => {
    const files = await sources();
    expect(files.length).toBeGreaterThanOrEqual(30);
    expect(files).toContain("v1/agents.controller.ts");
  });

  // The control: the pattern above has to actually match the spelling it forbids, or the sweep is
  // green because it matches nothing.
  test("the pattern matches the spelling it forbids", () => {
    expect(OFFENDING.test("        BigInt(params.id),")).toBe(true);
    expect(OFFENDING.test("BigInt( params.mediaId )")).toBe(true);
    expect(OFFENDING.test("requireDbId(params.id)")).toBe(false);
    expect(OFFENDING.test("BigInt(query.tenantId)")).toBe(false);
  });
});
