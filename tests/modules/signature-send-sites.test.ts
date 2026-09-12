import { describe, expect, test } from "bun:test";

// WHERE THE SIGNATURE IS ATTACHED, read off the sources, because the property that matters is a
// PLACEMENT one and no unit test of `attachSignature` can see it (#616).
//
// Four call sites attach a signature. Three of them send ONE message — the handoff's farewell on
// the proactive path, the proactive message itself, and both playground surfaces — and they say so
// by passing a one-element array, which is what makes `all` and `once` indistinguishable there.
// The fourth, `deliverReply`, is the only one that splits.
//
// A call site that grew a second element, or that started re-splitting its own text, would make a
// follow-up arrive with the signature repeated inside one message: the operator's own preview
// surface showing something the customer never receives, which is the divergence the playground
// exists to avoid.
const SOURCES = {
  nudge: await Bun.file("src/graph/nudge.ts").text(),
  playground: await Bun.file("src/modules/playground/service.ts").text(),
  split: await Bun.file("src/modules/split/service.ts").text(),
};

function calls(source: string): string[] {
  const out: string[] = [];
  let at = source.indexOf("attachSignature(");
  while (at !== -1) {
    out.push(source.slice(at, source.indexOf(")", at) + 1));
    at = source.indexOf("attachSignature(", at + 1);
  }
  return out;
}

describe("the single-message sends pass a one-element array", () => {
  for (const [name, expected] of [
    ["nudge", 1],
    ["playground", 2],
  ] as const) {
    test(`${name}: ${expected} call site, each on one message`, () => {
      const found = calls(SOURCES[name]);
      expect(found).toHaveLength(expected);
      for (const c of found) {
        // `[text]`, `[reply]` — a literal one-element array, not a chunk array.
        expect(c).toMatch(/attachSignature\(\s*\[[A-Za-z][A-Za-z0-9_]*\]/);
      }
    });
  }

  // And they hand over the WHOLE config rather than naming fields, which is what stops one of them
  // from being left behind when a fifth field arrives.
  test("they pass the config object, not loose fields", () => {
    for (const name of ["nudge", "playground"] as const) {
      for (const c of calls(SOURCES[name])) {
        expect(c).not.toContain(".position");
        expect(c).not.toContain(".separator");
        expect(c).not.toContain(".frequency");
      }
    }
  });
});

describe("deliverReply is the only site that splits", () => {
  test("it attaches to the raw chunk array, and signs its retry separately", () => {
    const found = calls(SOURCES.split);
    // The split-off branch (one message), the split branch (the chunk array), and the consolidated
    // retry (one message again).
    expect(found).toHaveLength(3);
    expect(found.some((c) => c.includes("rawChunks"))).toBe(true);
    expect(found.some((c) => c.includes("[owedRaw]"))).toBe(true);
    // THE RETRY IS BUILT FROM THE RAW REMAINDER. Joining the signed chunks put the badge once per
    // balloon inside a single message (review round 1 of #617).
    expect(SOURCES.split).toContain("const owedRaw = rawChunks");
  });
});
