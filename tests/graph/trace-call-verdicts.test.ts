import { describe, expect, test } from "bun:test";
import { withCallVerdicts } from "@/graph/trace";

// The bug it catches: a verdict paired by id alone, so with an id the provider repeated the
// verdict on the second call landed after the first.
describe("withCallVerdicts", () => {
  test("pairs each verdict with its call by id and tool name, in order", () => {
    const placed = withCallVerdicts(
      [
        { type: "tool_call", id: "x", name: "agendar", args: {} },
        { type: "tool_call", id: "x", name: "transferir", args: {} },
      ],
      [
        {
          type: "guardrail",
          direction: "output",
          outcome: "revised",
          step: "call",
          tool: "transferir",
          callId: "x",
        },
        {
          type: "guardrail",
          direction: "output",
          outcome: "clean",
          step: "call",
          tool: "agendar",
          callId: "x",
        },
      ],
    );
    expect(
      placed.map((e) =>
        e.type === "tool_call"
          ? e.name
          : `veredito:${(e as { tool?: string }).tool}`,
      ),
    ).toEqual([
      "agendar",
      "veredito:agendar",
      "transferir",
      "veredito:transferir",
    ]);
  });
});

// The bug it catches: the fallback by id alone pasted a write's verdict onto a read that shared its
// id, when the write itself was not in the entries.
describe("withCallVerdicts without the judged call", () => {
  test("a verdict naming another tool stays after the entries", () => {
    const placed = withCallVerdicts(
      [
        { type: "tool_call", id: "x", name: "buscar", args: {} },
        { type: "tool_call", id: "y", name: "outra", args: {} },
      ],
      [
        {
          type: "guardrail",
          direction: "output",
          outcome: "revised",
          step: "call",
          tool: "agendar",
          callId: "x",
        },
      ],
    );
    expect(placed.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_call",
      "guardrail",
    ]);
    expect(
      withCallVerdicts(
        [
          { type: "tool_call", id: "x", name: "buscar", args: {} },
          { type: "tool_call", id: "y", name: "outra", args: {} },
        ],
        [
          {
            type: "guardrail",
            direction: "output",
            outcome: "clean",
            step: "call",
            callId: "x",
          },
        ],
      ).map((e) => e.type),
    ).toEqual(["tool_call", "guardrail", "tool_call"]);
  });
});

// The bug it catches: a reply sent back and redone as a call had its verdict listed after the
// corrective call's result, so the trace read as if the call came first.
describe("withCallVerdicts with a reply redone as a call", () => {
  const result = (id: string, name: string) =>
    ({
      type: "tool_result",
      id,
      name,
      output: "ok",
      isError: false,
    }) as const;
  const label = (e: { type: string }) =>
    e.type === "guardrail"
      ? `veredito:${(e as { step?: string }).step}`
      : `${e.type}:${(e as { name?: string }).name ?? ""}`;
  const replyVerdict = (afterCallId?: string) =>
    ({
      type: "guardrail",
      direction: "output",
      outcome: "revised",
      check: "turn_review",
      step: "reply",
      ...(afterCallId ? { afterCallId } : {}),
    }) as const;
  const callVerdict = (callId: string, tool: string) =>
    ({
      type: "guardrail",
      direction: "output",
      outcome: "clean",
      check: "turn_review",
      step: "call",
      tool,
      callId,
    }) as const;

  test("with no call before the reply, its verdict opens the trace", () => {
    const placed = withCallVerdicts(
      [
        { type: "assistant", text: "Vou transferir." },
        { type: "tool_call", id: "c1", name: "transferir", args: {} },
        result("c1", "transferir"),
      ],
      [replyVerdict(), callVerdict("c1", "transferir")],
    );
    expect(placed.map(label)).toEqual([
      "veredito:reply",
      "assistant:",
      "tool_call:transferir",
      "veredito:call",
      "tool_result:transferir",
    ]);
  });

  test("after earlier calls, its verdict follows their results and precedes the redo", () => {
    const placed = withCallVerdicts(
      [
        { type: "tool_call", id: "r1", name: "buscar", args: {} },
        { type: "tool_call", id: "r2", name: "buscar", args: {} },
        result("r1", "buscar"),
        result("r2", "buscar"),
        { type: "tool_call", id: "r3", name: "buscar_mais", args: {} },
        result("r3", "buscar_mais"),
        { type: "tool_call", id: "c1", name: "transferir", args: {} },
        result("c1", "transferir"),
      ],
      [replyVerdict("r2"), callVerdict("c1", "transferir")],
    );
    expect(placed.map(label)).toEqual([
      "tool_call:buscar",
      "tool_call:buscar",
      "tool_result:buscar",
      "tool_result:buscar",
      "veredito:reply",
      "tool_call:buscar_mais",
      "tool_result:buscar_mais",
      "tool_call:transferir",
      "veredito:call",
      "tool_result:transferir",
    ]);
  });

  test("the final reply's verdict, after the last call, still closes the trace", () => {
    const placed = withCallVerdicts(
      [
        { type: "tool_call", id: "r1", name: "buscar", args: {} },
        result("r1", "buscar"),
      ],
      [{ ...replyVerdict("r1"), outcome: "clean" }],
    );
    expect(placed.map(label)).toEqual([
      "tool_call:buscar",
      "tool_result:buscar",
      "veredito:reply",
    ]);
  });
});
