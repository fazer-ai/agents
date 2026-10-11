import { describe, expect, test } from "bun:test";

// The dirty snapshot (`sectionSnap.behavior`) lights the tab's dot, enables Discard and arms the
// navigation guard. A block the save writes and the snapshot does not read is edited with no dirty
// marker, and the edit is lost on leaving. Read off the source: no run can edit every block
// generically, and the next block is the one this has to catch.
const PAGE = await Bun.file(
  "src/client/pages/agents/AgentEditorPage.tsx",
).text();

// Keys whose form state is spelled differently from the stored block.
const STATE_ALIASES: Record<string, string[]> = {
  // One stored block, assembled from two independent pieces of form state.
  availability: ["awayEnabled", "awayMessage"],
  // Named after the block the save writes; the form state behind it is `observation`.
  monitoring: ["observation"],
};

export function snapshotBody(source: string): string {
  const at = source.indexOf("behavior: JSON.stringify({");
  if (at < 0) return "";
  const open = source.indexOf("{", source.indexOf("JSON.stringify(", at));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

function braceBlockAt(source: string, from: number): string {
  const open = source.indexOf("{", from);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return "";
}

export function savedBlockKeys(source: string): string[] {
  const fn = braceBlockAt(source, source.indexOf("function behaviorBlocksOf"));
  const ret = braceBlockAt(fn, fn.indexOf("return {"));
  const keys: string[] = [];
  let depth = 0;
  for (const m of ret.matchAll(/[{}]|^[ \t]*([A-Za-z_]\w*)\s*:/gm)) {
    if (m[0] === "{" || m[0] === "}") depth += m[0] === "{" ? 1 : -1;
    else if (depth === 1 && m[1]) keys.push(m[1]);
  }
  return keys;
}

export function blocksMissingFromSnapshotByKey(source: string): string[] {
  const snap = snapshotBody(source);
  return savedBlockKeys(source).filter((k) => {
    const names = STATE_ALIASES[k] ?? [k];
    return !names.every((n) => new RegExp(`\\b${n}\\b`).test(snap));
  });
}

describe("the Behavior tab's dirty snapshot", () => {
  test("every saved block is in the dirty snapshot, whatever shape it was written in", () => {
    expect(blocksMissingFromSnapshotByKey(PAGE)).toEqual([]);
  });

  test("the scan actually sees the blocks", () => {
    const keys = savedBlockKeys(PAGE);
    expect(keys.length).toBeGreaterThanOrEqual(15);
    expect(keys).toContain("signature");
    expect(keys).toContain("availability");
  });

  // POSITIVE CONTROL over the predicate: an inline-literal block, saved and compared nowhere.
  test("an inline-literal block that is not compared is caught, and the complete one is clean", () => {
    const save = `
      function behaviorBlocksOf(): Record<string, unknown> {
        return {
          memory: memoryToStored(memory),
          newBlock: { text: newBlock.text.trim() },
        };
      }`;
    expect(
      blocksMissingFromSnapshotByKey(
        `${save}\n      behavior: JSON.stringify({\n        memory,\n      }),`,
      ),
    ).toEqual(["newBlock"]);
    expect(
      blocksMissingFromSnapshotByKey(
        `${save}\n      behavior: JSON.stringify({\n        memory,\n        newBlock,\n      }),`,
      ),
    ).toEqual([]);
  });
});
