import { describe, expect, test } from "bun:test";
import { ToolMessage } from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { toVoiceTools } from "@/modules/voice-call/tools";

// A tool that failed without throwing (an HTTP 500, a refused contact update) answers a ToolMessage
// marked as an error; on a call it is a failed tool, not a result the agent reads as success.

describe("the agent's tools on a call", () => {
  test("a tool that answers an error is a failure, one that answers a result is not", async () => {
    const failing = tool(
      async () =>
        new ToolMessage({
          content: "HTTP 500",
          tool_call_id: "c1",
          status: "error",
        }),
      { name: "consulta", description: "d", schema: z.object({}) },
    );
    const working = tool(async () => "livre às 10h", {
      name: "agenda",
      description: "d",
      schema: z.object({}),
    });
    const [bad, good] = toVoiceTools([failing, working]);
    await expect(bad?.invoke({}, "c1")).rejects.toThrow("HTTP 500");
    expect(await good?.invoke({}, "c2")).toBe("livre às 10h");
  });
});
