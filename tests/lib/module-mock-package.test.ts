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
    expectWaiverLedger("PACKAGE_MOCKS_WAIVED", PACKAGE_MOCKS_WAIVED, 1);
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

// ── the stub that leaks has to SAY what the real module would ──
//
// The ledger above asks whether a package is stubbed. This asks the question that comes after, and
// it is the one the outage in the header actually turned on: a leaked stub is the whole surface every
// downstream file sees, so its BEHAVIOUR has to match. For `react-i18next` the half that gets
// dropped is interpolation, because a stub is written for a caller whose own labels take no
// variables, and the file that pays is a different one.
//
// Measured on 2026-08-29 (#435): four of the ten dropped the `vars` argument, a new page test
// rendered a translated page without stubbing, and its label came out holding a literal `{{ref}}`.
// Green locally, red on CI, because which stub wins is which file ran last — and the failure named
// the assertion, not the stub.
const I18N_STUB = /mock\.module\(\s*"react-i18next"/;

export function nonInterpolatingI18nStubs(
  files: readonly ScannedFile[],
): string[] {
  const out: string[] = [];
  for (const { rel, source } of files) {
    const at = source.search(I18N_STUB);
    if (at < 0) continue;
    const end = source.indexOf("\n}));", at);
    const block = source.slice(at, end < 0 ? source.length : end);
    // `{{` appears in one of these stubs only inside the pattern that expands it. A `t` that ignores
    // `vars` has no reason to name the placeholder at all, which is what makes the mention readable
    // as the behaviour rather than as a comment about it. The backslashes come off first: the
    // pattern is written as a regex literal, so the placeholder reaches the source text as `\{\{`
    // and a plain `includes("{{")` finds none of the stubs that DO expand it.
    if (!block.replace(/\\/g, "").includes("{{")) out.push(rel);
  }
  return out.sort();
}

export function i18nStubFiles(files: readonly ScannedFile[]): string[] {
  return files.filter(({ source }) => I18N_STUB.test(source)).map((f) => f.rel);
}

describe("a leaked `t` still interpolates", () => {
  test("no stub of react-i18next drops its vars", async () => {
    expect(
      nonInterpolatingI18nStubs(await scanTree()),
      "`mock.module` has no file scope, so this `t` is what every file that runs afterwards gets — " +
        "including files that never asked for a stub and whose labels DO interpolate. A `t` that " +
        "returns the fallback unexpanded renders `{{ref}}` on screen, and the file that fails is not " +
        "this one. Do not write one: `withI18n` in tests/utils/i18n.tsx hands the tree a real i18next " +
        "instance by context, and real interpolation comes with it.",
    ).toEqual([]);
  });

  // THE TREE NO LONGER HOLDS ONE, AND THAT IS THE POINT, SO THIS SELF-CHECK IS INVERTED.
  //
  // It used to read `toBeGreaterThan(0)`, on the rule that a sweep finding nothing has stopped
  // being evidence. Nine files stubbed the package then; none does now, because a per-file i18next
  // instance handed down through `I18nextProvider` answers the same `t` without writing anything to
  // the module registry (tests/utils/i18n.tsx). So the honest assertion is the stronger one: zero.
  //
  // What covers the function now that the tree cannot exercise it is the fixture table below, which
  // is the same answer this file already gives for its own `SELF` exclusion. And the sweep above is
  // what keeps the zero true: an unwaived `mock.module("react-i18next", …)` fails there first.
  test("nothing stubs react-i18next any more", async () => {
    expect(
      i18nStubFiles(await scanTree()),
      "Stubbing this package replaces it for the whole process, and the `i18n` a hand-written stub " +
        "hands back freezes `language` at a literal, which is what made " +
        "tests/client/document-starters-race.test.tsx stop racing. Use `withI18n` from " +
        "tests/utils/i18n.tsx instead: a real instance, per file, delivered by context.",
    ).toEqual([]);
  });

  describe("the decision, over files it is handed", () => {
    const scan = (source: string) =>
      nonInterpolatingI18nStubs([{ rel: "a.test.tsx", source }]);

    const stub = (body: string) =>
      `mock.module("react-i18next", () => ({\n  useTranslation: () => ({\n${body}\n  }),\n}));\n`;

    test("a stub that ignores the vars argument is reported", () => {
      expect(scan(stub("    t: (k: string, fb?: string) => fb ?? k,"))).toEqual(
        ["a.test.tsx"],
      );
    });

    test("a stub that expands the placeholder is not", () => {
      expect(
        scan(
          stub(
            "    t: (k: string, fb?: string, v?: Record<string, unknown>) =>\n      (fb ?? k).replace(/\\{\\{(\\w+)\\}\\}/g, (m, n) => String(v?.[n] ?? m)),",
          ),
        ),
      ).toEqual([]);
    });

    test("a file that stubs nothing is not reported", () => {
      expect(scan("const x = 1;")).toEqual([]);
    });

    // The block ENDS at the stub's own closing line, and this is the fixture that says why: a
    // placeholder anywhere later in the file — a fixture string, a second stub, a JSX comment — would
    // otherwise answer for a `t` that never looks at `vars`.
    test("a placeholder after the stub does not vouch for it", () => {
      expect(
        scan(
          `${stub("    t: (k: string, fb?: string) => fb ?? k,")}\nconst label = "Signed with: {{ref}}";\n`,
        ),
      ).toEqual(["a.test.tsx"]);
    });

    // A stub for a DIFFERENT package is not this sweep's business, and a sweep that matched any
    // `mock.module` would report every one of them as non-interpolating.
    test("a stub of another package is not reported", () => {
      expect(scan('mock.module("jose", () => stub);\n')).toEqual([]);
    });
  });
});
