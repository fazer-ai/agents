import { describe, expect, test } from "bun:test";
import { relative } from "node:path";

// What the browser is allowed to pull in, asked of the bundler itself: the console's entry is built
// for the browser and the build's own input graph must not hold a server-only module.
//
// Two modules in this tree state the rule in prose: `modules/tts/providers` (the synthesis registry,
// reached by importing `modules/tts/settings`) and the LangChain SDKs (`graph/model-config` is
// deliberately free of them so the HTTP layer can validate a model config without them).

const ROOT = `${import.meta.dir}/../..`;
const local = (spec: string) =>
  relative(process.cwd(), Bun.resolveSync(spec, import.meta.dir));

// Server-only modules, with why each one is on the list.
const FORBIDDEN = [
  // Object.keys(PROVIDERS) at module scope: importing anything from it evaluates the whole registry.
  local("@/modules/tts/providers"),
  // The synthesis path itself (fetch + audio encoding), reachable the same way.
  local("@/modules/tts/normalize"),
  local("@/config"),
  // `new AsyncLocalStorage()` at module scope, and its browser shim is empty: importing ANYTHING
  // from here throws before the console renders, on every screen. The value half lives in
  // `tenancy/actor.ts`, which has no imports at all.
  local("@/lib/tenancy/context"),
];
const FORBIDDEN_PACKAGES = [
  "@langchain/",
  "langchain",
  "@prisma/client",
  "node:async_hooks",
  // The code-tool sandbox interpreter (QuickJS over WebAssembly) cannot load under the console's
  // CSP and must never reach the browser bundle.
  "quickjs-emscripten-core",
  "@jitl/quickjs",
];

interface Metafile {
  inputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
}

describe("client bundle boundary", () => {
  test("no server-only module is reachable from the browser entry", async () => {
    const built = await Bun.build({
      entrypoints: [Bun.resolveSync("@/client/frontend", import.meta.dir)],
      root: ROOT,
      target: "browser",
      metafile: true,
      throw: false,
    } as Parameters<typeof Bun.build>[0]);
    expect(built.success).toBe(true);
    const meta = (built as unknown as { metafile: Metafile }).metafile;
    const inputs = Object.keys(meta.inputs);
    // The build has to actually reach the app, or an empty graph would pass silently.
    expect(inputs.length).toBeGreaterThan(50);
    expect(inputs).toContain(local("@/client/pages/agents/AgentEditorPage"));

    const importer = new Map<string, string>();
    for (const [file, { imports }] of Object.entries(meta.inputs)) {
      for (const i of imports)
        if (!importer.has(i.path)) importer.set(i.path, file);
    }
    const reached = new Set([...inputs, ...importer.keys()]);
    const hits = [...reached]
      .filter(
        (p) =>
          FORBIDDEN.includes(p) ||
          FORBIDDEN_PACKAGES.some(
            (pkg) => p.startsWith(pkg) || p.includes(`node_modules/${pkg}`),
          ),
      )
      .map((p) => `${p} (imported by ${importer.get(p) ?? "the entry"})`);
    expect(hits).toEqual([]);
  });
});
