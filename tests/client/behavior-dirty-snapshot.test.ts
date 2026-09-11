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

// EVERY BEHAVIOR BLOCK THE SAVE WRITES IS ALSO READ BACK, ON ALL THREE PATHS.
//
// The fence above guards one half of the contract and the review of #599 found the other half open.
// `signature` was written by the save, absent from the snapshot AND absent from `applyAgent`,
// `applyBehavior` and `revertBehavior` — so the operator configured a signature, reopened the agent
// to an empty field, and the next save of ANY behaviour setting wrote that empty value over the one
// they had stored. Silent data loss with nothing wrong on screen, which is the same failure shape
// the snapshot fence exists for, one step earlier.
//
// It slipped past that fence for a reason worth naming, because it is the fence's own stated
// assumption: the scan reads the writer through `<block>ToStored(`, and its comment argues the plain
// shorthand blocks need no cover since "the payload names them the same way the snapshot does".
// `signature: { text: ..., position: ... }` is neither — an inline object literal that reads several
// pieces of state under a block name of its own. So the scan below reads the writer's TOP-LEVEL KEYS
// instead of one spelling of them, and it is the keys that a new block cannot avoid having.
//
// Two of those keys name a block whose form state is spelled differently, and they are listed rather
// than pattern-matched: a rule that guessed at aliases would quietly excuse the next real gap.
const STATE_ALIASES: Record<string, string[]> = {
  // One stored block, assembled from two independent pieces of form state.
  availability: ["awayEnabled", "awayMessage"],
  // Named after the block the save writes; the form state behind it is `observation`.
  monitoring: ["observation"],
};

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
  const fn = braceBlockAt(source, source.indexOf("function buildSettings"));
  const ret = braceBlockAt(fn, fn.indexOf("return {"));
  const keys: string[] = [];
  let depth = 0;
  for (const m of ret.matchAll(/[{}]|^[ \t]*([A-Za-z_]\w*)\s*:/gm)) {
    if (m[0] === "{" || m[0] === "}") depth += m[0] === "{" ? 1 : -1;
    else if (depth === 1 && m[1]) keys.push(m[1]);
  }
  return keys;
}

// A block is hydrated when the path assigns the state it is made of. Reading the ALIAS targets, not
// the stored name, is what keeps `availability` from reading as a gap and what would make a genuinely
// missing `awayMessage` read as one.
export function blocksMissingFromHydration(source: string): string[] {
  const paths = [
    "const applyAgent = useCallback",
    "const applyBehavior = useCallback",
    "const revertBehavior = () =>",
  ].map((needle) => braceBlockAt(source, source.indexOf(needle)));
  return savedBlockKeys(source).filter((k) => {
    const names = STATE_ALIASES[k] ?? [k];
    return paths.some(
      (body) => !names.every((n) => new RegExp(`\\bb\\.${n}\\b`).test(body)),
    );
  });
}

export function blocksMissingFromSnapshotByKey(source: string): string[] {
  const snap = snapshotBody(source);
  return savedBlockKeys(source).filter((k) => {
    const names = STATE_ALIASES[k] ?? [k];
    return !names.every((n) => new RegExp(`\\b${n}\\b`).test(snap));
  });
}

describe("the Behavior tab reads back everything it writes", () => {
  test("every saved block is restored on all three hydration paths", () => {
    expect(blocksMissingFromHydration(PAGE)).toEqual([]);
  });

  // The same rule the fence above enforces, asked of EVERY key rather than only the `ToStored` pairs.
  // Kept beside it instead of replacing it: that one names the pair shape a new block is likely to
  // use, and this one catches the block that arrives in any other shape.
  test("every saved block is in the dirty snapshot, whatever shape it was written in", () => {
    expect(blocksMissingFromSnapshotByKey(PAGE)).toEqual([]);
  });

  test("the scan actually sees the blocks", () => {
    const keys = savedBlockKeys(PAGE);
    expect(keys.length).toBeGreaterThanOrEqual(15);
    expect(keys).toContain("signature");
    expect(keys).toContain("availability");
  });

  // POSITIVE CONTROL over both predicates: an inline-literal block, which is exactly the shape the
  // pair-based scan above cannot see, saved and then read back nowhere.
  test("an inline-literal block that is never read back is caught", () => {
    const broken = `
      function buildSettings(): Record<string, unknown> {
        return {
          memory: memoryToStored(memory),
          newBlock: { text: newBlock.text.trim() },
        };
      }
      const applyAgent = useCallback((a: Agent) => { setMemory(b.memory); });
      const applyBehavior = useCallback((a: Agent) => { setMemory(b.memory); });
      const revertBehavior = () => { setMemory(b.memory); };
      behavior: JSON.stringify({
        memory,
      }),
    `;
    expect(savedBlocksMissingFromSnapshot(broken)).toEqual([]);
    expect(blocksMissingFromSnapshotByKey(broken)).toEqual(["newBlock"]);
    expect(blocksMissingFromHydration(broken)).toEqual(["newBlock"]);
  });

  test("and the same fixture, read back everywhere, is clean", () => {
    const fixed = `
      function buildSettings(): Record<string, unknown> {
        return {
          memory: memoryToStored(memory),
          newBlock: { text: newBlock.text.trim() },
        };
      }
      const applyAgent = useCallback((a: Agent) => { setMemory(b.memory); setNewBlock(b.newBlock); });
      const applyBehavior = useCallback((a: Agent) => { setMemory(b.memory); setNewBlock(b.newBlock); });
      const revertBehavior = () => { setMemory(b.memory); setNewBlock(b.newBlock); };
      behavior: JSON.stringify({
        memory,
        newBlock,
      }),
    `;
    expect(blocksMissingFromSnapshotByKey(fixed)).toEqual([]);
    expect(blocksMissingFromHydration(fixed)).toEqual([]);
  });
});
