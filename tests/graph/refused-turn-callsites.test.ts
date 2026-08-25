import { describe, expect, test } from "bun:test";

// THE RULE THE ROLLBACK DEPENDS ON, AND THE ONE A PATCH CAN SILENTLY BREAK.
//
// `undoRefusedTurn` cannot be reached from inside `runAgentNudge`'s refusals unless each of them goes
// out through `refuse`. There are eight of them today, spread over two hundred lines, and the ninth
// will be written by someone adding a gate, copying the line above it, which is what a bare
// `return "stale";` looks like. Nothing fails when they do: the send is still suppressed, the outcome
// is still right, and the only symptom is the next turn answering about a message nobody received,
// which is the defect issue #251 opened for.
//
// So the fence is on the SPELLING, at the position where it matters: below the point where a turn has
// been generated, a refusal is not a `return`, it is a `refuse`.

// The two outcomes a post-generation refusal can carry. "silent", "messaged", "noted" and the rest
// are not refusals: the turn reached its end and something (a message, a note, a decision) stands.
const REFUSAL_OUTCOMES = ["stale", "live-unavailable"] as const;

const BARE = new RegExp(`return "(?:${REFUSAL_OUTCOMES.join("|")})";`, "g");

// Everything above the closure is a refusal BEFORE the invoke, where there is no generated turn to
// take back and `refuse` would be a checkpointer round trip for nothing.
export function bareRefusalsAfterTheRollback(source: string): string[] {
  const at = source.indexOf("const refuse = async (");
  if (at === -1) return ["the `refuse` closure is gone"];
  return (source.slice(at).match(BARE) ?? []).map((m) => m.trim());
}

describe("every post-generation refusal in runAgentNudge rolls the turn back", () => {
  // The control: a sweep that finds nothing passes whether or not it is looking at anything, so the
  // predicate is shown an offender first.
  test("the predicate flags a bare refusal written below the closure", () => {
    const withOffender = `
  const refuse = async (outcome) => outcome;
  if (!(await stillWanted())) return refuse("stale");
  if (owned === "gone") return "live-unavailable";
`;
    expect(bareRefusalsAfterTheRollback(withOffender)).toEqual([
      'return "live-unavailable";',
    ]);
  });

  test("and says so when the closure itself was removed", () => {
    expect(bareRefusalsAfterTheRollback("if (x) return 'stale';")).toEqual([
      "the `refuse` closure is gone",
    ]);
  });

  test("a refusal above the closure is not its business", () => {
    const before = `
  if (!(await stillWanted())) return "stale";
  const refuse = async (outcome) => outcome;
`;
    expect(bareRefusalsAfterTheRollback(before)).toEqual([]);
  });

  test("nudge.ts has none", async () => {
    const source = await Bun.file("src/graph/nudge.ts").text();
    expect(bareRefusalsAfterTheRollback(source)).toEqual([]);
    // …and the sweep is looking at something. A rule whose subject can become empty starts passing
    // for the wrong reason the day the refusals are restructured.
    const at = source.indexOf("const refuse = async (");
    // A floor, not a census: more sites routed through `refuse` is a better state, never a worse one,
    // so pinning the exact number would only cost a second edit to a PR that adds a gate correctly.
    // What it guards is the subject going EMPTY, which is how a sweep starts passing blind.
    const routed = source.slice(at).match(/return refuse\("/g) ?? [];
    expect(routed.length).toBeGreaterThanOrEqual(8);
  });
});
