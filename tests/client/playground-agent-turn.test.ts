import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { guardrailTraceLabel } from "@/client/pages/agents/PlaygroundChat";
import {
  agentTurn,
  type PlaygroundTurn,
} from "@/client/pages/agents/usePlaygroundChat";

// Five paths in the hook produce an agent turn — text, file, voice note, follow-up, and the reload
// that rebuilds them from the server — and each one used to decide for itself what a suppressed
// turn looks like. Three had the rule and two did not, so a guardrail that emptied a file or voice
// reply showed an empty bubble live and a note after a reload: the same turn, two transcripts.
// The rule now lives in one function, and this is its table (issue #136).

const t = (_key: string, fallback: string) => fallback;

const base = { trace: [], sources: [] } as unknown as Parameters<
  typeof agentTurn
>[1];

const role = (turn: PlaygroundTurn) => turn.role;

describe("agentTurn", () => {
  test("a suppressed turn is a note carrying the verdict, never an empty bubble", () => {
    const trace = [
      { type: "guardrail", direction: "output", outcome: "suppressed" },
    ] as unknown as Parameters<typeof agentTurn>[1]["trace"];
    const turn = agentTurn(t, { ...base, text: "", suppressed: true, trace });
    expect(role(turn)).toBe("note");
    expect(turn.text).toBe(
      "Nothing would be sent: the guardrail acted on this turn.",
    );
    // The verdict is the whole point of the note: a note without it says nothing happened.
    expect(turn.role === "note" && turn.trace).toBe(trace);
  });

  test("suppression outranks silence, so a blocked follow-up reads as blocked", () => {
    const turn = agentTurn(t, {
      ...base,
      text: "",
      suppressed: true,
      silent: true,
      followup: true,
    });
    expect(turn.text).toBe(
      "Nothing would be sent: the guardrail acted on this turn.",
    );
  });

  test("a silent follow-up is the agent's own choice, and carries no verdict", () => {
    const turn = agentTurn(t, {
      ...base,
      text: "",
      silent: true,
      followup: true,
    });
    expect(role(turn)).toBe("note");
    expect(turn.text).toBe("Follow-up: the agent chose not to send anything.");
    expect(turn.role === "note" && turn.trace).toBeUndefined();
  });

  test("an ordinary reply is a bubble, with its audio and its follow-up flag", () => {
    const turn = agentTurn(t, {
      ...base,
      text: "Claro!",
      followup: true,
      audioUrl: "blob:tts",
    });
    expect(role(turn)).toBe("assistant");
    expect(turn.text).toBe("Claro!");
    expect(turn.role === "assistant" && turn.followup).toBe(true);
    expect(turn.role === "assistant" && turn.audioUrl).toBe("blob:tts");
  });

  // The placeholder is for a reply the agent genuinely had nothing to put in, which is a different
  // statement from "the guardrail removed it" — the distinction the note above exists to keep.
  test("an empty reply nobody suppressed still reads as the agent's own silence", () => {
    const turn = agentTurn(t, { ...base, text: "" });
    expect(role(turn)).toBe("assistant");
    expect(turn.text).toBe("(no reply)");
  });

  test("a turn with no audio declares no audio, rather than an undefined url", () => {
    const turn = agentTurn(t, { ...base, text: "oi" });
    expect("audioUrl" in turn).toBe(false);
    expect("followup" in turn).toBe(false);
  });
});

// The table above proves the FUNCTION. It cannot prove that the five paths call it, and that is
// exactly the half that was broken: the rule was written and correct, and two call sites did not
// have it. So the source is the assertion — one construction site, and every append reaching it.
describe("agentTurn is the only place an agent turn is built", () => {
  const src = readFileSync(
    "src/client/pages/agents/usePlaygroundChat.ts",
    "utf8",
  );

  test("nothing constructs an assistant bubble on its own", () => {
    // Once in the union that declares the shape, once inside agentTurn. A third is a call site
    // deciding for itself again.
    expect(src.match(/role: "assistant"/g)?.length).toBe(2);
  });

  test("nothing decides on its own what a suppressed turn says", () => {
    expect(src.match(/playground\.suppressedNote/g)?.length).toBe(1);
    expect(src.match(/playground\.followup\.silent/g)?.length).toBe(1);
    expect(src.match(/playground\.empty/g)?.length).toBe(1);
  });

  test("every path that receives a reply renders it through agentTurn", () => {
    // text, follow-up, file, voice note, and the reload — the five that produce an agent turn.
    expect(src.match(/agentTurn\(t, \{/g)?.length).toBe(5);
  });
});

// The other row-level renderer of this PR, and the same failure twice over: two independent fields
// decide the sentence, and a nested ternary answered one of them with a constant. The direction arm
// was caught in review round 8; the action arm survived to round 11, telling the operator "the
// configured reply" on text the judge itself had written.
describe("guardrailTraceLabel", () => {
  const t = (_k: string, fallback: string) => fallback;

  const rows: {
    name: string;
    entry: Parameters<typeof guardrailTraceLabel>[1];
    says: string;
  }[] = [
    {
      name: "approved",
      entry: { direction: "output", outcome: "clean" },
      says: "approved",
    },
    {
      name: "unscreened input",
      entry: { direction: "input", outcome: "unavailable" },
      says: "the message reached the agent unchecked",
    },
    {
      name: "unscreened output",
      entry: { direction: "output", outcome: "unavailable" },
      says: "the reply went out unscreened",
    },
    {
      name: "suppressed",
      entry: { direction: "output", outcome: "suppressed", action: "silent" },
      says: "nothing would be sent",
    },
    {
      name: "replaced by the template",
      entry: { direction: "output", outcome: "replaced", action: "template" },
      says: "the configured reply",
    },
    {
      name: "replaced by text the judge wrote",
      entry: { direction: "output", outcome: "replaced", action: "generated" },
      says: "a reply the guardrail wrote",
    },
    // `action` is absent on a report that predates it being recorded. The configured reply is the
    // safe half of the pair: it describes what an operator can go and read.
    {
      name: "replaced with no action recorded",
      entry: { direction: "output", outcome: "replaced" },
      says: "the configured reply",
    },
  ];

  for (const row of rows) {
    test(row.name, () => {
      expect(guardrailTraceLabel(t, row.entry)).toContain(row.says);
    });
  }

  // The template arm and the generated arm are DIFFERENT sentences. Asserting `toContain` on each
  // separately would still pass if both returned the generated one.
  test("the two replacement sentences are not the same sentence", () => {
    const template = guardrailTraceLabel(t, {
      direction: "output",
      outcome: "replaced",
      action: "template",
    });
    const generated = guardrailTraceLabel(t, {
      direction: "output",
      outcome: "replaced",
      action: "generated",
    });
    expect(template).not.toBe(generated);
  });

  test("the row does not write any of these sentences itself", () => {
    const src = readFileSync(
      "src/client/pages/agents/PlaygroundChat.tsx",
      "utf8",
    );
    // Once where it is defined, once where the row calls it.
    expect(src.match(/guardrailTraceLabel/g)?.length).toBe(2);
  });
});
