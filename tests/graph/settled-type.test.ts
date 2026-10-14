import { describe, expect, test } from "bun:test";
import { nudgeSettlement } from "@/graph/nudge";
import { type Settled, settlement } from "@/graph/refused-turn";
import { turnSettlement } from "@/graph/runtime";

// A refusal after the model call that skips the rollback fails nothing visibly: the send is
// suppressed and the outcome word is right, and only the next turn reads a reply nobody received.
// So the words that can only be a refusal are refused by `settled` at compile time. The function
// below is never run; each `@ts-expect-error` fails the typecheck the day `settled` accepts one again.
function refusalsDoNotSettle(
  standDown: () => "stale" | "agent-unavailable",
  blocked: "stale" | "agent-unavailable" | "superseded" | "answered-elsewhere",
) {
  // @ts-expect-error: a word that can only be a refusal on the reactive path.
  turnSettlement.settled("taken-over");
  // @ts-expect-error: the guardrail's own refusal.
  turnSettlement.settled("blocked");
  // @ts-expect-error: what `standDown()` answers, on the reactive path.
  turnSettlement.settled(standDown());
  // @ts-expect-error: what `postBlocked()` answers, carried by a variable.
  turnSettlement.settled(blocked);
  // @ts-expect-error: a word that can only be a refusal on the proactive path.
  nudgeSettlement.settled("live-unavailable");
  // @ts-expect-error: what `standDown()` answers, on the proactive path.
  nudgeSettlement.settled(standDown());
  // NOTE: the control: the words a delivered or an empty turn ends on still settle, and every word
  // can be refused, so the errors above are about the refusal-only words and nothing wider.
  turnSettlement.settled("posted");
  turnSettlement.settled("empty");
  turnSettlement.refused("empty");
  nudgeSettlement.settled("silent");
  nudgeSettlement.refused("silent");
  nudgeSettlement.refused(standDown());
}
void refusalsDoNotSettle;

describe("settlement", () => {
  test("refused asks for the rollback and settled does not", () => {
    const { refused, settled } = settlement<"a" | "b", "b">();
    expect(refused("b")).toEqual<Settled<"a" | "b">>({
      outcome: "b",
      undo: true,
    });
    expect(settled("a")).toEqual<Settled<"a" | "b">>({
      outcome: "a",
      undo: false,
    });
  });
});
