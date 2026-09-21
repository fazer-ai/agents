import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// THE POOL SIZE HAS A NAME, AND THE PLACES THAT NAME IT ARE THE DELIVERABLE (issue #668).
//
// `DB_POOL_MAX` has existed all along, with an explicit default, wired into both pools. What did not
// exist were the pointers, and the issue is the evidence: it was written by someone who read
// `docs/deploy.md` end to end and came away certain the number was inherited from the host's CPU
// count. Prose is the artefact here the way a function is elsewhere, so it is asserted like one --
// the same reason three tests already read `docs/deploy.md` (see the note at the top of that file).
//
// The third assertion is the one that earns its keep. `connection_limit` is the knob Prisma's own
// documentation sends you to, and in this tree it does NOTHING: the runtime connects through the pg
// driver adapter, so the pool is a `pg` pool sized by `max`. Measured: a pg pool built from a URL
// carrying `?connection_limit=2`, with no `max`, ran three concurrent queries on three distinct
// backends and kept `options.max` at 10. Without that sentence written down, the next person sizes
// the pool with a setting that reads as applied and is not.

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
    expect(note).toContain("max_connections");
    // The failure it prevents is a burst, which is what makes the number hard to reason about from
    // average load, and what made #668's two incidents look like an idle database.
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
    expect(note).toContain("connection_limit");
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
