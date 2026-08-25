import { describe, expect, test } from "bun:test";

// THE RULE THE ROLLBACK DEPENDS ON, AND THE ONE A PATCH CAN SILENTLY BREAK.
//
// `undoRefusedTurn` cannot be reached from inside a turn's refusals unless each of them goes out
// through `refuse`. There are eight in `runAgentNudge` and nine in `runLoadedTurn`, spread over
// hundreds of lines, and the next one will be written by someone adding a gate and copying the line
// above it — which is what a bare `return "stale";` looks like. Nothing fails when they do: the send
// is still suppressed, the outcome is still right, and the only symptom is the next turn answering
// about a message nobody received, which is the defect issues #251 and #315 opened for.
//
// So the fence is on the SPELLING, at the position where it matters: below the point where a turn has
// been generated, a refusal is not a `return`, it is a `refuse`.
//
// TWO SPELLINGS, and the second is why this predicate does not just look for `return "x";`. A refusal
// can also ride a ternary — `return attachments.sent ? "posted" : "stale";` — and `runLoadedTurn` has
// two of those. A sweep written against the first spelling passes over them without a word, which is
// the shape of every scan that reports zero because it was looking for the wrong thing.

// The outcomes that mean "the turn was generated and the customer got none of it". Everything else a
// turn can return ("posted", "empty", "silent", "messaged", "noted", …) is not a refusal: something
// stands at the end of it.
const NUDGE_REFUSALS = ["stale", "live-unavailable"] as const;
const TURN_REFUSALS = ["stale", "superseded", "blocked", "taken-over"] as const;

// Everything above the closure is a refusal BEFORE the invoke, where there is no generated turn to
// take back and `refuse` would be a checkpointer round trip for nothing.
export function bareRefusalsAfterTheRollback(
  source: string,
  outcomes: readonly string[],
): string[] {
  const at = source.indexOf("const refuse = async (");
  if (at === -1) return ["the `refuse` closure is gone"];
  const any = outcomes.join("|");
  // What is already routed stops being a candidate, so what the match reports is the spelling that
  // was left behind rather than a count of anything.
  const below = source
    .slice(at)
    // COMMENTS FIRST, and this is not tidiness. Collapsing whitespace below makes a statement one
    // string, and prose has no `;` in it — so the word "returning" in a NOTE two paragraphs above a
    // routed refusal pairs with that refusal's literal and reports a site that does not exist. This
    // file's comments are long and quote the outcomes by name, so that is the normal case, not a
    // corner one. (`[^:]` keeps a `https://` out of it.)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(new RegExp(`refuse\\("(?:${any})"\\)`, "g"), "refuse(ROUTED)")
    // Collapsed so a statement is one string no matter how the formatter broke it: `[^;]` is what
    // bounds a match to a single statement, and a `return` split across lines would otherwise be
    // invisible to a line-bounded pattern for no reason other than its width.
    .replace(/\s+/g, " ");
  const pattern = new RegExp(`return[^;]*"(?:${any})"[^;]*;`, "g");
  return below.match(pattern) ?? [];
}

describe("every post-generation refusal rolls the turn back", () => {
  // The control: a sweep that finds nothing passes whether or not it is looking at anything, so the
  // predicate is shown an offender first.
  test("the predicate flags a bare refusal written below the closure", () => {
    const withOffender = `
  const refuse = async (outcome) => outcome;
  if (!(await stillWanted())) return refuse("stale");
  if (owned === "gone") return "live-unavailable";
`;
    expect(bareRefusalsAfterTheRollback(withOffender, NUDGE_REFUSALS)).toEqual([
      'return "live-unavailable";',
    ]);
  });

  // The second spelling, and the one the first version of this predicate could not see. A refusal
  // that shares a return with a non-refusal is still a refusal on the branch that takes it.
  test("and flags one hiding on the losing side of a ternary", () => {
    const withTernary = `
  const refuse = async (outcome) => outcome;
  if (attachments.calledOff) return attachments.sent ? "posted" : "stale";
`;
    expect(bareRefusalsAfterTheRollback(withTernary, TURN_REFUSALS)).toEqual([
      'return attachments.sent ? "posted" : "stale";',
    ]);
  });

  // …and does not flag the same line once it is routed.
  test("a routed ternary is not an offender", () => {
    const routed = `
  const refuse = async (outcome) => outcome;
  if (attachments.calledOff) return attachments.sent ? "posted" : refuse("stale");
`;
    expect(bareRefusalsAfterTheRollback(routed, TURN_REFUSALS)).toEqual([]);
  });

  // A comparison is not a return, and flagging one would make the fence unfixable.
  test("a refusal outcome that is only being COMPARED is not a return", () => {
    const comparing = `
  const refuse = async (outcome) => outcome;
  if (delivered === "stale" || delivered === 0) return refuse("stale");
`;
    expect(bareRefusalsAfterTheRollback(comparing, TURN_REFUSALS)).toEqual([]);
  });

  // The trap the comment stripping exists for, kept as a row because it produced two phantom sites
  // the first time this ran against runtime.ts.
  test("prose above a routed refusal does not invent an offender", () => {
    const prosey = `
  const refuse = async (outcome) => outcome;
  // …returning "stale" from there would replay a burst the customer already has.
  if (attachments.calledOff) return attachments.sent ? "posted" : refuse("stale");
`;
    expect(bareRefusalsAfterTheRollback(prosey, TURN_REFUSALS)).toEqual([]);
  });

  test("and says so when the closure itself was removed", () => {
    expect(
      bareRefusalsAfterTheRollback("if (x) return 'stale';", NUDGE_REFUSALS),
    ).toEqual(["the `refuse` closure is gone"]);
  });

  test("a refusal above the closure is not its business", () => {
    const before = `
  if (!(await stillWanted())) return "stale";
  const refuse = async (outcome) => outcome;
`;
    expect(bareRefusalsAfterTheRollback(before, NUDGE_REFUSALS)).toEqual([]);
  });

  // A floor, not a census: more sites routed through `refuse` is a better state, never a worse one,
  // so pinning the exact number would only cost a second edit to a PR that adds a gate correctly.
  // What it guards is the subject going EMPTY, which is how a sweep starts passing blind.
  const routedCount = (source: string) => {
    const at = source.indexOf("const refuse = async (");
    return (source.slice(at).match(/refuse\(/g) ?? []).length;
  };

  test("nudge.ts has none", async () => {
    const source = await Bun.file("src/graph/nudge.ts").text();
    expect(bareRefusalsAfterTheRollback(source, NUDGE_REFUSALS)).toEqual([]);
    expect(routedCount(source)).toBeGreaterThanOrEqual(8);
  });

  // NOTE: one refusal in `runLoadedTurn` reaches `refuse` through a VARIABLE — `postBlocked()`
  // answers "stale" or "superseded" from above the invoke, and its caller writes
  // `if (blocked) return refuse(blocked);`. No spelling rule can see that the variable holds a
  // refusal, so that one site is held by the supersede e2e in runtime.test.ts instead.
  test("runtime.ts has none", async () => {
    const source = await Bun.file("src/graph/runtime.ts").text();
    expect(bareRefusalsAfterTheRollback(source, TURN_REFUSALS)).toEqual([]);
    expect(routedCount(source)).toBeGreaterThanOrEqual(8);
  });
});
