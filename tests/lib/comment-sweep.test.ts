import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  BLOCK_LINE_CEILING,
  citesProvenance,
  commentBlocks,
  narratesHistory,
  overCeiling,
  overLedger,
  raisedEntries,
  staleEntries,
  sweptFiles,
} from "@/tests/utils/comment-blocks";
import { COMMENT_LEDGER } from "./comment-ledger";

// A comment states what is true of the code now. Where the code came from belongs to the commit, the
// PR and the issue; a long explanation belongs to the module's doc. Files the ledger lists may keep
// what they had and no more, and the ledger only goes down: `bun run comments:ledger` rewrites it.
//
// Only the master tree holds the ledger to the exact count, since an edition strips blocks and files.
const MASTER = existsSync("tooling/derivation");

const block = (text: string) => {
  const [first] = commentBlocks(text);
  if (!first) throw new Error("no comment block");
  return first;
};

describe("what the sweep reads as provenance", () => {
  test("an issue, a PR or a review round cited in a comment", () => {
    for (const text of [
      "// Closed in #123.",
      "// See issue #45 for the case.",
      "// PR #9 moved it here.",
      "/* review round 2 asked for this */",
      "// The fix from round 3.",
      "// Fixed in https://github.com/acme/app/pull/123",
      "/* see https://github.com/acme/app/issues/9#issuecomment-1 */",
    ]) {
      expect(citesProvenance(block(text))).toBe(true);
    }
  });

  test("a TODO or FIXME may name the issue that tracks the owed work", () => {
    expect(citesProvenance(block("// TODO: drop the column (#149)."))).toBe(
      false,
    );
    expect(
      citesProvenance(block("// TODO: drop it (#149).\n// Came from #120.")),
    ).toBe(true);
  });

  test("a number that is not a reference, and a reference outside a comment", () => {
    expect(citesProvenance(block("// Color is &#123; in the entity."))).toBe(
      false,
    );
    expect(citesProvenance(block("// Five rounds of retries."))).toBe(false);
    expect(
      commentBlocks('const url = "https://x.test/issues/123#456";'),
    ).toEqual([]);
    expect(
      commentBlocks('const url = "https://github.com/acme/app/pull/123";'),
    ).toEqual([]);
    expect(
      citesProvenance(
        block("// Docs: https://github.com/acme/app/blob/main/x.md"),
      ),
    ).toBe(false);
  });

  test("a waiver with a reason exempts the block, and one without a reason does not", () => {
    expect(
      citesProvenance(
        block("// comment-waiver: the upstream bug id is the fix.\n// #77"),
      ),
    ).toBe(false);
    expect(citesProvenance(block("// comment-waiver:\n// #77"))).toBe(true);
  });
});

describe("each comment is judged on its own", () => {
  test("a block comment after line comments is still read", () => {
    const blocks = commentBlocks("// intro\n/* fixed in #123 */\n");
    expect(blocks).toHaveLength(2);
    expect(blocks.some(citesProvenance)).toBe(true);
  });

  test("prose after a block directive is still read", () => {
    const blocks = commentBlocks(
      "/* biome-ignore lint/x: reason */\n// fixed in #12\n",
    );
    expect(blocks.map((b) => b.text)).toEqual(["// fixed in #12"]);
    expect(blocks.some(citesProvenance)).toBe(true);
  });

  test("two block comments are two blocks, however close", () => {
    const five = `/*\n${" * x\n".repeat(4)} */`;
    const blocks = commentBlocks(`${five}\n${five}\n`);
    expect(blocks).toHaveLength(2);
    expect(commentBlocks("/* one */\n// two\n")).toHaveLength(2);
    expect(blocks.some(overCeiling)).toBe(false);
  });

  test("a directive between prose ends the block before it", () => {
    const five = "// x\n".repeat(5);
    const blocks = commentBlocks(
      `${five}// biome-ignore lint/x: reason\n${five}`,
    );
    expect(blocks).toHaveLength(2);
    expect(blocks.some(overCeiling)).toBe(false);
    const waived = commentBlocks(
      "// comment-waiver: upstream id\n// biome-ignore lint/x: reason\n// fixed in #12\n",
    );
    expect(waived.some(citesProvenance)).toBe(true);
  });

  test("an empty waiver in a block comment is no waiver", () => {
    expect(citesProvenance(block("/* Fixed in #123. comment-waiver: */"))).toBe(
      true,
    );
    expect(
      citesProvenance(
        block("/* Fixed in #123. comment-waiver: upstream id */"),
      ),
    ).toBe(false);
  });
});

describe("the line ceiling", () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `// line ${i + 1}`).join("\n");

  test(`${BLOCK_LINE_CEILING} lines pass and one more does not`, () => {
    expect(overCeiling(block(lines(BLOCK_LINE_CEILING)))).toBe(false);
    expect(overCeiling(block(lines(BLOCK_LINE_CEILING + 1)))).toBe(true);
  });

  test("a blank line or code between comments starts a new block", () => {
    expect(commentBlocks(`${lines(5)}\n\n${lines(5)}`)).toHaveLength(2);
    expect(
      commentBlocks(`${lines(5)}\nconst a = 1;\n${lines(5)}`),
    ).toHaveLength(2);
  });

  test("a block comment counts its own lines", () => {
    const text = `/*\n${Array.from({ length: BLOCK_LINE_CEILING }, () => " * x").join("\n")}\n */`;
    expect(overCeiling(block(text))).toBe(true);
  });

  test("a directive is not prose and is never counted", () => {
    expect(commentBlocks("// biome-ignore lint/x: reason #12")).toEqual([]);
    expect(commentBlocks("// @full-only\nconst a = 1;")).toEqual([]);
  });
});

describe("history narration is reported, not enforced", () => {
  test("the detector reads a past account", () => {
    expect(
      narratesHistory(block("// Measured on the probe: 45 buffers.")),
    ).toBe(true);
    expect(narratesHistory(block("// Returns the row, or null."))).toBe(false);
  });
});

describe("the ledger", () => {
  const clean = "// Returns the row.\nexport const a = 1;\n";
  const cited = "// Came from #12.\nexport const b = 1;\n";

  test("a file over its entry, or with none, is reported", () => {
    expect(overLedger([["a.ts", clean]], {})).toEqual([]);
    expect(overLedger([["b.ts", cited]], { "b.ts": [1, 0] })).toEqual([]);
    expect(overLedger([["b.ts", cited]], {})).toHaveLength(1);
    expect(overLedger([["b.ts", cited]], { "b.ts": [0, 0] })).toHaveLength(1);
    const long = `${"// x\n".repeat(BLOCK_LINE_CEILING + 1)}export const c = 1;\n`;
    expect(overLedger([["c.ts", long]], { "c.ts": [0, 1] })).toEqual([]);
    expect(overLedger([["c.ts", long]], { "c.ts": [0, 0] })).toHaveLength(1);
  });

  test("a rewrite may lower an entry and never raise one", () => {
    expect(raisedEntries([["b.ts", [1, 0]]], { "b.ts": [2, 0] })).toEqual([]);
    expect(raisedEntries([["b.ts", [1, 1]]], { "b.ts": [1, 0] })).toHaveLength(
      1,
    );
    expect(raisedEntries([["new.ts", [1, 0]]], {})).toHaveLength(1);
  });

  test("an entry above the file's count, or for a missing file, is stale", () => {
    expect(staleEntries([["b.ts", cited]], { "b.ts": [1, 0] })).toEqual([]);
    expect(staleEntries([["b.ts", clean]], { "b.ts": [1, 0] })).toHaveLength(1);
    expect(staleEntries([], { "gone.ts": [1, 0] })).toEqual([
      "gone.ts: not in the tree",
    ]);
  });
});

describe("the tree against its ledger", () => {
  const tree = async () =>
    Promise.all(
      (await sweptFiles()).map(
        async (path): Promise<[string, string]> => [
          path,
          await Bun.file(path).text(),
        ],
      ),
    );

  test("no file carries more offending comments than the ledger allows", async () => {
    const files = await tree();
    expect(overLedger(files, COMMENT_LEDGER)).toEqual([]);
    // A scan that stopped reading comments would report a clean tree.
    const blocks = files.reduce(
      (n, [, src]) => n + commentBlocks(src).length,
      0,
    );
    expect(blocks).toBeGreaterThan(10_000);
  });

  test.skipIf(!MASTER)(
    "the ledger says each file's current count, so a cleanup has to lower it",
    async () => {
      expect(staleEntries(await tree(), COMMENT_LEDGER)).toEqual([]);
    },
  );

  test.skipIf(!process.env.COMMENT_SWEEP_REPORT)(
    "report: blocks that narrate history",
    async () => {
      const hits: string[] = [];
      for (const path of await sweptFiles()) {
        for (const b of commentBlocks(await Bun.file(path).text())) {
          if (narratesHistory(b)) hits.push(`${path}:${b.line}`);
        }
      }
      console.info(`${hits.length} blocks narrate history\n${hits.join("\n")}`);
    },
  );
});
