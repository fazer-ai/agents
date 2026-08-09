import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { z } from "zod";
import { failableTool, toolFailure } from "@/graph/tools/failure";

// NOTE: failableTool contract (issue #40): a toolFailure(...) return surfaces to the model as the SAME
// friendly string, but wrapped in a ToolMessage with status "error" so ToolFlowLogger can log the
// call as a failure. Without a tool_call in scope it degrades to the plain string (old behavior).

const MSG = "Provider returned HTTP 500.";

const probe = failableTool(
  async (input: { fail?: boolean }) => (input.fail ? toolFailure(MSG) : "ok"),
  {
    name: "probe",
    description: "failure probe",
    schema: z.object({ fail: z.boolean().optional() }),
  },
);

describe("failableTool", () => {
  test("a failure invoked as a tool_call becomes a ToolMessage with status error", async () => {
    const out = await probe.invoke({
      type: "tool_call",
      id: "call_1",
      name: "probe",
      args: { fail: true },
    });
    expect(out).toBeInstanceOf(ToolMessage);
    const tm = out as ToolMessage;
    expect(tm.status).toBe("error");
    expect(tm.content).toBe(MSG);
    expect(tm.tool_call_id).toBe("call_1");
    expect(tm.name).toBe("probe");
  });

  test("a failure invoked with plain args degrades to the plain string", async () => {
    expect(await probe.invoke({ fail: true })).toBe(MSG);
  });

  test("the success path is untouched", async () => {
    expect(await probe.invoke({})).toBe("ok");
    const wrapped = (await probe.invoke({
      type: "tool_call",
      id: "call_2",
      name: "probe",
      args: {},
    })) as ToolMessage;
    expect(wrapped.status).toBe("success");
    expect(wrapped.content).toBe("ok");
  });
});
