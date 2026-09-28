import { describe, expect, test } from "bun:test";
import { codeOnly, withoutComments } from "@/tests/utils/source-text";

// `undoRefusedTurn` is reachable from a turn's refusals only if each goes out through `refuse`. A
// bare `return "stale";` below the point where the turn was generated fails nothing (the send is
// still suppressed, the outcome is right) and the only symptom is the next turn answering about a
// message nobody received. So the fence is on the SPELLING: below that point a refusal is a
// `refuse`, not a `return`. A refusal can also ride a ternary, so the predicate does not just look
// for `return "x";`, which would pass over `return sent ? "posted" : "stale";`.

// The outcomes that mean "the turn was generated and the customer got none of it". Everything else a
// turn can return ("posted", "empty", "silent", "messaged", "noted", …) is not a refusal: something
// stands at the end of it.
const NUDGE_REFUSALS = ["stale", "live-unavailable"] as const;
const TURN_REFUSALS = [
  "stale",
  "superseded",
  "blocked",
  "taken-over",
  // A burst a PERSON answered. It reaches `refuse` through the same VARIABLE as `superseded`
  // (`postBlocked` returns the word and the caller writes `return refuse(blocked)`), so the NOTE's
  // exemption below covers both. It is listed because it is a post-generation refusal like any
  // other: the turn ran, and what it produced has to be undone.
  "answered-elsewhere",
] as const;

// The stretch below the closure, stripped, or `null` when the closure is gone. Everything above it is
// a refusal BEFORE the invoke, with no generated turn to take back, where `refuse` would be a
// checkpointer round trip for nothing. One function rather than an offset each caller computes,
// because the anchor must be sought in the stripped text: a comment naming the closure would drag
// every pre-invoke refusal into range, and the floor would count a `refuse(` in prose as routed.
export function refuseSection(source: string): string | null {
  // NOTE: Two views, and the offset crosses between them. The anchor is found in the fully stripped
  // text, because a string or a comment spelling the closure would start the section above the real
  // one. The section is the comment-stripped text, because the pattern downstream READS a string
  // literal. They line up because the scan replaces removed characters in place.
  const at = codeOnly(source).indexOf("const refuse = async (");
  return at === -1 ? null : withoutComments(source).slice(at);
}

export function bareRefusalsAfterTheRollback(
  source: string,
  outcomes: readonly string[],
): string[] {
  const code = refuseSection(source);
  if (code === null) return ["the `refuse` closure is gone"];
  const any = outcomes.join("|");
  // NOTE: Comments are stripped first. Collapsing whitespace makes a statement one string and prose
  // has no `;`, so a "returning" in a NOTE above a routed refusal would pair with its literal and
  // report a site that does not exist. `withoutComments` rather than `codeOnly` because the pattern
  // READS a string literal. Routed calls stop being candidates, so a match is a spelling left behind.
  const below = code
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

  // NOTE: The second spelling. A refusal that shares a return with a non-refusal is still a refusal
  // on the branch that takes it.
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

  // NOTE: The trap the comment stripping exists for: runtime.ts prose quotes the outcomes by name,
  // and without the strip this file reported two phantom sites there.
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

  // NOTE: What the section itself must get right, invisible from the predicate's cases: prose or a
  // string literal naming the closure must not move the start (`withoutComments` keeps string
  // contents), and a `refuse(` written in a comment must not count toward the floor below.
  test("the section starts past a closure spelled inside a string", () => {
    const stored =
      'const doc = "const refuse = async (o) => o;";\n' +
      '  if (!(await stillWanted())) return "stale";\n' +
      "  const refuse = async (o) => o;\n" +
      '  if (x) return refuse("stale");\n';
    const section = refuseSection(stored) ?? "";
    expect(section.startsWith("const refuse = async (")).toBe(true);
    expect(section).not.toContain("stillWanted");
  });

  test("the section starts at the real closure, not at one named in prose", () => {
    const prosey =
      "// the const refuse = async ( closure lives further down\n" +
      '  if (!(await stillWanted())) return "stale";\n' +
      "  const refuse = async (outcome) => outcome;\n" +
      '  // …and a NOTE that spells refuse("stale") while explaining the gate below.\n' +
      '  if (owned === "gone") return refuse("live-unavailable");\n';
    const section = refuseSection(prosey) ?? "";
    expect(section.startsWith("const refuse = async (")).toBe(true);
    // The pre-invoke refusal stayed above the start, where it belongs.
    expect(section).not.toContain("stillWanted");
    // One routed call, not two: the one in the NOTE is prose.
    expect((section.match(/refuse\(/g) ?? []).length).toBe(1);
  });

  // A floor, not a census: more sites routed through `refuse` is a better state, never a worse one,
  // so pinning the exact number would only cost a second edit to a PR that adds a gate correctly.
  // What it guards is the subject going EMPTY, which is how a sweep starts passing blind.
  const routedCount = (source: string) =>
    ((refuseSection(source) ?? "").match(/refuse\(/g) ?? []).length;

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

// The boundary's refusal is read before the reply is drafted, in both callers. A refused turn ends
// on an empty assistant message, byte for byte what a turn that chose silence ends on, and asking
// the fence again cannot tell them apart (the channel-redirect fence reads `agent.enabled` on every
// ask), so read as silence the turn would advance a follow-up ladder or a handled watermark over a
// message nothing answered. A source walk because the webhook path builds its fence from the
// conversation row (see still-wanted-strictness.test.ts), and it pins the ORDER: asked after
// `drafted`, the line would read a decision already made.
describe("the called-off result is read before the reply is drafted", () => {
  test.each([["src/graph/runtime.ts"], ["src/graph/nudge.ts"]])(
    "%s asks turnWasCalledOff first",
    async (file) => {
      const lines = (await Bun.file(file as string).text()).split("\n");
      const code = (l: string) => !/^\s*(?:\/\/|\*)/.test(l);
      const asked = lines.findIndex(
        (l) => code(l) && /\bturnWasCalledOff\(/.test(l),
      );
      const drafted = lines.findIndex(
        (l) => code(l) && /^\s*const drafted = /.test(l),
      );
      expect(asked).toBeGreaterThan(-1);
      expect(drafted).toBeGreaterThan(-1);
      expect(asked).toBeLessThan(drafted);
    },
  );
});
