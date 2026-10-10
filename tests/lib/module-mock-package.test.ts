import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { expectWaiverLedger } from "@/tests/utils/ledger";

// Stubbing a THIRD-PARTY module is process-wide, and this ledger is where each one is argued for.
// `mock.module` has no file scope and no teardown, so every later file imports a stub written for one
// caller, and a `mockReset()` on it leaves a function RETURNING UNDEFINED: the TypeError that follows
// reads as ordinary bad input. The rule is "argue for it", not "restore it afterwards": `await
// import()` hands back the LIVE namespace the mock rewrote in place, so a teardown handing it back
// re-registers the stub while reading as a cleanup. What keeps a leak harmless is a stub that
// DELEGATES to the real implementation.

// A package is a specifier that is not a path: `jose`, `@scope/name`. Anything starting with `.`,
// `/` or `@/` is ours (or relative) and out of scope; the table below covers the leading dot.
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
// cases the tree does not contain, which are exactly the ones a sweep exists to catch.
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
// is the proof that helpers here do install them; reading only test files would leave the whole
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

  // NOTE: what the sweep READS, asserted apart from what it decides: no helper stubs a package
  // today, so narrowing this back to `*.test.*` would otherwise break nothing measurable.
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
// A leaked stub is the whole surface every downstream file sees, so its BEHAVIOUR has to match.
// For `react-i18next` the half a stub drops is interpolation (it is written for labels without
// variables), and the file that pays is whichever runs next: its label holds a literal `{{ref}}`.
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

    // NOTE: the block ENDS at the stub's own closing line: a placeholder anywhere later in the file
    // (a fixture string, a second stub, a JSX comment) would otherwise answer for a `t` that never
    // looks at `vars`.
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
