import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  customerFacingReply,
  FOLLOWUP_SKIP_SENTINEL,
  isNudgeSilent,
  proactiveReply,
} from "@/graph/silence";

const S = FOLLOWUP_SKIP_SENTINEL;

// Two policies, one strip, and the table is what keeps them from drifting back together. Each row is
// (what the model wrote) → (silent?, what the person gets).
describe("customerFacingReply — the REACTIVE rule", () => {
  const rows: Array<[string, string, boolean, string]> = [
    ["the bare sentinel", S, true, ""],
    ["the sentinel with whitespace", `\n  ${S}  \n`, true, ""],
    ["the sentinel twice", `${S}${S}`, true, ""],
    ["the sentinel twice, spaced", `${S} ${S}`, true, ""],
    // Review round 2, P2. The token in a costume: strip it and only quotes are left.
    ["the sentinel in quotes", `"${S}"`, true, ""],
    ["the sentinel in backticks", `\`${S}\``, true, ""],
    ["quotes around repeated sentinels", `"${S}${S}"`, true, ""],
    // ...and the other direction: quotes on a REAL reply are content and survive untouched.
    ["a quoted real reply", `"Olá!"`, false, `"Olá!"`],
    ["nothing at all", "", true, ""],
    ["only whitespace", "   \n ", true, ""],
    [
      "a real reply",
      "Olá! Como posso ajudar?",
      false,
      "Olá! Como posso ajudar?",
    ],
    ["a real reply carrying the token", `${S} Claro.`, false, "Claro."],
    ["a real reply ending in the token", `Claro. ${S}`, false, "Claro."],
    ["the token twice inside a reply", `${S}Bom${S} dia`, false, "Bom dia"],
    // The heuristics below belong to the proactive path ONLY. Here a customer is waiting, and these
    // are ordinary short answers — swallowing one is its own defect (review round 1, P2).
    ["a bare SKIP", "SKIP", false, "SKIP"],
    [
      "narrated emptiness (en)",
      "(empty — nothing to do yet)",
      false,
      "(empty — nothing to do yet)",
    ],
    ["a parenthetical answer (pt-BR)", "(nada consta)", false, "(nada consta)"],
    ["a parenthetical answer about rates", "(sem juros)", false, "(sem juros)"],
  ];
  for (const [name, raw, silent, text] of rows) {
    test(name, () => {
      const out = customerFacingReply(raw);
      expect(out.silent).toBe(silent);
      expect(out.text).toBe(text);
      expect(out.text).not.toContain(S);
      // The contract the repeated-sentinel case used to fall through: emptiness and silence are one
      // decision, so a caller can never see silent=false with nothing to send.
      expect(out.silent).toBe(out.text.length === 0);
    });
  }

  // `bySentinel` is what lets a caller tell "the model wrote the token" from "the model wrote
  // nothing", which is the difference between silence worth a line and an ordinary empty turn.
  test("silence by token is distinguishable from an empty answer", () => {
    expect(customerFacingReply(S).bySentinel).toBe(true);
    expect(customerFacingReply(`${S}${S}`).bySentinel).toBe(true);
    expect(customerFacingReply(`"${S}"`).bySentinel).toBe(true);
    expect(customerFacingReply("").bySentinel).toBe(false);
    expect(customerFacingReply("   ").bySentinel).toBe(false);
    expect(customerFacingReply("Olá").bySentinel).toBe(false);
  });
});

describe("proactiveReply — the follow-up rule", () => {
  // Everything the reactive rule says, plus the prose heuristics, because THIS prompt asked the
  // model to produce nothing and models answer that in words.
  const silentRows = [
    S,
    `"${S}"`,
    `${S}${S}`,
    "SKIP",
    "skip",
    "(empty — nothing to do yet)",
    "(vazio: nada a fazer)",
    "",
  ];
  for (const raw of silentRows) {
    test(`silent: ${JSON.stringify(raw)}`, () => {
      const out = proactiveReply(raw);
      expect(out.silent).toBe(true);
      expect(out.text).toBe("");
    });
  }

  test("a real follow-up survives, minus any stray token", () => {
    const out = proactiveReply(`Oi! Vi que seu pagamento venceu. ${S}`);
    expect(out.silent).toBe(false);
    expect(out.text).toBe("Oi! Vi que seu pagamento venceu.");
  });

  // The two rules DIVERGE here, and that divergence is the point: the same string is silence for a
  // follow-up nobody asked for and a real answer to a customer who is waiting.
  test("the prose heuristics are proactive-only", () => {
    for (const raw of ["SKIP", "(nada consta)", "(sem juros)"]) {
      expect(proactiveReply(raw).silent).toBe(true);
      expect(customerFacingReply(raw).silent).toBe(false);
    }
  });

  test("isNudgeSilent still answers for the proactive path", () => {
    expect(isNudgeSilent(S)).toBe(true);
    expect(isNudgeSilent("Oi! Vi que seu pagamento venceu.")).toBe(false);
  });
});

// The fence. The leak (issue #454) was not a wrong rule, it was a rule two of four sites knew, so
// what has to fail here is a site N+1 that takes the model's final text and skips it.
//
// It is anchored on `lastAssistantText`, which is narrower than the invariant, and the gap is
// declared rather than papered over. Anchoring on `contentToText` instead — the helper underneath —
// was tried and accuses eleven sites that are correct: token counting, the turn trace, the memory
// summarizer, and reading the HUMAN message. A scan that accuses everything proves as little as one
// that finds nothing.
//
// WHAT IT DOES NOT COVER, said out loud so it is not left to be discovered:
//   - `playground/sessions.ts` picks the reply with its own `lastAi`, deliberately not this one.
//     Covered by BEHAVIOUR instead, in tests/modules/playground-sessions.test.ts.
//   - `graph/trace.ts` renders the turn trace, which exists to show what the model actually
//     produced, and is meant to stay raw.
//   - `memory/summarize.ts` feeds the transcript to the summarizer. That is how the token reaches
//     permanent memory, which is a recurrence question rather than a leak: it is named in the issue
//     and left to its own change.
describe("every site that reads the model's final text applies a rule", () => {
  // Kept as a predicate over TEXT rather than an inline scan, so the fixture below can prove it
  // rejects the shape the defect had — a fence with no offender in the tree proves nothing about
  // whether it can see one.
  const READERS = /lastAssistantText\(/;
  function unguardedSites(source: string): string[] {
    return source
      .split("\n")
      .filter(
        (l) =>
          READERS.test(l) && !/(customerFacingReply|proactiveReply)\(/.test(l),
      )
      .map((l) => l.trim());
  }

  test("the predicate sees the defect it was written for", () => {
    expect(
      unguardedSites(
        "  const reply = lastAssistantText(result.messages).trim();",
      ),
    ).toHaveLength(1);
    expect(
      unguardedSites(
        "  const drafted = customerFacingReply(lastAssistantText(result.messages));",
      ),
    ).toHaveLength(0);
    expect(
      unguardedSites(
        "  const drafted = proactiveReply(lastAssistantText(result.messages));",
      ),
    ).toHaveLength(0);
  });

  test("no production site reads it unguarded", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts") || p.endsWith(".tsx")) files.push(p);
      }
    };
    walk("src");

    const offenders: string[] = [];
    let sites = 0;
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      if (!READERS.test(src)) continue;
      // Definitions and import lines name the readers without reading a turn.
      const body = src
        .split("\n")
        .filter(
          (l) =>
            !l.includes("export function lastAssistantText") &&
            !l.trimStart().startsWith("import") &&
            !l.includes("lastAssistantText } from"),
        )
        .join("\n");
      for (const l of unguardedSites(body)) offenders.push(`${f}: ${l}`);
      sites += body
        .split("\n")
        .filter(
          (l) => READERS.test(l) && !l.trimStart().startsWith("//"),
        ).length;
    }
    // A scan that stopped FINDING sites would pass by invisibility, so the count is asserted too:
    // it is allowed to grow, and a drop to zero means the scan broke, not that the tree got safer.
    expect(sites).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
