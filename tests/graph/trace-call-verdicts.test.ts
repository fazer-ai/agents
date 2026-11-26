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
