import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { codeOnly } from "@/tests/utils/source-text";

// A TEARDOWN THAT HANDS BACK THE NAMESPACE `await import()` RETURNED PUTS NOTHING BACK.
// `mock.module` rewrites the registry for the whole process AND the live namespace in place, so
// `afterAll(() => mock.module(spec, () => service))` re-registers the stub while reading as a
// cleanup. The failure lands in a later file that stubs nothing, so only a source sweep names the
// cause. Not flagged: a factory returning an object LITERAL (`{ ...service }` taken before the
// rewrite is a copy of the originals). Flagged: a bare identifier bound from `await import(...)`,
// found by resolving the binding. The fix is never a better teardown: `spyOn(namespace, "name")`
// with `mockRestore()` restores per property without touching the registry.

const NAMESPACE_BINDING =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(/g;
// A factory that is an arrow returning a bare identifier and nothing else. The specifier stays
// unnamed here on purpose: the package sweep next door reads raw source, so a quoted bare specifier
// inside a `mock.module(` in this comment would count as a stub of that package. It is matched as
// `"[^"]*"`, not `"[^"]+"`, because `codeOnly` blanks string bodies and an EMPTY pair of quotes is
// what a real specifier looks like there.
const UNDO_BY_IDENT =
  /mock\.module\(\s*"[^"]*"\s*,\s*\(\s*\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\)/g;

export interface ScannedFile {
  rel: string;
  source: string;
}

export function undoByLiveNamespace(files: readonly ScannedFile[]): string[] {
  const out: string[] = [];
  for (const { rel, source } of files) {
    // `codeOnly` decides WHERE, the raw source says WHAT. It blanks string BODIES, so the specifier
    // reaches the match as spaces; every removed character becomes one, so the offsets still name the
    // same position in `source` and the name can be read back from there.
    const code = codeOnly(source);
    const namespaces = new Set(
      [...code.matchAll(NAMESPACE_BINDING)].map((m) => m[1] as string),
    );
    if (namespaces.size === 0) continue;
    for (const m of code.matchAll(UNDO_BY_IDENT)) {
      if (!namespaces.has(m[1] as string)) continue;
      const spec = /"([^"]*)"/.exec(
        source.slice(m.index, m.index + m[0].length),
      )?.[1];
      out.push(`${rel} → ${spec ?? "?"}`);
    }
  }
  return [...new Set(out)].sort();
}

async function testSources(): Promise<ScannedFile[]> {
  const out: ScannedFile[] = [];
  for await (const rel of new Glob("**/*.{ts,tsx}").scan("tests")) {
    out.push({ rel, source: await Bun.file(`tests/${rel}`).text() });
  }
  return out;
}

// This file spells the shape in its own fixtures, so it answers for itself the way every sweep here
// does: `codeOnly` covers the prose, and the table below covers what prose cannot.
const SELF = "lib/module-mock-undo.test.ts";

describe("a module stub is undone by restoring, not by re-registering", () => {
  test("no teardown hands the registry a live namespace", async () => {
    expect(
      undoByLiveNamespace((await testSources()).filter((f) => f.rel !== SELF)),
      "`mock.module` rewrites this namespace object IN PLACE, so handing it back registers the stub " +
        "a second time. The file reads as if it cleaned up and every file that runs afterwards still " +
        "gets the stub, and fails somewhere else, naming its own assertion. Use " +
        '`spyOn(namespace, "name")` and `mockRestore()`, which keeps the original value.',
    ).toEqual([]);
  });

  // NOTE: a sweep that reads nothing passes. The tree holds no instance of the shape, so what has to
  // be non-empty is the INPUT.
  test("the sweep reads the tree", async () => {
    const files = await testSources();
    expect(files.length).toBeGreaterThan(400);
    expect(
      files.some((f) => /await\s+import\s*\(/.test(f.source)),
      "no file binds a namespace at all, so the sweep could not flag one either way",
    ).toBe(true);
  });

  describe("the decision, over files it is handed", () => {
    const scan = (source: string) =>
      undoByLiveNamespace([{ rel: "a.ts", source }]);

    test("re-registering a bound namespace is flagged", () => {
      expect(
        scan(
          'const svc = await import("@/m");\nmock.module("@/m", () => ({ ...svc, f: stub }));\nafterAll(() => {\n  mock.module("@/m", () => svc);\n});\n',
        ),
      ).toEqual(["a.ts → @/m"]);
    });

    // The copy is the whole point of the distinction: `{ ...svc }` evaluated BEFORE the rewrite holds
    // the original functions, so re-registering it does restore them.
    test("re-registering a copy taken beforehand is not", () => {
      expect(
        scan(
          'const svc = await import("@/m");\nconst real = { ...svc };\nmock.module("@/m", () => ({ ...svc, f: stub }));\nafterAll(() => {\n  mock.module("@/m", () => real);\n});\n',
        ),
      ).toEqual([]);
    });

    test("an object literal factory is not a re-registration", () => {
      expect(
        scan(
          'const cfg = await import("@/config");\nmock.module("@/config", () => ({ default: cfg.default }));\n',
        ),
      ).toEqual([]);
    });

    test("a file that binds no namespace is out of scope", () => {
      expect(scan('mock.module("@/m", () => real);\n')).toEqual([]);
    });

    // Prose describing the shape is not the shape, which is the phantom-site failure `codeOnly`
    // exists for and which this file's own header would otherwise trip.
    test("the shape written in a comment is not a call site", () => {
      expect(
        scan(
          'const svc = await import("@/m");\n// mock.module("@/m", () => svc) would undo nothing.\n',
        ),
      ).toEqual([]);
    });

    test("two spellings of the same pair are reported once", () => {
      expect(
        scan(
          'const svc = await import("@/m");\nmock.module("@/m", () => svc);\nmock.module("@/m", () => svc);\n',
        ),
      ).toEqual(["a.ts → @/m"]);
    });
  });
});
