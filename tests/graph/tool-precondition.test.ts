import { describe, expect, test } from "bun:test";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { z } from "zod";
import {
  applyToolPreconditions,
  guardedTool,
} from "@/graph/tools/precondition";
import type { ToolPrecondition } from "@/modules/agents/tool-preconditions";

const COND: ToolPrecondition = {
  kind: "attribute",
  scope: "conversation",
  key: "article_url",
};

// The side effect the issue is about: `handoff_to_human` reassigns the conversation and posts, and
// none of that is undoable. A stub that RECORDS the effect is the only way a test can tell "refused"
// from "ran and returned something that reads like a refusal".
function spyTool(name = "handoff_to_human") {
  const calls: unknown[] = [];
  const t = tool(
    async (input: unknown) => {
      calls.push(input);
      return "Handed off to a human (status set to open).";
    },
    {
      name,
      description: "Escalate the conversation to a human agent.",
      schema: z.object({ reason: z.string().optional() }),
    },
  ) as unknown as StructuredToolInterface;
  return { tool: t, calls };
}

const met = async () => ({
  conversationAttributes: { article_url: "https://financefootball.com/x" },
  contactAttributes: {},
});
const unmet = async () => ({
  conversationAttributes: {},
  contactAttributes: {},
});

describe("guardedTool", () => {
  test("runs the tool when the precondition is met", async () => {
    const { tool: inner, calls } = spyTool();
    const out = await guardedTool(inner, COND, met).invoke({ reason: "2" });
    expect(calls).toHaveLength(1);
    expect(String(out)).toContain("Handed off");
  });

  test("does NOT run the tool when the precondition is unmet", async () => {
    const { tool: inner, calls } = spyTool();
    const out = await guardedTool(inner, COND, unmet).invoke({ reason: "2" });
    expect(calls).toHaveLength(0);
    expect(String(out)).toContain("was not run");
    expect(String(out)).toContain("article_url");
  });

  test("fails CLOSED when the state cannot be read", async () => {
    const { tool: inner, calls } = spyTool();
    const boom = async () => {
      throw new Error("connection terminated");
    };
    const out = await guardedTool(inner, COND, boom).invoke({ reason: "2" });
    expect(calls).toHaveLength(0);
    expect(String(out)).toContain("was not run");
  });

  test("reports the refusal once, with the tool and the condition", async () => {
    const seen: Array<{ tool: string; cond: ToolPrecondition }> = [];
    const { tool: inner } = spyTool();
    await guardedTool(inner, COND, unmet, (i) => seen.push(i)).invoke({});
    expect(seen).toEqual([{ tool: "handoff_to_human", cond: COND }]);
  });

  test("reports nothing when the tool actually ran", async () => {
    const seen: unknown[] = [];
    const { tool: inner } = spyTool();
    await guardedTool(inner, COND, met, (i) => seen.push(i)).invoke({});
    expect(seen).toEqual([]);
  });

  test("keeps the tool's identity, so the model sees no difference", () => {
    const { tool: inner } = spyTool();
    const guarded = guardedTool(inner, COND, unmet);
    expect(guarded.name).toBe(inner.name);
    expect(guarded.description).toBe(inner.description);
    expect(guarded.schema).toBe(inner.schema);
  });

  test("the state is read per CALL, not once at wrap time", async () => {
    const { tool: inner, calls } = spyTool();
    // The turn the issue describes: the value arrives mid-turn (set_custom_attribute writes it) and
    // the guarded call comes after. A state captured at wrap time would refuse this.
    let attributes: Record<string, unknown> = {};
    const guarded = guardedTool(inner, COND, async () => ({
      conversationAttributes: attributes,
      contactAttributes: {},
    }));
    await guarded.invoke({});
    expect(calls).toHaveLength(0);
    attributes = { article_url: "https://financefootball.com/x" };
    await guarded.invoke({});
    expect(calls).toHaveLength(1);
  });
});

describe("guardedTool under ToolNode", () => {
  test("the refusal reaches the model as this call's ToolMessage", async () => {
    const { tool: inner, calls } = spyTool();
    const node = new ToolNode([guardedTool(inner, COND, unmet)]);
    const out = (await node.invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [
            { id: "call_1", name: "handoff_to_human", args: { reason: "2" } },
          ],
        }),
      ],
    })) as { messages: ToolMessage[] };
    expect(calls).toHaveLength(0);
    const answer = out.messages[0];
    expect(answer).toBeInstanceOf(ToolMessage);
    // Bound to THIS call, or the model cannot tell which of a batch of calls was refused.
    expect(answer?.tool_call_id).toBe("call_1");
    expect(String(answer?.content)).toContain("was not run");
  });

  test("a refusal is not an error: the turn continues", async () => {
    const { tool: inner } = spyTool();
    const node = new ToolNode([guardedTool(inner, COND, unmet)]);
    const out = (await node.invoke({
      messages: [
        new AIMessage({
          content: "",
          tool_calls: [{ id: "c", name: "handoff_to_human", args: {} }],
        }),
      ],
    })) as { messages: ToolMessage[] };
    // `status: "error"` is what tools/failure.ts marks an INTEGRATION failure with, and the flow
    // logger reads it to page an alert channel. A rule doing its job must not page anyone.
    expect(out.messages[0]?.status).not.toBe("error");
  });
});

describe("applyToolPreconditions", () => {
  test("returns the very same array when nothing is configured", () => {
    const { tool: a } = spyTool("a");
    const tools = [a];
    expect(applyToolPreconditions(tools, {}, unmet)).toBe(tools);
  });

  test("wraps only the named tool, and leaves its siblings identical", async () => {
    const { tool: guardedInner, calls: guardedCalls } = spyTool("guarded");
    const { tool: openInner, calls: openCalls } = spyTool("open");
    const out = applyToolPreconditions(
      [guardedInner, openInner],
      { guarded: COND },
      unmet,
    );
    expect(out[1]).toBe(openInner);
    await out[0]?.invoke({});
    await out[1]?.invoke({});
    expect(guardedCalls).toHaveLength(0);
    expect(openCalls).toHaveLength(1);
  });

  test("a condition naming a tool the agent was not granted changes nothing", () => {
    const { tool: a } = spyTool("a");
    const out = applyToolPreconditions([a], { not_granted: COND }, unmet);
    expect(out[0]).toBe(a);
  });
});
