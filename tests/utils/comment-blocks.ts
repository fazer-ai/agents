import { commentSpans } from "@/tests/utils/source-text";

// What the comment sweep counts, shared by the sweep and by the script that rewrites its ledger.

export const SWEPT_ROOTS = ["src", "tests", "workers", "scripts"] as const;

// Written by a tool, and rewritten on the next run of it.
const GENERATED = new Set(["workers/cdn/worker-configuration.d.ts"]);

export const BLOCK_LINE_CEILING = 8;

// A block that has a reason to break a rule says so in its own text, with the reason after the colon.
export const WAIVER = /\bcomment-waiver:[ \t]*\S/;

const PROVENANCE =
  /(?<![\w&/#])#\d+\b|\bPR\s*#?\d+\b|\bissues?\s+#\d+\b|\breview,?\s+round\b|\bround\s+\d+\b|\brodada\s+\d+\b|github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/i;
const OWED_WORK = /\b(TODO|FIXME):/;
const NARRATION =
  /\b(measured|medido|real case|caso real|used to|before this change|originally|turned out|we found)\b/i;
// Text a tool reads rather than a person: a suppression, a type directive, an i18n key, an edition marker.
const DIRECTIVE =
  /^(\/\/|\/\*)\s*(biome-ignore|@ts-|t\(|@(full|free|master)-only|\/ <reference|eslint)/;

export type CommentBlock = { line: number; lines: number; text: string };

type Piece = { line: number; text: string; newlinesBefore: number };

// The span can hold several comments separated by whitespace; each comes out on its own.
function pieces(src: string, start: number, end: number): Piece[] {
  const out: Piece[] = [];
  let line = src.slice(0, start).split("\n").length;
  let at = start;
  let newlines = 0;
  while (at < end) {
    const ch = src[at];
    if (ch === "\n") {
      line++;
      newlines++;
      at++;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\r") {
      at++;
      continue;
    }
    const close = src.startsWith("/*", at)
      ? src.indexOf("*/", at + 2) + 2
      : src.indexOf("\n", at);
    const stop = close <= at || close > end ? end : close;
    const text = src.slice(at, stop);
    out.push({ line, text, newlinesBefore: out.length ? newlines : Infinity });
    line += text.split("\n").length - 1;
    newlines = 0;
    at = stop;
  }
  return out;
}

// Consecutive `//` lines are one block, which is how a reader sees them. A blank line, code, a block
// comment or a directive ends it; a block comment is a block of its own.
export function commentBlocks(src: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  for (const [start, end] of commentSpans(src)) {
    let current: CommentBlock | null = null;
    for (const piece of pieces(src, start, end)) {
      const joins =
        current !== null &&
        piece.text.startsWith("//") &&
        piece.newlinesBefore === 1;
      if (!joins && current) {
        blocks.push(current);
        current = null;
      }
      if (DIRECTIVE.test(piece.text)) {
        if (current) blocks.push(current);
        current = null;
        continue;
      }
      if (current) {
        current.text += `\n${piece.text}`;
        current.lines += 1;
      } else {
        current = {
          line: piece.line,
          lines: piece.text.split("\n").length,
          text: piece.text,
        };
      }
      if (!piece.text.startsWith("//")) {
        blocks.push(current);
        current = null;
      }
    }
    if (current) blocks.push(current);
  }
  return blocks;
}

// The words of a comment, without its delimiters.
const prose = (text: string) =>
  text
    .replace(/^\/\*+|\*+\/$/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*(\/\/+|\*+)/, ""))
    .join("\n");

const waived = (block: CommentBlock) => WAIVER.test(prose(block.text));

// An issue, PR or review round cited as where the code came from. A `TODO:`/`FIXME:` line may name
// the issue that tracks the work it owes.
export function citesProvenance(block: CommentBlock): boolean {
  if (waived(block)) return false;
  return block.text
    .split("\n")
    .some((line) => PROVENANCE.test(line) && !OWED_WORK.test(line));
}

export function overCeiling(block: CommentBlock): boolean {
  return block.lines > BLOCK_LINE_CEILING && !waived(block);
}

// Reported, never enforced: the terms also appear in comments that state a present fact.
export function narratesHistory(block: CommentBlock): boolean {
  return NARRATION.test(block.text) && !waived(block);
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
      if (!GENERATED.has(`${root}/${rel}`)) paths.push(`${root}/${rel}`);
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

// Counts above the ledger's entry, which the rewrite refuses: the ledger only goes down.
export function raisedEntries(
  counted: Array<[string, FileCounts]>,
  ledger: Record<string, FileCounts>,
): string[] {
  return counted
    .filter(([path, [p, l]]) => {
      const [was, wasLong] = ledger[path] ?? [0, 0];
      return p > was || l > wasLong;
    })
    .map(
      ([path, counts]) =>
        `${path}: [${counts}] is above the ledger's [${ledger[path] ?? [0, 0]}]`,
    );
}
