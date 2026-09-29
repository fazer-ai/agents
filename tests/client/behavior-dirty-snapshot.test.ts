import { describe, expect, test } from "bun:test";

// Every Behavior block the editor can edit is in the tab's dirty snapshot. `sectionSnap.behavior`
// lights the tab's dot, enables Discard and arms the navigation guard. A block the save WRITES but
// the snapshot does not READ is worse than an un-editable one: the operator edits it, sees no dirty
// marker, leaves, and the edit is gone. The rule is per block, so a new block is checked here.

const PAGE = await Bun.file(
  "src/client/pages/agents/AgentEditorPage.tsx",
).text();

// The blocks the Behavior SAVE writes through a form-state pair (`<block>ToForm` / `<block>ToStored`),
// read off the writer itself: the shape a block takes once it holds more than a switch.
// The plain shorthand blocks (`debounce,`, `stt,`, ...) are not covered here: the payload names them
// the same way the snapshot does, so there is no second spelling to diverge.
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

  // NOTE: the scan has to find something, or an empty answer above is the scan failing rather than
  // the code passing.
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

// Every Behavior block the save writes is also read back, on all three paths (`applyAgent`,
// `applyBehavior`, `revertBehavior`) and the snapshot. A block missing from them reopens as an
// empty field, and the next save of any behaviour setting writes that empty value over the stored
// one. An inline literal like `signature: { text, position }` is neither a `ToStored` pair nor a
// shorthand, so this scan reads the writer's TOP-LEVEL KEYS, which a new block cannot avoid having.
// Keys whose form state is spelled differently are listed, not pattern-matched: guessing at aliases
// would quietly excuse the next real gap.
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

  // NOTE: the same rule as the pair-based fence, asked of EVERY key. Both are kept: that one names
  // the pair shape, this one catches a block in any other shape.
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
