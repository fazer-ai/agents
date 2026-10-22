// Refuses one business's vocabulary used as a generic example: a placeholder that reads
// `compra-de-ingresso` tells an operator in any other business that the console was built for ticket
// sales. The leak came from one install's operations (its label names, its custom attributes) into
// the catalogs, the docs and the comments, so the check reads the raw text of all three, comments
// and `t()` fallbacks included. Run by `bun run lint` and swept by
// tests/scripts/check-domain-vocabulary.test.ts.
// Run: bun scripts/check-domain-vocabulary.ts
import { type Dirent, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Spelled as the leak looked, not as the domain's whole dictionary: "evento" alone is a calendar
// event, a webhook event or an integration event, all legitimate, so only the uses that named one
// business's attribute or label are refused.
export const DOMAIN_VOCABULARY: RegExp[] = [
  /ingresso/i,
  /duvidas-evento/i,
  /tickets\.example/i,
  /evento_\{/i,
  /conversations by event\b/i,
  /conversas por evento\b/i,
  /(?:for example|por exemplo): evento\b/i,
];

/** Each line of `text` that uses the vocabulary, as `name:line pattern`. */
export function vocabularyHits(name: string, text: string): string[] {
  return text
    .split("\n")
    .flatMap((line, i) =>
      DOMAIN_VOCABULARY.filter((re) => re.test(line)).map(
        (re) => `${name}:${i + 1} ${re}`,
      ),
    );
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function walk(dir: string, accept: (path: string) => boolean): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return SKIP_DIRS.has(entry.name) ? [] : walk(path, accept);
    return accept(path) ? [path] : [];
  });
}

/** What an operator or a reader of the public repo sees: the source, the catalogs and the docs. */
export function sweptFiles(root: string): string[] {
  return [
    ...walk(join(root, "src"), (path) => /\.(ts|tsx|json)$/.test(path)),
    ...walk(join(root, "docs"), (path) => path.endsWith(".md")),
    join(root, "README.md"),
  ];
}

/** Every hit in the tree under `root`, named relative to it. */
export function treeHits(root: string): string[] {
  return sweptFiles(root).flatMap((path) => {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    return vocabularyHits(relative(root, path), text);
  });
}

if (import.meta.main) {
  const hits = treeHits(resolve(import.meta.dir, ".."));
  for (const hit of hits) console.error(hit);
  if (hits.length > 0) {
    console.error(
      `${hits.length} use(s) of one business's vocabulary as an example: write it generic, or drop the example.`,
    );
    process.exit(1);
  }
}
