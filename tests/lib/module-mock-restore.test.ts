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

// FACTORIES, not constants. A `/g` regex carries `lastIndex` between uses, so a shared instance
// makes one call's `matchAll` depend on where the previous one stopped — measured here as three
// unrelated tests failing the moment a `.test()` was added elsewhere in this file.
const barePackageMock = () =>
  /mock\.module\(\s*"([^"@/][^"]*|@[^/"]+\/[^"]+)"/g;
const anyMockTarget = () => /mock\.module\(\s*"([^"]+)"/g;

// The file-and-package pairs that are ALLOWED to go unrestored, each with the reason. Keyed by the
// PAIR, not by the file: a waiver for one package must not cover a second one the same file adds
// later, which is exactly how a waived file becomes a place to hide a new leak.
const NO_RESTORE_WAIVED: Record<string, string> = {
  "client/components/TenantDeepLink.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/components/UserMenu.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/DashboardFirstResponse.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/KnowledgeApprovals.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/KnowledgeDocsBlock.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/LogsGroupTitle.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/LogsScopeChip.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/SetupPage.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
  "client/pages/VaultFillDeepLink.test.tsx → react-i18next":
    "`react-i18next`, and it predates this rule. It has not bitten for a reason that is real but not a guarantee: every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub rather than a component expecting the real hook. The day one of them stops, the failure lands in a file that mocks nothing. Fix by restoring, not by adding a tenth line here.",
};

// This file's own `mock.module(…)` occurrences are FIXTURES for the reader's decision table below,
// not calls. A sweep that reads source text cannot tell one from the other, so it skips itself —
// and the decision table is what covers the reader instead.
const SELF = "lib/module-mock-restore.test.ts";

async function scanTree(): Promise<ScannedFile[]> {
  return Promise.all(
    testFiles().map(async (rel) => ({
      rel,
      source: await Bun.file(`tests/${rel}`).text(),
    })),
  );
}

function testFiles(): string[] {
  return [...new Glob("**/*.test.{ts,tsx}").scanSync("tests")]
    .filter((rel) => rel !== SELF)
    .sort();
}

// The targets a file hands back inside a teardown hook. Names, not a boolean: a file that stubs two
// packages and restores one would satisfy any yes/no answer while leaving the other replaced for the
// whole process, and an unrelated `@/`-path restore in the same hook would satisfy it too.
// The body of the hook that starts at `from`, with braces counted only where they are SYNTAX.
// A `"}"` inside a string or a comment used to close the hook early, which silently turned a real
// restore into a missing one; an unbalanced `"{"` did the reverse. This file's own fixtures are
// full of both, so the reader has to know the difference.
function hookBody(source: string, from: number): string {
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/"))
        i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        // A backslash escapes the next character, quote included, so it cannot end the literal.
        if (source[i] === "\\") i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") depth--;
    i++;
  }
  return source.slice(from, i);
}

// The targets a file hands back inside a teardown hook. Names, not a boolean: a file that stubs two
// packages and restores one would satisfy any yes/no answer while leaving the other replaced for the
// whole process, and an unrelated `@/`-path restore in the same hook would satisfy it too.
function restoredInTeardown(source: string): Set<string> {
  const out = new Set<string>();
  const hooks = source.matchAll(
    /after(?:All|Each)\(\s*(?:async\s*)?\(\)\s*=>\s*\{/g,
  );
  for (const hook of hooks) {
    const body = hookBody(source, hook.index + hook[0].length);
    for (const m of body.matchAll(anyMockTarget())) {
      if (m[1]) out.add(m[1]);
    }
  }
  return out;
}

interface ScannedFile {
  rel: string;
  source: string;
}

// The decision, over supplied files rather than over the tree. Pure so the table below can hand it
// the cases the tree does not currently contain — a file that stubs two packages and restores one,
// a waiver whose file has been fixed — which are exactly the cases a sweep is written to catch and
// the ones the tree can never demonstrate while the sweep is passing.
export interface Unrestored {
  rel: string;
  missing: string[];
}

export function unrestoredIn(files: readonly ScannedFile[]): Unrestored[] {
  const out: Unrestored[] = [];
  for (const { rel, source } of files) {
    const targets = new Set(
      [...source.matchAll(barePackageMock())].map((m) => m[1] as string),
    );
    if (targets.size === 0) continue;
    const restored = restoredInTeardown(source);
    const missing = [...targets].filter((t) => !restored.has(t));
    if (missing.length > 0) out.push({ rel, missing });
  }
  return out;
}

// One key per file-and-package pair, which is the unit a waiver actually covers.
function pairs(found: readonly Unrestored[]): string[] {
  return found.flatMap((o) => o.missing.map((pkg) => `${o.rel} → ${pkg}`));
}

export function unwaived(
  found: readonly Unrestored[],
  waived: Readonly<Record<string, string>>,
): string[] {
  return pairs(found).filter((key) => !(key in waived));
}

export function staleWaivers(
  files: readonly ScannedFile[],
  waived: Readonly<Record<string, string>>,
): string[] {
  const live = new Set(pairs(unrestoredIn(files)));
  return Object.keys(waived).filter((key) => !live.has(key));
}

describe("a third-party module mock is put back", () => {
  test("every file that mocks a package restores it when it is done", async () => {
    const files = await scanTree();
    const offenders = unwaived(unrestoredIn(files), NO_RESTORE_WAIVED);

    expect(
      offenders,
      "These test files replace a third-party module for the WHOLE process and never put it back. " +
        'Capture a PLAIN SNAPSHOT of the real module first (`const real = { ...(await import("pkg")) }` — ' +
        "a live namespace is rewritten in place by the mock), spread it into the stub so the parts you " +
        "did not stub still work, and restore that snapshot in `afterAll`. See " +
        "tests/api/features/auth/google.service.test.ts.",
    ).toEqual([]);
    // The sweep is worth nothing if it stops finding the calls it is meant to police.
    expect(files.some((f) => barePackageMock().test(f.source))).toBe(true);
  });

  // The size pin alone is guarded in one direction only. A waived file that was deleted, or that
  // started restoring its mock, leaves a slot nobody notices: the size still matches, so a NEW
  // offender can take the freed slot and the suite stays green. The ledger is checked against the
  // tree it describes, which is the anchor the size cannot be.
  test("every waiver still names a file that is actually unrestored", async () => {
    expect(
      staleWaivers(await scanTree(), NO_RESTORE_WAIVED),
      "These waivers no longer describe anything: the file was deleted, or it now restores what it " +
        "mocked. Remove them AND lower the pin, or the freed slots absorb the next offender silently.",
    ).toEqual([]);
  });

  test("the no-restore ledger may only shrink", () => {
    expectWaiverLedger("NO_RESTORE_WAIVED", NO_RESTORE_WAIVED, 9);
  });

  // The decision itself, over synthetic files. Everything above measures the tree, which can only
  // ever show the cases that exist in it right now; these are the cases the sweep is FOR.
  describe("the decision, over files it is handed", () => {
    const two =
      'mock.module("jose", () => stub);\nmock.module("react-i18next", () => stub);\n';

    test("a file that stubs nothing third-party is not flagged", () => {
      expect(
        unrestoredIn([
          {
            rel: "a.test.ts",
            source: 'mock.module("@/api/lib/prisma", () => s);',
          },
        ]),
      ).toEqual([]);
    });

    test("a file that stubs a package and restores it is not flagged", () => {
      expect(
        unrestoredIn([
          {
            rel: "a.test.ts",
            source:
              'mock.module("jose", () => stub);\nafterAll(() => {\n  mock.module("jose", () => real);\n});\n',
          },
        ]),
      ).toEqual([]);
    });

    test("a file that stubs a package and never restores it is flagged", () => {
      expect(
        unrestoredIn([
          { rel: "a.test.ts", source: 'mock.module("jose", () => stub);' },
        ]),
      ).toEqual([{ rel: "a.test.ts", missing: ["jose"] }]);
    });

    // Round-1 finding: restoring ONE package used to vouch for the whole file.
    test("stubbing two packages and restoring one flags the other", () => {
      expect(
        unrestoredIn([
          {
            rel: "a.test.ts",
            source: `${two}afterAll(() => {\n  mock.module("jose", () => real);\n});\n`,
          },
        ]),
      ).toEqual([{ rel: "a.test.ts", missing: ["react-i18next"] }]);
    });

    test("restoring one of OUR modules vouches for no package", () => {
      expect(
        unrestoredIn([
          {
            rel: "a.test.ts",
            source:
              'mock.module("jose", () => stub);\nafterAll(() => {\n  mock.module("@/api/lib/prisma", () => real);\n});\n',
          },
        ]),
      ).toEqual([{ rel: "a.test.ts", missing: ["jose"] }]);
    });

    // Round-1 finding: a waiver whose file was fixed or deleted freed a slot silently.
    test("a waiver whose file now restores its mock is stale", () => {
      const fixed = [
        {
          rel: "a.test.ts",
          source:
            'mock.module("jose", () => stub);\nafterAll(() => {\n  mock.module("jose", () => real);\n});\n',
        },
      ];
      expect(staleWaivers(fixed, { "a.test.ts → jose": "why" })).toEqual([
        "a.test.ts → jose",
      ]);
    });

    test("a waiver whose file was deleted is stale", () => {
      expect(staleWaivers([], { "gone.test.ts → jose": "why" })).toEqual([
        "gone.test.ts → jose",
      ]);
    });

    test("a waiver that still describes an unrestored pair is not stale", () => {
      const still = [
        { rel: "a.test.ts", source: 'mock.module("jose", () => stub);' },
      ];
      expect(staleWaivers(still, { "a.test.ts → jose": "why" })).toEqual([]);
    });

    // Round-2 finding: a waived file used to be a place to hide the NEXT leak, because the waiver
    // covered the file rather than the package it was written for.
    test("a waiver for one package does not cover another in the same file", () => {
      const found = [{ rel: "a.test.ts", missing: ["jose", "react-i18next"] }];
      expect(unwaived(found, { "a.test.ts → jose": "why" })).toEqual([
        "a.test.ts → react-i18next",
      ]);
    });

    // A key that names only the file waives nothing. Without this the pair-keying is decorative:
    // an old file-level entry would keep covering everything that file ever adds.
    test("a waiver key that names only the file covers nothing", () => {
      const found = [{ rel: "a.test.ts", missing: ["jose"] }];
      expect(unwaived(found, { "a.test.ts": "why" })).toEqual([
        "a.test.ts → jose",
      ]);
    });

    test("a pair that is waived is not reported", () => {
      const found = [{ rel: "a.test.ts", missing: ["jose"] }];
      expect(unwaived(found, { "a.test.ts → jose": "why" })).toEqual([]);
    });
  });

  describe("the sweep reads what it claims to read", () => {
    test("a bare package name is a mock this rule covers", () => {
      const hits = [
        ...`mock.module("jose", () => ({}))`.matchAll(barePackageMock()),
      ];
      expect(hits.map((h) => h[1])).toEqual(["jose"]);
    });

    test("a scoped package is covered too", () => {
      const hits = [
        ...`mock.module("@elysiajs/jwt", () => ({}))`.matchAll(
          barePackageMock(),
        ),
      ];
      expect(hits.map((h) => h[1])).toEqual(["@elysiajs/jwt"]);
    });

    test("a `@/` path is ours, and out of scope", () => {
      const hits = [
        ...`mock.module("@/api/lib/prisma", () => ({}))`.matchAll(
          barePackageMock(),
        ),
      ];
      expect(hits).toEqual([]);
    });

    test("a restore at file top level does not count as a restore", () => {
      expect([
        ...restoredInTeardown(`mock.module("jose", () => real);\n`),
      ]).toEqual([]);
    });

    test("a restore inside afterAll counts, and names its target", () => {
      expect([
        ...restoredInTeardown(
          `afterAll(() => {\n  mock.module("jose", () => real);\n});\n`,
        ),
      ]).toEqual(["jose"]);
    });

    // Round-2 finding: braces were counted wherever they appeared, so a literal ended the hook.
    test("a brace inside a string does not end the hook", () => {
      expect([
        ...restoredInTeardown(
          'afterAll(() => {\n  const marker = "}";\n  mock.module("jose", () => real);\n});\n',
        ),
      ]).toEqual(["jose"]);
    });

    test("an unbalanced brace inside a string does not swallow the rest of the file", () => {
      expect([
        ...restoredInTeardown(
          'afterAll(() => {\n  const marker = "{";\n});\nmock.module("jose", () => real);\n',
        ),
      ]).toEqual([]);
    });

    test("a brace inside a line comment does not end the hook", () => {
      expect([
        ...restoredInTeardown(
          'afterAll(() => {\n  // closing } here\n  mock.module("jose", () => real);\n});\n',
        ),
      ]).toEqual(["jose"]);
    });

    test("a brace inside a block comment does not end the hook", () => {
      expect([
        ...restoredInTeardown(
          'afterAll(() => {\n  /* } */\n  mock.module("jose", () => real);\n});\n',
        ),
      ]).toEqual(["jose"]);
    });

    test("an escaped quote does not end the string early", () => {
      expect([
        ...restoredInTeardown(
          'afterAll(() => {\n  const s = "a \\" }";\n  mock.module("jose", () => real);\n});\n',
        ),
      ]).toEqual(["jose"]);
    });

    test("a nested brace does not end the hook early", () => {
      expect([
        ...restoredInTeardown(
          `afterAll(() => {\n  if (x) { cleanup(); }\n  mock.module("jose", () => real);\n});\n`,
        ),
      ]).toEqual(["jose"]);
    });

    // The hole the round-1 review found: one restore used to vouch for every package in the file.
    test("restoring one package does not vouch for another", () => {
      const restored = restoredInTeardown(
        `mock.module("jose", () => stub);\nmock.module("react-i18next", () => stub);\n` +
          `afterAll(() => {\n  mock.module("jose", () => real);\n});\n`,
      );
      expect(restored.has("jose")).toBe(true);
      expect(restored.has("react-i18next")).toBe(false);
    });

    // …and the other half of it: an unrelated restore of one of OUR modules is not a restore of the
    // third-party one that was replaced.
    test("restoring a `@/` module does not vouch for a package", () => {
      const restored = restoredInTeardown(
        `afterAll(() => {\n  mock.module("@/api/lib/prisma", () => real);\n});\n`,
      );
      expect(restored.has("jose")).toBe(false);
    });
  });
});
