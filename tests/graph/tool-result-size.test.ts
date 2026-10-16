import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { estimateTokenCount } from "tokenx";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import { buildPlaygroundTrace } from "@/graph/trace";
import type { FlowContext } from "@/modules/flowlog/service";
import * as flowlog from "@/modules/flowlog/service";

// What a tool returns is paid again on every later model call of the same turn, so each result carries
// its own size: characters and the same estimate the history ceiling uses, measured on the text the
// model receives (before the trace's clip), and on the flow-log line whatever `logToolValues` says,
// since a size is not customer data.

const BIG = `{"items":[${Array.from({ length: 400 }, (_, i) => `{"id":${i},"name":"produto ${i}","price":${i}.90}`).join(",")}]}`;

function turn(content: ToolMessage["content"], status?: "error") {
  return [
    new HumanMessage("lista os produtos"),
    new AIMessage({
      content: "",
      tool_calls: [{ name: "catalog", args: {}, id: "c1" }],
    }),
    new ToolMessage({
      content,
      tool_call_id: "c1",
      name: "catalog",
      ...(status ? { status } : {}),
    }),
    new AIMessage("aqui estão"),
  ];
}

const resultOf = (messages: ReturnType<typeof turn>) => {
  const r = buildPlaygroundTrace(messages).find(
    (e) => e.type === "tool_result",
  );
  return r?.type === "tool_result" ? r : null;
};

describe("tool result size in the playground trace", () => {
  test("counts the whole result the model got, not the clipped output", () => {
    const r = resultOf(turn(BIG));
    expect(r?.output.length ?? 0).toBeLessThan(BIG.length);
    expect(r?.size?.chars).toBe(BIG.length);
    expect(r?.size?.tokens).toBe(estimateTokenCount(BIG));
  });

  test("an error result is measured too", () => {
    const r = resultOf(turn("HTTP 502 upstream", "error"));
    expect(r?.isError).toBe(true);
    expect(r?.size?.chars).toBe("HTTP 502 upstream".length);
  });

  test("a content array is measured on its text", () => {
    const r = resultOf(
      turn([
        { type: "text", text: "abc" },
        { type: "text", text: "defg" },
      ]),
    );
    expect(r?.size?.chars).toBe(7);
  });
});

describe("tool result size on the flow-log line", () => {
  const flow = {
    tenantId: 1n,
    turnId: "t",
    source: "inbox",
  } as unknown as FlowContext;
  let spy: ReturnType<typeof spyOn> | null = null;
  afterEach(() => spy?.mockRestore());

  const lineFor = (logValues: boolean, output: unknown) => {
    const lines: Array<{ detail?: Record<string, unknown> }> = [];
    spy = spyOn(flowlog, "emitFlowEvent").mockImplementation(((
      _f: unknown,
      e: { detail?: Record<string, unknown> },
    ) => {
      lines.push(e);
    }) as never);
    const logger = new ToolFlowLogger(flow, { logValues });
    logger.handleToolStart(
      {} as never,
      "{}",
      "r1",
      undefined,
      undefined,
      undefined,
      "catalog",
    );
    logger.handleToolEnd(output, "r1");
    return lines[0]?.detail ?? {};
  };

  test("with tool values off, the size is there and the value is not", () => {
    const d = lineFor(
      false,
      new ToolMessage({ content: BIG, tool_call_id: "c1", name: "catalog" }),
    );
    expect(JSON.stringify(d).includes("produto 399")).toBe(false);
    expect(d.resultSize).toEqual({
      chars: BIG.length,
      tokens: estimateTokenCount(BIG),
    });
  });

  test("with tool values on, the size rides beside the value", () => {
    const d = lineFor(
      true,
      new ToolMessage({ content: "ok", tool_call_id: "c1", name: "catalog" }),
    );
    expect(d.output).toBe("ok");
    expect(d.resultSize).toEqual({
      chars: 2,
      tokens: estimateTokenCount("ok"),
    });
  });

  test("a failure the tool returned carries its size", () => {
    const d = lineFor(
      false,
      new ToolMessage({
        content: "HTTP 502 upstream",
        tool_call_id: "c1",
        name: "catalog",
        status: "error",
      }),
    );
    expect((d.resultSize as { chars: number }).chars).toBe(17);
  });
});
