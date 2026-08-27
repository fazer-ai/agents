import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// Stubbing a THIRD-PARTY module is a process-wide act, and this ledger is where each one is argued
// for.
//
// `mock.module` has no file scope and no teardown: whatever it installs is what every file that runs
// afterwards imports, for the rest of the process. For a `@/` target that is survivable — the module
// is ours and the blast radius is a directory we own. For a package it is not: nobody downstream
// knows it was replaced, the stub is written for one caller's needs, and a `mockReset()` on one of
// its functions leaves that function RETURNING UNDEFINED rather than throwing. Code that reads a
// property off the result dies with a TypeError, which its own catch reports as ordinary bad input.
//
// Measured on 2026-08-27 (issue #420): a stub of `jose` left `jwtVerify` returning `undefined` for
// the files that ran after it. Every session cookie became a 401, the failure named the cookie, and
// it took ten CI runs to find, because each layer between the stub and the assertion translated the
// fault into its own vocabulary.
//
// ## Why the rule is "argue for it" and not "restore it afterwards"
//
// Restoring is the intuitive rule and it is the wrong one, on two counts both measured while this
// file was being reviewed. It is not SUFFICIENT: `await import()` hands back a LIVE namespace that
// the mock rewrites in place, so a teardown handing that namespace back re-registers the stub while
// reading as a cleanup — and a teardown is free to install a different stub entirely, which no
// reader of the source can tell from a real restore. And it is not what fixed the outage: what
// fixed it was the stub DELEGATING to the real implementation, so that the leak, which is permanent
// either way, carries correct behaviour.
//
// So the sweep asks the only question a reader can answer honestly — is this package stubbed at
// all? — and every yes owes a line here saying what keeps it harmless.

// A package is a specifier that is not a path: `jose`, `@scope/name`. Anything starting with `.`,
// `/` or `@/` is ours (or relative) and out of scope — the leading-dot case is not hypothetical,
// it slipped through an earlier spelling of this pattern and the table below is what caught it.
const PACKAGE_MOCK = () => /mock\.module\(\s*"(?![./]|@\/)([^"]+)"/g;

// Keyed by `file → package`, never by file alone: a waiver written for one package must not cover a
// second one the same file adds later, which is how a waived file becomes the place to hide a leak.
const PACKAGE_MOCKS_WAIVED: Record<string, string> = {
  "api/features/auth/google.service.test.ts → jose":
    "the stub DELEGATES to the real `jwtVerify` unless a test overrides it for its own call, so the leaked function still verifies real tokens for every file downstream. Asserted there by a round trip that runs after `beforeEach`, which is what fails if the delegation or the `mockClear` is taken away.",
  "client/components/TenantDeepLink.test.tsx → react-i18next":
    "predates this ledger. It has not bitten because every test that renders a translated component stubs `useTranslation` itself, so a leaked stub meets another stub. That is a property of today's client tests, not a guarantee.",
  "client/components/UserMenu.test.tsx → react-i18next": "same as above.",
  "client/pages/DashboardFirstResponse.test.tsx → react-i18next":
    "same as above.",
  "client/pages/KnowledgeApprovals.test.tsx → react-i18next": "same as above.",
  "client/pages/KnowledgeDocsBlock.test.tsx → react-i18next": "same as above.",
  "client/pages/LogsGroupTitle.test.tsx → react-i18next": "same as above.",
  "client/pages/LogsScopeChip.test.tsx → react-i18next": "same as above.",
  "client/pages/SetupPage.test.tsx → react-i18next": "same as above.",
  "client/pages/VaultFillDeepLink.test.tsx → react-i18next": "same as above.",
};

// This file's own `mock.module(…)` occurrences are FIXTURES for the decision table below, not calls.
// A sweep that reads source text cannot tell one from the other, so it skips itself, and the table
// is what covers the reader instead.
const SELF = "lib/module-mock-package.test.ts";

export interface ScannedFile {
  rel: string;
  source: string;
}

// The decision, over supplied files rather than over the tree, so the table below can hand it the
// cases the tree does not contain — which are exactly the cases a sweep exists to catch, and the
// ones the tree can never show while the sweep is passing.
export function packageMocksIn(files: readonly ScannedFile[]): string[] {
  const out: string[] = [];
  for (const { rel, source } of files) {
    const targets = new Set(
      [...source.matchAll(PACKAGE_MOCK())].map((m) => m[1] as string),
    );
    for (const pkg of targets) out.push(`${rel} → ${pkg}`);
  }
  return out.sort();
}

export function unwaived(
  found: readonly string[],
  waived: Readonly<Record<string, string>>,
): string[] {
  return found.filter((key) => !(key in waived));
}

export function staleWaivers(
  found: readonly string[],
  waived: Readonly<Record<string, string>>,
): string[] {
  const live = new Set(found);
  return Object.keys(waived).filter((key) => !live.has(key));
}

// EVERY source file under `tests/`, not just `*.test.*`. A stub installed by a shared helper or by
// a preload is exactly as process-global as one written in a test file, and `tests/utils/prisma-mock.ts`
// is the proof that helpers here do install them — reading only test files would leave the whole
// support layer as a blind spot in a sweep that claims to cover the tree.
export function testFiles(): string[] {
  return [...new Glob("**/*.{ts,tsx}").scanSync("tests")]
    .filter((rel) => rel !== SELF)
    .sort();
}

async function scanTree(): Promise<ScannedFile[]> {
  return Promise.all(
    testFiles().map(async (rel) => ({
      rel,
      source: await Bun.file(`tests/${rel}`).text(),
    })),
  );
}

describe("every third-party module stub is argued for", () => {
  test("no package is stubbed without a line in the ledger", async () => {
    const found = packageMocksIn(await scanTree());

    expect(
      unwaived(found, PACKAGE_MOCKS_WAIVED),
      "This replaces a third-party module for the WHOLE process, permanently: every file that runs " +
        "afterwards imports the stub, and a `mockReset()` on one of its functions leaves that " +
        "function returning `undefined` rather than throwing. Prefer not stubbing the package at " +
        "all. If you must, make the stub DELEGATE to the real implementation by default, assert it " +
        "still works for a caller outside your file, and add the pair here with what keeps it " +
        "harmless. See tests/api/features/auth/google.service.test.ts.",
    ).toEqual([]);

    // The sweep is worth nothing if it stops finding the calls it is meant to police.
    expect(found.length).toBeGreaterThan(0);
  });

  // The size pin is guarded in one direction only. A waived pair that no longer exists leaves a slot
  // nobody notices: the size still matches, so a NEW stub takes the freed slot and the suite stays
  // green. Checking the ledger against the tree it describes is the anchor the size cannot be.
  test("every waiver still names a stub that exists", async () => {
    expect(
      staleWaivers(packageMocksIn(await scanTree()), PACKAGE_MOCKS_WAIVED),
      "These waivers no longer describe anything: the file was deleted, or it stopped stubbing that " +
        "package. Remove them AND lower the pin, or the freed slots absorb the next one silently.",
    ).toEqual([]);
  });

  test("the ledger may only shrink", () => {
    expectWaiverLedger("PACKAGE_MOCKS_WAIVED", PACKAGE_MOCKS_WAIVED, 10);
  });

  // What the sweep READS, asserted separately from what it decides. No helper stubs a package
  // today, so narrowing this back to `*.test.*` would break nothing measurable — which is exactly
  // the shape of a guard nobody would notice losing.
  describe("what the sweep reads", () => {
    test("support files that are not tests are read too", () => {
      const files = testFiles();
      expect(files).toContain("utils/prisma-mock.ts");
      expect(files).toContain("setup.ts");
    });

    test("test files are still read", () => {
      expect(testFiles()).toContain("api/features/auth/google.service.test.ts");
    });

    test("the sweep does not read itself", () => {
      expect(testFiles()).not.toContain(SELF);
    });
  });

  describe("the decision, over files it is handed", () => {
    const scan = (source: string) =>
      packageMocksIn([{ rel: "a.test.ts", source }]);

    test("a file that stubs nothing is not reported", () => {
      expect(scan("const x = 1;")).toEqual([]);
    });

    test("a bare package name is in scope", () => {
      expect(scan('mock.module("jose", () => stub);')).toEqual([
        "a.test.ts → jose",
      ]);
    });

    test("a scoped package is in scope", () => {
      expect(scan('mock.module("@elysiajs/jwt", () => stub);')).toEqual([
        "a.test.ts → @elysiajs/jwt",
      ]);
    });

    test("a `@/` path is ours, and out of scope", () => {
      expect(scan('mock.module("@/api/lib/prisma", () => stub);')).toEqual([]);
    });

    test("a relative path is out of scope too", () => {
      expect(scan('mock.module("./helpers", () => stub);')).toEqual([]);
    });

    test("two packages in one file are two entries", () => {
      expect(
        scan(
          'mock.module("jose", () => s);\nmock.module("react-i18next", () => s);',
        ),
      ).toEqual(["a.test.ts → jose", "a.test.ts → react-i18next"]);
    });

    test("the same package stubbed twice is one entry", () => {
      expect(
        scan('mock.module("jose", () => a);\nmock.module("jose", () => b);'),
      ).toEqual(["a.test.ts → jose"]);
    });

    // A teardown that re-mocks is NOT a reason to stop reporting: it may hand back a live namespace
    // the mock already rewrote, or install a different stub, and no reader of the source can tell
    // the two apart. That undecidability is precisely why the rule asks whether the package is
    // stubbed rather than whether it was put back.
    test("a restore in afterAll does not excuse the stub", () => {
      expect(
        scan(
          'mock.module("jose", () => stub);\nafterAll(() => {\n  mock.module("jose", () => real);\n});\n',
        ),
      ).toEqual(["a.test.ts → jose"]);
    });
  });

  describe("the ledger is subtracted by pair", () => {
    test("a waiver for one package does not cover another in the same file", () => {
      const found = ["a.test.ts → jose", "a.test.ts → react-i18next"];
      expect(unwaived(found, { "a.test.ts → jose": "why" })).toEqual([
        "a.test.ts → react-i18next",
      ]);
    });

    test("a waiver key that names only the file covers nothing", () => {
      expect(unwaived(["a.test.ts → jose"], { "a.test.ts": "why" })).toEqual([
        "a.test.ts → jose",
      ]);
    });

    test("a waiver whose stub is gone is stale", () => {
      expect(staleWaivers([], { "gone.test.ts → jose": "why" })).toEqual([
        "gone.test.ts → jose",
      ]);
    });

    test("a waiver whose stub is still there is not stale", () => {
      expect(
        staleWaivers(["a.test.ts → jose"], { "a.test.ts → jose": "why" }),
      ).toEqual([]);
    });
  });
});
