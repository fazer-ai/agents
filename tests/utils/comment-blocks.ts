import { commentSpans } from "@/tests/utils/source-text";

// What the comment sweep counts, shared by the sweep and by the script that rewrites its ledger.

export const SWEPT_ROOTS = ["src", "tests", "workers", "scripts"] as const;

export const BLOCK_LINE_CEILING = 8;

// A block that has a reason to break a rule says so in its own text, with the reason after the colon.
export const WAIVER = /\bcomment-waiver:[ \t]*[^\s/]/;

const PROVENANCE =
  /(?<![\w&/#])#\d+\b|\bPR\s*#?\d+\b|\bissues?\s+#\d+\b|\breview,?\s+round\b|\bround\s+\d+\b|\brodada\s+\d+\b/i;
const OWED_WORK = /\b(TODO|FIXME):/;
const NARRATION =
  /\b(measured|medido|real case|caso real|used to|before this change|originally|turned out|we found)\b/i;
// Text a tool reads rather than a person: a suppression, a type directive, an i18n key, an edition marker.
const DIRECTIVE =
  /^(\/\/|\/\*)\s*(biome-ignore|@ts-|t\(|@(full|free|master)-only|\/ <reference|eslint)/;

export type CommentBlock = { line: number; lines: number; text: string };

// Consecutive `//` lines are one block, which is how a reader sees them; a blank line or a directive
// ends it.
export function commentBlocks(src: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  for (const [start, end] of commentSpans(src)) {
    const text = src.slice(start, end);
    const first = src.slice(0, start).split("\n").length;
    if (!text.startsWith("//")) {
      if (!DIRECTIVE.test(text)) {
        blocks.push({ line: first, lines: text.split("\n").length, text });
      }
      continue;
    }
    let current: CommentBlock | null = null;
    text.split("\n").forEach((raw, i) => {
      const line = raw.trim();
      if (!line.startsWith("//") || DIRECTIVE.test(line)) {
        if (current) blocks.push(current);
        current = null;
        return;
      }
      if (current) {
        current.text += `\n${line}`;
        current.lines += 1;
      } else {
        current = { line: first + i, lines: 1, text: line };
      }
    });
    if (current) blocks.push(current);
  }
  return blocks;
}

// An issue, PR or review round cited as where the code came from. A `TODO:`/`FIXME:` line may name
// the issue that tracks the work it owes.
export function citesProvenance(block: CommentBlock): boolean {
  if (WAIVER.test(block.text)) return false;
  return block.text
    .split("\n")
    .some((line) => PROVENANCE.test(line) && !OWED_WORK.test(line));
}

export function overCeiling(block: CommentBlock): boolean {
  return block.lines > BLOCK_LINE_CEILING && !WAIVER.test(block.text);
}

// Reported, never enforced: the terms also appear in comments that state a present fact.
export function narratesHistory(block: CommentBlock): boolean {
  return NARRATION.test(block.text) && !WAIVER.test(block.text);
}

export type FileCounts = [provenance: number, long: number];

export function countFile(src: string): {
  counts: FileCounts;
  offending: number[];
} {
  let provenance = 0;
  let long = 0;
  const offending: number[] = [];
  for (const block of commentBlocks(src)) {
    const p = citesProvenance(block);
    const l = overCeiling(block);
    if (p) provenance++;
    if (l) long++;
    if (p || l) offending.push(block.line);
  }
  return { counts: [provenance, long], offending };
}

export async function sweptFiles(): Promise<string[]> {
  const { Glob } = await import("bun");
  const { existsSync } = await import("node:fs");
  const paths: string[] = [];
  for (const root of SWEPT_ROOTS) {
    if (!existsSync(root)) continue;
    for await (const rel of new Glob("**/*.{ts,tsx}").scan(root)) {
      paths.push(`${root}/${rel}`);
    }
  }
  return paths.sort();
}

// Files carrying more than their entry allows; a file with no entry is allowed nothing.
export function overLedger(
  files: Array<[string, string]>,
  ledger: Record<string, FileCounts>,
): string[] {
  const over: string[] = [];
  for (const [path, src] of files) {
    const { counts, offending } = countFile(src);
    const [p, l] = ledger[path] ?? [0, 0];
    if (counts[0] > p || counts[1] > l) {
      over.push(
        `${path}: [${counts}] against [${p}, ${l}] (blocks at lines ${offending.join(", ")})`,
      );
    }
  }
  return over;
}

// Entries that no longer say the file's count, or name a file that is gone.
export function staleEntries(
  files: Array<[string, string]>,
  ledger: Record<string, FileCounts>,
): string[] {
  const byPath = new Map(files);
  const stale: string[] = [];
  for (const [path, [p, l]] of Object.entries(ledger)) {
    const src = byPath.get(path);
    if (src === undefined) {
      stale.push(`${path}: not in the tree`);
      continue;
    }
    const { counts } = countFile(src);
    if (counts[0] !== p || counts[1] !== l) {
      stale.push(`${path}: ledger [${p}, ${l}], tree [${counts}]`);
    }
  }
  return stale;
}
