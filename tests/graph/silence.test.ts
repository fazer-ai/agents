import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  customerFacingReply,
  FOLLOWUP_SKIP_SENTINEL,
  isNudgeSilent,
  proactiveReply,
  SKIP_REPLY_TOOL,
  withFollowupSilenceChannel,
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
    // Review round 3. Quotes are tolerated only when the token was actually there: a customer asking
    // what an empty string literal looks like gets `""` back, and that is an answer.
    ["a reply that IS two quote characters", `""`, false, `""`],
    ["a reply that is a quoted empty string", `"''"`, false, `"''"`],
    ["nothing at all", "", true, ""],
    ["only whitespace", "   \n ", true, ""],
    [
      "a real reply",
      "Olá! Como posso ajudar?",
      false,
      "Olá! Como posso ajudar?",
    ],
    // Review round 4. The token inside a REAL answer is left alone: editing a substring out of a
    // customer-facing reply is the silent data loss docs/graph.md rejects, and the cause fix means
    // only a legacy transcript can still put it here. Reported, never mutated (see `carriesToken`).
    ["a real reply carrying the token", `${S} Claro.`, false, `${S} Claro.`],
    ["a real reply ending in the token", `Claro. ${S}`, false, `Claro. ${S}`],
    [
      "the token twice inside a reply",
      `${S}Bom${S} dia`,
      false,
      `${S}Bom${S} dia`,
    ],
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
      // The contract the repeated-sentinel case used to fall through: emptiness and silence are one
      // decision, so a caller can never see silent=false with nothing to send.
      expect(out.silent).toBe(out.text.length === 0);
    });
  }

  // `bySentinel` is what lets a caller tell "the model wrote the token" from "the model wrote
  // nothing", which is the difference between silence worth a line and an ordinary empty turn.
  // A token that survives into a delivered reply is REPORTED, which is what makes not-editing-it
  // honest rather than a leak nobody hears about.
  test("a token riding along in a real reply is flagged, not removed", () => {
    const out = customerFacingReply(`${S} Claro.`);
    expect(out.carriesToken).toBe(true);
    expect(out.silent).toBe(false);
    expect(out.text).toBe(`${S} Claro.`);
    // Silence is not "carrying": there is no reply left to carry anything.
    expect(customerFacingReply(S).carriesToken).toBe(false);
    expect(customerFacingReply("Olá").carriesToken).toBe(false);
  });

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

  // The two rules diverge on a stray token too, and deliberately: this is the path that ASKED for
  // it, so an occurrence here is an artifact of our own instruction rather than a customer's words.
  test("a real follow-up loses a stray token, unlike a reactive reply", () => {
    const out = proactiveReply(`Oi! Vi que seu pagamento venceu. ${S}`);
    expect(out.silent).toBe(false);
    expect(out.text).toBe("Oi! Vi que seu pagamento venceu.");
    expect(out.carriesToken).toBe(false);
    // The reactive rule leaves the same input alone and reports it instead.
    const reactive = customerFacingReply(
      `Oi! Vi que seu pagamento venceu. ${S}`,
    );
    expect(reactive.text).toBe(`Oi! Vi que seu pagamento venceu. ${S}`);
    expect(reactive.carriesToken).toBe(true);
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

// The FOLLOW-UP SILENCE PROTOCOL, which is where round 3 landed and why it is a rule rather than a
// line: the directive asks the model to call `skip_reply`, `skip_reply` is operator-revocable, and
// there are TWO paths that render that directive. Round 2 changed the protocol in one of them.
describe("withFollowupSilenceChannel", () => {
  test("adds the channel to an allowlist that revoked it", () => {
    expect(
      withFollowupSilenceChannel({ nativeToolsAllow: ["private_note"] })
        .nativeToolsAllow,
    ).toEqual(["private_note", SKIP_REPLY_TOOL]);
  });

  test("leaves an allowlist that already has it untouched", () => {
    const allow = ["private_note", SKIP_REPLY_TOOL];
    expect(
      withFollowupSilenceChannel({ nativeToolsAllow: allow }).nativeToolsAllow,
    ).toBe(allow);
  });

  // Review round 7. Revoking EVERY tool is how a tool-less deployment is configured (a plain chat
  // model, or an `openai-compatible` endpoint that answers 400 to any function schema). Forcing one
  // tool back in would make every follow-up call `bindTools` and fail at the provider — a token that
  // leaks traded for a follow-up that never runs.
  test("an agent that revoked every tool keeps zero", () => {
    const cfg = { nativeToolsAllow: [] as string[] };
    expect(withFollowupSilenceChannel(cfg)).toBe(cfg);
  });

  test("an undefined allowlist already means every tool", () => {
    const cfg = { nativeToolsAllow: undefined };
    expect(withFollowupSilenceChannel(cfg)).toBe(cfg);
  });

  // Granting is only half. A precondition on the tool is fail-closed and refuses the very call the
  // directive depends on, so the follow-up would answer with text instead — the leak by a third road.
  test("it also drops a precondition standing on the channel", () => {
    const preconditions: Record<string, unknown> = {
      [SKIP_REPLY_TOOL]: { kind: "attribute", key: "x" },
      handoff_to_human: { kind: "attribute", key: "article_url" },
    };
    const out = withFollowupSilenceChannel({
      nativeToolsAllow: [SKIP_REPLY_TOOL],
      toolPreconditions: preconditions,
    });
    expect(out.toolPreconditions).toEqual({
      handoff_to_human: { kind: "attribute", key: "article_url" },
    });
  });

  test("it leaves an agent with no preconditions alone", () => {
    const cfg = { nativeToolsAllow: undefined, toolPreconditions: {} };
    expect(withFollowupSilenceChannel(cfg).toolPreconditions).toEqual({});
  });

  test("it revokes nothing else", () => {
    expect(
      withFollowupSilenceChannel({
        nativeToolsAllow: ["private_note", "assign_label"],
      }).nativeToolsAllow,
    ).toEqual(["private_note", "assign_label", SKIP_REPLY_TOOL]);
  });

  test("the fence wants the CALL, not the import", () => {
    const CALL = /withFollowupSilenceChannel\(/;
    const importOnly =
      'import { withFollowupSilenceChannel } from "@/graph/silence";';
    expect(
      CALL.test(
        importOnly
          .split("\n")
          .filter((l) => !l.trimStart().startsWith("import"))
          .join("\n"),
      ),
    ).toBe(false);
    expect(CALL.test("  const c = withFollowupSilenceChannel(cfg);")).toBe(
      true,
    );
  });

  // The fence for the invariant itself. Round 3 found the playground because the protocol lives in
  // TWO places: whoever renders the directive owes the channel. A third renderer must fail here.
  test("every renderer of the follow-up directive grants the channel", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk("src");

    const renderers = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /renderNudge\(/.test(
        src
          .split("\n")
          .filter(
            (l) =>
              !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"),
          )
          .join("\n"),
      );
    });
    // Positive control: a fence that stopped FINDING renderers proves nothing about the ones it
    // would have to check.
    expect(renderers.length).toBeGreaterThanOrEqual(2);
    const CALL = /withFollowupSilenceChannel\(/;
    for (const f of renderers) {
      const body = readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("import"))
        .join("\n");
      expect([f, CALL.test(body)]).toEqual([f, true]);
    }
  });
});
