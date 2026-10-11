// Rewrites tests/lib/comment-ledger.ts from the tree as it stands, refusing any count above the current
// entry. Run it after a cleanup lowers a file's count; the sweep fails until the ledger says it.
//
// On the master tree, entries for files an edition drops are wrapped in that edition's markers, so a
// derived tree lists only files it has.
import { existsSync } from "node:fs";
import {
  countFile,
  type FileCounts,
  raisedEntries,
  renderLedger,
  sweptFiles,
} from "@/tests/utils/comment-blocks";

const LEDGER = "tests/lib/comment-ledger.ts";

async function droppedBy(): Promise<{
  fullOnly: Set<string>;
  masterOnly: Set<string>;
}> {
  const fullOnly = new Set<string>();
  const masterOnly = new Set<string>();
  const manifestPath = "tooling/derivation/manifest.ts";
  if (!existsSync(manifestPath)) return { fullOnly, masterOnly };
  const { MANIFEST } = await import(`${process.cwd()}/${manifestPath}`);
  const within = (drops: string[], path: string) =>
    drops.some((d) => path === d || path.startsWith(`${d}/`));
  const paired: Array<{ free: string }> = MANIFEST.free.pairedFiles ?? [];
  for (const path of await sweptFiles()) {
    const inPro = within(MANIFEST.pro.drop, path);
    const inFree =
      within(MANIFEST.free.drop, path) || paired.some((p) => p.free === path);
    if (inPro && inFree) masterOnly.add(path);
    else if (inFree) fullOnly.add(path);
  }
  return { fullOnly, masterOnly };
}

const counted: Array<[string, FileCounts]> = [];
for (const path of await sweptFiles()) {
  if (path === LEDGER) continue;
  const { counts } = countFile(await Bun.file(path).text());
  if (counts[0] > 0 || counts[1] > 0) counted.push([path, counts]);
}

// The ledger only goes down: a count above the current entry is a new offence to fix, not a number to
// record.
const current: Record<string, FileCounts> = existsSync(LEDGER)
  ? (await import(`${process.cwd()}/${LEDGER}`)).COMMENT_LEDGER
  : {};
const raised = raisedEntries(counted, current);
// `--definition-changed` is for a change to what the sweep counts, never to admit a new comment.
if (raised.length > 0 && !process.argv.includes("--definition-changed")) {
  for (const line of raised) console.error(line);
  process.exit(1);
}

const { fullOnly, masterOnly } = await droppedBy();
await Bun.write(LEDGER, renderLedger(counted, fullOnly, masterOnly));
console.log(`${LEDGER}: ${counted.length} files`);
