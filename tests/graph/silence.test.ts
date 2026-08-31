import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  customerFacingReply,
  FOLLOWUP_SKIP_SENTINEL,
  isNudgeSilent,
} from "@/graph/silence";

// The rule is a decision, so it is proved as a table rather than through whichever path happens to
// call it. Each row is (what the model wrote) → (silent?, what the customer gets).
describe("customerFacingReply", () => {
  const S = FOLLOWUP_SKIP_SENTINEL;
  const rows: Array<[string, string, boolean, string]> = [
    ["the bare sentinel", S, true, ""],
    ["the sentinel in quotes", `"${S}"`, true, ""],
    ["the sentinel with whitespace", `\n  ${S}  \n`, true, ""],
    ["a bare SKIP", "SKIP", true, ""],
    ["a lowercase skip", "skip", true, ""],
    ["narrated emptiness (en)", "(empty — nothing to do yet)", true, ""],
    ["narrated emptiness (pt-BR)", "(vazio: nada a fazer)", true, ""],
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
    // The token is a marker, not a word: a reply that merely TALKS about skipping is text.
    [
      "a reply about skipping",
      "Para pular, responda SKIP.",
      false,
      "Para pular, responda SKIP.",
    ],
  ];
  for (const [name, raw, silent, text] of rows) {
    test(name, () => {
      const out = customerFacingReply(raw);
      expect(out.silent).toBe(silent);
      expect(out.text).toBe(text);
      // Whatever the verdict, the token never survives into what a person reads.
      expect(out.text).not.toContain(S);
    });
  }

  // `bySentinel` is what lets a caller tell "the model wrote the token" from "the model wrote
  // nothing", which is the difference between silence worth a line and an ordinary empty turn.
  test("silence by token is distinguishable from an empty answer", () => {
    expect(customerFacingReply(S).bySentinel).toBe(true);
    expect(customerFacingReply("(vazio)").bySentinel).toBe(true);
    expect(customerFacingReply("").bySentinel).toBe(false);
    expect(customerFacingReply("   ").bySentinel).toBe(false);
    expect(customerFacingReply("Olá").bySentinel).toBe(false);
  });

  test("isNudgeSilent still answers for the proactive path", () => {
    expect(isNudgeSilent(S)).toBe(true);
    expect(isNudgeSilent("Oi! Vi que seu pagamento venceu.")).toBe(false);
  });
});

// The fence. The leak (issue #454) was not a wrong rule, it was a rule two of four sites knew, so
// what has to fail here is a site N+1 that reads the model's last message and skips it.
describe("every site that reads the model's final text applies the rule", () => {
  // Kept as a predicate over TEXT rather than an inline scan, so the fixture below can prove it
  // rejects the shape the defect had — a fence with no offender in the tree proves nothing about
  // whether it can see one.
  function unguardedSites(source: string): string[] {
    return source
      .split("\n")
      .filter(
        (l) =>
          l.includes("lastAssistantText(") &&
          !l.includes("customerFacingReply(lastAssistantText("),
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
      if (!src.includes("lastAssistantText")) continue;
      // Its own definition and the import lines name it without reading a turn.
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
      sites += (body.match(/lastAssistantText\(/g) ?? []).length;
    }
    // A scan that stopped FINDING sites would pass by invisibility, so the count is asserted too:
    // it is allowed to grow, and a drop to zero means the scan broke, not that the tree got safer.
    expect(sites).toBeGreaterThanOrEqual(4);
    expect(offenders).toEqual([]);
  });
});
