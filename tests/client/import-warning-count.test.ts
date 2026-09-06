import { describe, expect, test } from "bun:test";
import { importWarningCount } from "@/client/lib/importWarningCount";

// THE ROLLING-DEPLOY OVERLAP, from the reading side. `docs/deploy.md` promises two live containers
// during a deploy, so an editor loaded from this release can be answered by one from the previous
// release, which sends the count under `n` and not `count` (issue #513 renamed it). Coercing a
// missing `count` straight to a number gives 0, and the sentence then reads "0 bundled documents"
// about a base that skipped one — wrong, quietly, and only during the window nobody tests in.
describe("importWarningCount", () => {
  test("reads the current name", () => {
    expect(importWarningCount({ name: "KB", count: 3 })).toBe(3);
  });

  // The direction that fails silently: this is the previous release's payload.
  test("falls back to the name the previous release sent", () => {
    expect(importWarningCount({ name: "KB", n: 3 })).toBe(3);
  });

  test("prefers the current name when a container sends both", () => {
    expect(importWarningCount({ count: 3, n: 99 })).toBe(3);
  });

  // Zero is a real count and must not be confused with an absent one: both answer 0 here, and the
  // catalogs carry a plural form for it, so the sentence stays grammatical either way.
  test("answers zero for a count that is absent or unreadable", () => {
    expect(importWarningCount(undefined)).toBe(0);
    expect(importWarningCount({ name: "KB" })).toBe(0);
    expect(importWarningCount({ count: "not a number" })).toBe(0);
  });
});
