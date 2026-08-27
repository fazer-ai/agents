import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// `mock.module` is process-global and PERMANENT. It has no file scope, no automatic teardown, and
// nothing in the runner puts the real module back: whatever the last call installed is what every
// file that runs afterwards imports, for the rest of the process.
//
// For a `@/`-prefixed target that is survivable — the module is ours, a later file that cares
// re-mocks it, and the blast radius is a directory we own. For a THIRD-PARTY package it is not:
// nobody downstream knows the package was replaced, the stub is written for one caller's needs, and
// a `mockReset()` on one of its functions leaves that function RETURNING UNDEFINED rather than
// throwing. Code that reads a property off the result then dies with a TypeError, and its own catch
// reports that as an ordinary invalid input.
//
// Measured on 2026-08-27 (issue #420): `mock.module("jose", …)` in one auth test left `jwtVerify`
// returning `undefined` for the 6 files that ran after it. Every session cookie became a 401, and
// the failure named the cookie. It cost ten CI runs to find, because the suite is the only place
// the process is long enough for the leak to reach anything, and because each layer between the
// stub and the assertion translated the fault into its own vocabulary.
//
// So: a third-party mock must put the real module back when the file is done. This sweep is the
// only thing that can enforce it, because the damage never appears in the file that causes it.

const BARE_PACKAGE_MOCK = /mock\.module\(\s*"([^"@/][^"]*|@[^/"]+\/[^"]+)"/g;

// Files that mock a third-party package and are ALLOWED not to restore it, each with the reason.
// A waiver covers one file; a new one belongs in `afterAll`, not here.
const NO_RESTORE_WAIVED: Record<string, string> = {
  "client/components/TenantDeepLink.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/components/UserMenu.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/DashboardFirstResponse.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/KnowledgeApprovals.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/KnowledgeDocsBlock.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/LogsGroupTitle.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/LogsScopeChip.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/SetupPage.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/VaultFillDeepLink.test.tsx":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
};

function testFiles(): string[] {
  return [...new Glob("**/*.test.{ts,tsx}").scanSync("tests")].sort();
}

function restoresInAfterAll(source: string): boolean {
  // The restore has to be INSIDE a teardown hook: a bare `mock.module` at the end of the file runs
  // at import time, before a single test of that file has executed.
  const hooks = source.matchAll(
    /after(?:All|Each)\(\s*(?:async\s*)?\(\)\s*=>\s*\{/g,
  );
  for (const hook of hooks) {
    const from = hook.index + hook[0].length;
    let depth = 1;
    let i = from;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
      i++;
    }
    if (source.slice(from, i).includes("mock.module")) return true;
  }
  return false;
}

describe("a third-party module mock is put back", () => {
  const offenders: string[] = [];
  const mockers: string[] = [];

  test("every file that mocks a package restores it when it is done", async () => {
    for (const rel of testFiles()) {
      const source = await Bun.file(`tests/${rel}`).text();
      const targets = [...source.matchAll(BARE_PACKAGE_MOCK)].map((m) => m[1]);
      if (targets.length === 0) continue;
      mockers.push(rel);
      if (restoresInAfterAll(source)) continue;
      if (rel in NO_RESTORE_WAIVED) continue;
      offenders.push(`${rel} → ${[...new Set(targets)].join(", ")}`);
    }

    expect(
      offenders,
      "These test files replace a third-party module for the WHOLE process and never put it back. " +
        'Capture the real module first (`const real = await import("pkg")`), spread it into the ' +
        "stub so the parts you did not stub still work, and restore it in `afterAll`. See " +
        "tests/api/features/auth/google.service.test.ts.",
    ).toEqual([]);
    // The sweep is worth nothing if it stops finding the calls it is meant to police.
    expect(mockers.length).toBeGreaterThan(0);
  });

  test("the no-restore ledger may only shrink", () => {
    expectWaiverLedger("NO_RESTORE_WAIVED", NO_RESTORE_WAIVED, 9);
  });

  describe("the sweep reads what it claims to read", () => {
    test("a bare package name is a mock this rule covers", () => {
      const hits = [
        ...`mock.module("jose", () => ({}))`.matchAll(BARE_PACKAGE_MOCK),
      ];
      expect(hits.map((h) => h[1])).toEqual(["jose"]);
    });

    test("a scoped package is covered too", () => {
      const hits = [
        ...`mock.module("@elysiajs/jwt", () => ({}))`.matchAll(
          BARE_PACKAGE_MOCK,
        ),
      ];
      expect(hits.map((h) => h[1])).toEqual(["@elysiajs/jwt"]);
    });

    test("a `@/` path is ours, and out of scope", () => {
      const hits = [
        ...`mock.module("@/api/lib/prisma", () => ({}))`.matchAll(
          BARE_PACKAGE_MOCK,
        ),
      ];
      expect(hits).toEqual([]);
    });

    test("a restore at file top level does not count as a restore", () => {
      expect(restoresInAfterAll(`mock.module("jose", () => real);\n`)).toBe(
        false,
      );
    });

    test("a restore inside afterAll counts", () => {
      expect(
        restoresInAfterAll(
          `afterAll(() => {\n  mock.module("jose", () => real);\n});\n`,
        ),
      ).toBe(true);
    });

    test("a nested brace does not end the hook early", () => {
      expect(
        restoresInAfterAll(
          `afterAll(() => {\n  if (x) { cleanup(); }\n  mock.module("jose", () => real);\n});\n`,
        ),
      ).toBe(true);
    });
  });
});
