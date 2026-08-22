import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
