import { describe, expect, test } from "bun:test";

// EVERY BEHAVIOR BLOCK THE EDITOR CAN EDIT IS IN THE TAB'S DIRTY SNAPSHOT.
//
// `sectionSnap.behavior` is what the unsaved-changes machinery compares against: it lights the tab's
// dot, enables Discard, and arms the guard that stops the operator navigating away. A block the save
// WRITES but the snapshot does not READ is worse than an un-editable one, because everything looks
// normal — the operator edits only that block, sees no dirty marker, leaves the page, and the edit is
// gone with nothing having gone wrong on screen.
//
// It is a rule enforced per block rather than in one place, which is the shape that grows an N+1:
// seventeen blocks were in the snapshot and the eighteenth (`modelFallback`) went in with its state,
// its save and its section, and not this. Review found it. The next one is found here instead.

const PAGE = await Bun.file(
  "src/client/pages/agents/AgentEditorPage.tsx",
).text();

// The blocks the Behavior SAVE writes THROUGH A FORM-STATE PAIR, read off the writer itself. That
// pair (`<block>ToForm` / `<block>ToStored`) is the shape a block grows the moment it holds more than
// a switch, and it is the shape the last three blocks to arrive all used — so it is what a new block
// will look like, and what this fence can name without a list.
//
// The plain shorthand blocks in the same payload (`debounce,`, `stt,`, …) are NOT covered: they are
// their own state object and the payload names them the same way the snapshot does, so there is no
// second spelling to diverge. Said out loud rather than implied, because a fence that reads as
// covering everything is worse than one that says what it leaves out.
export function blocksTheBehaviorSaveWrites(source: string): string[] {
  const keys = new Set<string>();
  for (const m of source.matchAll(/(\w+):\s*\w+ToStored\(/g)) {
    keys.add(m[1] as string);
  }
  return [...keys].sort();
}

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

export function savedBlocksMissingFromSnapshot(source: string): string[] {
  const snap = snapshotBody(source);
  return blocksTheBehaviorSaveWrites(source).filter(
    (k) => !new RegExp(`\\b${k}\\b`).test(snap),
  );
}

describe("the Behavior tab's dirty snapshot", () => {
  test("every block the save writes is compared for dirtiness", () => {
    expect(savedBlocksMissingFromSnapshot(PAGE)).toEqual([]);
  });

  // The scan has to find something, or the empty answer above is the scan failing rather than the
  // code passing — the failure mode of every fence that reads source.
  test("the scan actually sees the blocks", () => {
    const written = blocksTheBehaviorSaveWrites(PAGE);
    expect(written.length).toBeGreaterThanOrEqual(3);
    expect(written).toContain("memory");
    expect(written).toContain("modelFallback");
    expect(snapshotBody(PAGE)).toContain("modelFallback");
  });

  // POSITIVE CONTROL, over the predicate rather than the tree: a fence with no offender left passes
  // for either reason and cannot tell them apart.
  test("a block that is saved and not compared is caught", () => {
    const broken = `
      const payload = {
        memory: memoryToStored(memory),
        newBlock: newBlockToStored(newBlock),
      };
      behavior: JSON.stringify({
        memory,
      }),
    `;
    expect(savedBlocksMissingFromSnapshot(broken)).toEqual(["newBlock"]);
  });

  test("and the same fixture with the snapshot complete is clean", () => {
    const fixed = `
      const payload = {
        memory: memoryToStored(memory),
        newBlock: newBlockToStored(newBlock),
      };
      behavior: JSON.stringify({
        memory,
        newBlock,
      }),
    `;
    expect(savedBlocksMissingFromSnapshot(fixed)).toEqual([]);
  });
});
