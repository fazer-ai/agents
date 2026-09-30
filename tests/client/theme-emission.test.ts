import { describe, expect, test } from "bun:test";
import path from "node:path";
import { compile } from "tailwindcss";

// Tailwind v4 emits a `@theme` variable into `:root` only when a class
// or a scanned `var(--…)` uses it. The dark palette lives in `@theme` while
// the light palette is a plain block that is always emitted, so a pruned token
// resolved in light mode and to nothing in dark mode. This compiles the real
// stylesheet with the real compiler and ZERO candidates, which is the case a
// token read by a computed name (`getPropertyValue(\`--color-${name}\`)`) is in.

const ROOT = path.resolve(import.meta.dir, "../..");
const INDEX_CSS = path.join(ROOT, "public/index.css");

async function resolveStylesheet(id: string, base: string): Promise<string> {
  if (id.startsWith(".") || id.startsWith("/")) return path.resolve(base, id);
  const pkgDir = path.join(ROOT, "node_modules", id);
  const pkg = await Bun.file(path.join(pkgDir, "package.json")).json();
  const entry = pkg.exports?.["."]?.style ?? pkg.style ?? "index.css";
  return path.join(pkgDir, entry);
}

async function compileIndexCss(source: string): Promise<string> {
  const compiler = await compile(source, {
    base: path.dirname(INDEX_CSS),
    loadStylesheet: async (id, base) => {
      const file = await resolveStylesheet(id, base);
      return {
        path: file,
        base: path.dirname(file),
        content: await Bun.file(file).text(),
      };
    },
  });
  return compiler.build([]);
}

function themeBlock(source: string): string {
  const start = source.search(/^@theme\b[^{]*\{/m);
  if (start === -1) throw new Error("No @theme block in public/index.css");
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0)
      return source.slice(start, i + 1);
  }
  throw new Error("Unterminated @theme block");
}

function declaredNames(block: string): string[] {
  return [...block.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map((m) => m[1] as string);
}

function emittedRootNames(css: string): Set<string> {
  const root = css.match(/:root, :host \{([^}]*)\}/)?.[1];
  if (root === undefined) throw new Error("No `:root, :host` block emitted");
  return new Set(declaredNames(root));
}

describe("theme variable emission", () => {
  test("every @theme variable is emitted even when no class uses it", async () => {
    const source = await Bun.file(INDEX_CSS).text();
    const declared = declaredNames(themeBlock(source));
    const colors = declared.filter((name) => name.startsWith("--color-"));
    expect(colors.length).toBeGreaterThan(0);

    const emitted = emittedRootNames(await compileIndexCss(source));
    const missing = declared.filter((name) => !emitted.has(name));
    expect(missing).toEqual([]);
  });

  test("the check catches pruning: a plain @theme drops unused tokens", async () => {
    const source = (await Bun.file(INDEX_CSS).text()).replace(
      /^@theme\b[^{]*\{/m,
      "@theme {",
    );
    const emitted = emittedRootNames(await compileIndexCss(source));
    expect(emitted.has("--color-info")).toBe(false);
  });
});
