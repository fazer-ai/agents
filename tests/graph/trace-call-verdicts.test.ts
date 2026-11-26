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

// The bug it catches: a call with no id gave the reply's verdict no anchor, so it moved ahead of
// the write.
describe("withCallVerdicts with a call that has no id", () => {
  test("the reply's verdict follows the results of the turn's n-th call", () => {
    const placed = withCallVerdicts(
      [
        { type: "tool_call", id: null, name: "agendar", args: {} },
        {
          type: "tool_result",
          id: null,
          name: "agendar",
          output: "ok",
          isError: false,
        },
      ],
      [
        {
          type: "guardrail",
          direction: "output",
          outcome: "clean",
          check: "turn_review",
          step: "reply",
          afterCalls: 1,
        },
      ],
    );
    expect(placed.map((e) => e.type)).toEqual([
      "tool_call",
      "tool_result",
      "guardrail",
    ]);
  });
});

// The bug it catches: a write with no id kept its verdict pending, listed after the whole turn.
describe("withCallVerdicts with a write that has no id", () => {
  test("each verdict goes after the call at its place among the turn's calls", () => {
    const placed = withCallVerdicts(
      [
        { type: "tool_call", id: null, name: "agendar", args: {} },
        { type: "tool_call", id: null, name: "agendar", args: {} },
        {
          type: "tool_result",
          id: null,
          name: "agendar",
          output: "ok",
          isError: false,
        },
      ],
      [
        {
          type: "guardrail",
          direction: "output",
          outcome: "revised",
          check: "turn_review",
          step: "call",
          tool: "agendar",
          callOrdinal: 2,
        },
        {
          type: "guardrail",
          direction: "output",
          outcome: "clean",
          check: "turn_review",
          step: "call",
          tool: "agendar",
          callOrdinal: 1,
        },
      ],
    );
    expect(
      placed.map((e) =>
        e.type === "guardrail"
          ? `veredito:${(e as { callOrdinal?: number }).callOrdinal}`
          : e.type,
      ),
    ).toEqual([
      "tool_call",
      "veredito:1",
      "tool_call",
      "veredito:2",
      "tool_result",
    ]);
  });
});

// The bug it catches: a factual-grounding rewrite's verdict was listed after the rewrite's own
// calls, as if the draft it judged came last.
describe("withCallVerdicts with a factual-grounding rewrite", () => {
  const grounding = (anchor: { afterCallId?: string; afterCalls?: number }) =>
    ({
      type: "guardrail",
      direction: "output",
      outcome: "revised",
      check: "factual_grounding",
      ...anchor,
    }) as const;
  const result = (id: string) =>
    ({
      type: "tool_result",
      id,
      name: "buscar",
      output: "ok",
      isError: false,
    }) as const;
  const label = (e: { type: string; id?: string | null }) =>
    e.type === "guardrail" ? "veredito" : `${e.type}:${e.id ?? ""}`;

  test("the verdict sits after the draft's calls and before the rewrite's", () => {
    const placed = withCallVerdicts(
      [
        { type: "tool_call", id: "a", name: "buscar", args: {} },
        result("a"),
        { type: "tool_call", id: "b", name: "buscar", args: {} },
        result("b"),
      ],
      [grounding({ afterCallId: "a" })],
    );
    expect(placed.map(label)).toEqual([
      "tool_call:a",
      "tool_result:a",
      "veredito",
      "tool_call:b",
      "tool_result:b",
    ]);
  });

  test("a draft written before any call puts the verdict ahead of the rewrite's calls", () => {
    const placed = withCallVerdicts(
      [{ type: "tool_call", id: "b", name: "buscar", args: {} }, result("b")],
      [grounding({ afterCalls: 0 })],
    );
    expect(placed.map(label)).toEqual([
      "veredito",
      "tool_call:b",
      "tool_result:b",
    ]);
  });

  test("a verdict with no anchor, as saved before, keeps its place at the end", () => {
    const placed = withCallVerdicts(
      [{ type: "tool_call", id: "b", name: "buscar", args: {} }, result("b")],
      [grounding({})],
    );
    expect(placed.map(label)).toEqual([
      "tool_call:b",
      "tool_result:b",
      "veredito",
    ]);
  });
});
