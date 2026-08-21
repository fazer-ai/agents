import { describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";

// What the browser is allowed to pull in, enforced on the actual import graph rather than on a
// comment nobody re-reads.
//
// Two modules in this tree state the rule in prose and had nothing checking it: `modules/tts/
// providers` (the synthesis registry, reached by importing `modules/tts/settings`) and the LangChain
// SDKs (`graph/model-config` is deliberately free of them so the HTTP layer can validate a model
// config without them). The first one broke: the agent editor imported a voice clamp and shipped the
// ElevenLabs HTTP client and the WAV header writer to every browser that loads the console.

const ENTRY = "src/client/frontend.tsx";

// Server-only modules and packages, with why each one is on the list.
const FORBIDDEN = [
  // Object.keys(PROVIDERS) at module scope: importing anything from it evaluates the whole registry.
  "src/modules/tts/providers.ts",
  // The synthesis path itself (fetch + audio encoding), reachable the same way.
  "src/modules/tts/normalize.ts",
  "src/config.ts",
];
const FORBIDDEN_PACKAGES = ["@langchain/", "langchain", "@prisma/client"];

const EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];

function resolveLocal(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
  else if (spec.startsWith(".")) {
    const dir = fromFile.split("/").slice(0, -1).join("/");
    base = new URL(spec, `file:///${dir}/`).pathname.replace(/^\//, "");
  } else return null;
  // Only ever a FILE: `Bun.file` reports a non-zero size for a directory too, and `src/client/
  // components` would otherwise resolve as if it were a module.
  const candidates = EXTENSIONS.some((e) => base.endsWith(e))
    ? [base]
    : [
        ...EXTENSIONS.map((e) => base + e),
        ...EXTENSIONS.map((e) => `${base}/index${e}`),
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

// `import ... from "x"`, `export ... from "x"` and `import("x")`. Type-only imports are erased by the
// bundler, so they cannot pull anything in and are skipped.
const SPEC_RE =
  /(?:^|\n)\s*(?:import|export)(?!\s+type\s)[\s\S]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

describe("client bundle boundary", () => {
  test("no server-only module is reachable from the browser entry", async () => {
    const seen = new Set<string>();
    const packageHits: string[] = [];
    const queue = [ENTRY];
    const via = new Map<string, string>();

    while (queue.length > 0) {
      const file = queue.shift() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await Bun.file(file).text();
      for (const m of text.matchAll(SPEC_RE)) {
        const spec = m[1] ?? m[2];
        if (!spec) continue;
        const local = resolveLocal(spec, file);
        if (local === null) {
          if (FORBIDDEN_PACKAGES.some((p) => spec.startsWith(p))) {
            packageHits.push(`${spec} (from ${file})`);
          }
          continue;
        }
        if (!via.has(local)) via.set(local, file);
        queue.push(local);
      }
    }

    // The walk has to actually reach the app, or an empty graph would pass silently.
    expect(seen.size).toBeGreaterThan(50);
    expect(seen.has("src/client/pages/agents/AgentEditorPage.tsx")).toBe(true);

    const hits = FORBIDDEN.filter((f) => seen.has(f)).map(
      (f) => `${f} (imported by ${via.get(f)})`,
    );
    expect([...hits, ...packageHits]).toEqual([]);
  });
});
