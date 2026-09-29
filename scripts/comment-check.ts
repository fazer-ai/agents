// Checks the files named on the command line against the comment ledger, the same way the sweep
// does, and prints each offending block. Run by the editor hook on every write, so a history
// citation, an over-long block or a tagged docstring is reported where it is written, not at the end
// of the suite.
import { resolve } from "node:path";
import { COMMENT_LEDGER } from "../tests/lib/comment-ledger";
import {
  BLOCK_LINE_CEILING,
  citesProvenance,
  commentBlocks,
  overCeiling,
  SWEPT_ROOTS,
  taggedDocstrings,
} from "../tests/utils/comment-blocks";

const root = resolve(import.meta.dir, "..");
let failed = false;
for (const arg of process.argv.slice(2)) {
  const rel = resolve(arg).slice(root.length + 1);
  if (
    !SWEPT_ROOTS.some((r) => rel.startsWith(`${r}/`)) ||
    !/\.(ts|tsx)$/.test(rel)
  )
    continue;
  if (rel.endsWith(".d.ts") || rel === "tests/lib/comment-ledger.ts") continue;
  const file = Bun.file(resolve(root, rel));
  if (!(await file.exists())) continue;
  const src = await file.text();
  for (const line of taggedDocstrings(src)) {
    failed = true;
    console.error(
      `${rel}: line ${line}: a comment directly above a declaration documents it and takes no NOTE: (CLAUDE.md, "Where the tag goes")`,
    );
  }
  const blocks = commentBlocks(src);
  const prov = blocks.filter(citesProvenance);
  const long = blocks.filter(overCeiling);
  const [maxProv, maxLong] = COMMENT_LEDGER[rel] ?? [0, 0];
  if (prov.length <= maxProv && long.length <= maxLong) continue;
  failed = true;
  console.error(
    `${rel}: [${prov.length}, ${long.length}] against the ledger's [${maxProv}, ${maxLong}]`,
  );
  if (prov.length > maxProv)
    for (const b of prov)
      console.error(
        `  line ${b.line}: cites where the code came from (issue, PR, review, or history in words): ${(b.text.split("\n")[0] ?? "").trim().slice(0, 100)}`,
      );
  if (long.length > maxLong)
    for (const b of long)
      console.error(
        `  line ${b.line}: ${b.lines} lines, over the ${BLOCK_LINE_CEILING}-line ceiling`,
      );
}
if (failed) {
  console.error(
    "A comment states what is true of the code now: restate the fact in the present tense, keep why the obvious alternative is wrong, and put the story in the commit or the PR (CLAUDE.md, comment rule).",
  );
  process.exit(1);
}
