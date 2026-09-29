import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// `DB_POOL_MAX` sizes both pools, and the places that name it for an operator are asserted like code:
// prose is the artefact here. The third assertion matters most: `connection_limit`, the knob Prisma's
// own documentation points to, does NOTHING in this tree, because the runtime connects through the pg
// driver adapter and the pool is a `pg` pool sized by `max`. Unwritten, it reads as applied and is not.

const deploy = readFileSync("docs/deploy.md", "utf8");
const envExample = readFileSync(".env.example", "utf8");
const tenancy = readFileSync("src/lib/tenancy/multi-tenant.ts", "utf8");

describe("the connection pool is named where an operator looks", () => {
  test("docs/deploy.md carries the setting and the arithmetic", () => {
    const at = deploy.indexOf("`DB_POOL_MAX`");
    expect(at).toBeGreaterThan(-1);
    const note = deploy.slice(at, at + 1600);
    // Both pools, so the ceiling an operator divides is twice it.
    expect(note).toMatch(/twice/i);
    // NOTE: the CEILING, tied to that total. The window also holds a weaker mention ("raise
    // `max_connections` … past ~40"), so asking only whether the word appears passes without it.
    expect(note).toMatch(/total[\s\S]{0,80}max_connections/i);
    // NOTE: the failure it prevents is a burst, which is why the number is hard to reason about from
    // average load and why an exhausted pool can look like an idle database.
    expect(note).toMatch(/burst/i);
  });

  test("docs/deploy.md says connection_limit is not that knob", () => {
    const at = deploy.indexOf("`connection_limit`");
    expect(at).toBeGreaterThan(-1);
    const note = deploy.slice(at, at + 1200);
    expect(note).toMatch(/does nothing|NOT that knob/i);
    // Named with the reason, not as a bare prohibition: the reason is what survives a refactor.
    expect(note).toContain("driver adapter");
  });

  test(".env.example frames the number as a burst budget", () => {
    const at = envExample.indexOf("DB_POOL_MAX=");
    expect(at).toBeGreaterThan(-1);
    // The comment sits ABOVE the assignment, which is this file's convention.
    const note = envExample.slice(Math.max(0, at - 1200), at);
    expect(note).toMatch(/burst/i);
    // NOTE: the CLAIM, not the word: an inverted sentence ("`connection_limit` in the URL is the
    // Prisma equivalent") keeps the word.
    expect(note).toMatch(/connection_limit`?[\s\S]{0,60}does NOT size/i);
  });

  test("the maxWait comment points at the other half of its own equation", () => {
    const at = tenancy.indexOf("SCOPED_TX_OPTIONS");
    expect(at).toBeGreaterThan(-1);
    // The pointer has to be ABOVE the export, where someone arriving from the error message reads.
    const header = tenancy.slice(Math.max(0, at - 2500), at);
    expect(header).toContain("DB_POOL_MAX");
    expect(header).toContain("docs/deploy.md");
  });
});
