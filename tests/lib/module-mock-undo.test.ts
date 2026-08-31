import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { codeOnly } from "@/tests/utils/source-text";

// A TEARDOWN THAT HANDS BACK THE NAMESPACE `await import()` RETURNED PUTS NOTHING BACK.
//
// `mock.module(spec, factory)` rewrites the module registry for the WHOLE process, and it rewrites
// the live namespace object in place. So a file that saves the namespace first and re-registers it
// afterwards is handing the registry the object the rewrite already changed:
//
//     const service = await import("@/modules/rag/service");
//     mock.module("@/modules/rag/service", () => ({ ...service, listX: stub }));
//     afterAll(() => mock.module("@/modules/rag/service", () => service));   // <- undoes nothing
//
// It reads as a cleanup, it is what a reviewer expects to see, and the stub survives it for every
// file that runs afterwards. tests/lib/module-mock-package.test.ts already says this in prose. This
// is the same sentence, enforced.
//
// Measured on 2026-08-30, over `bun test --shard=k/4` against a clean main: six files were carrying
// this shape and two of them were reachable in the order the shards give.
//
//   - tests/api/v1/knowledge-tenant-context.test.ts stubbed `listKnowledgeBases` to answer `[]`, and
//     tests/modules/tenant-selector-entry-points.test.ts, which calls the real one to prove it
//     REFUSES a dead tenant selector, got the stub. Nothing was refused. Two failures in shard 1/4.
//   - tests/api/v1/query-filter-refusal.test.ts stubbed `listExecutionLogs` and `listAudit` the same
//     way, and tests/modules/flowlog.test.ts then read none of its own rows back, reported as a
//     tenant unable to see its own data, which is the shape of an RLS defect. Three failures in
//     shard 4/4, across two files, neither of which stubs anything.
//
// None of the five failures named the file at fault, which is why this is a source sweep and not a
// runtime check: the cost is paid somewhere else, so only the source can name the cause.
//
// WHAT IS NOT FLAGGED, and the distinction is the whole decision: a factory returning an object
// LITERAL is fine, because `{ ...service }` taken before the rewrite is a copy and the copy still
// holds the original functions. What is flagged is a factory returning a bare identifier that this
// file bound from `await import(...)`. The two are indistinguishable at the call site, so the sweep
// resolves the binding instead of reading the call.
//
// THE FIX IS NEVER A BETTER TEARDOWN. `spyOn(namespaceObject, "name")` keeps the original value and
// `mockRestore()` puts that value back, per property, without touching the registry at all. Every
// file named above now does that.

const NAMESPACE_BINDING =
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+import\s*\(/g;
// A factory that is an arrow returning a bare identifier and nothing else. The specifier is left
// unnamed in this sentence on purpose: the package sweep next door reads raw source, so spelling a
// quoted bare specifier inside a `mock.module(` here would be counted as a stub of a package by
// that name. The
// specifier is matched as `"[^"]*"` rather than `"[^"]+"` because this runs over `codeOnly` output,
// where a string body is blanked and an EMPTY pair of quotes is what a real specifier looks like.
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

  // A sweep that reads nothing passes, and passing on an empty read is the failure this file exists
  // to prevent. The tree no longer holds the shape, so what has to be non-empty is the INPUT.
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
