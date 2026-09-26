import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { replyWrittenThisTurn } from "@/graph/graph";

// Issue #886: the text a model wrote beside a tool call, read back when the turn ends empty. The
// bound is the LAST human message, the same one `silenceWasChosen` uses: the thread is checkpointed
// per contact-inbox, so an answer given in an earlier turn is in this history and must not be sent
// again now.
const call = (name: string, id: string) => ({ name, args: {}, id });

describe("replyWrittenThisTurn", () => {
  test("returns the text beside a tool call in this turn", () => {
    const msgs = [
      new HumanMessage("qual o prazo?"),
      new AIMessage({
        content: "7 dias.",
        tool_calls: [call("resolve_conversation", "c1")],
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("7 dias.");
  });

  test("the last text wins when there are several", () => {
    const msgs = [
      new HumanMessage("oi"),
      new AIMessage({ content: "um", tool_calls: [call("set_labels", "c1")] }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage({
        content: [{ type: "text", text: "dois" }],
        tool_calls: [call("resolve_conversation", "c2")],
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c2" }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("dois");
  });

  test("text from an earlier turn is not this turn's reply", () => {
    const msgs = [
      new HumanMessage("qual o prazo?"),
      new AIMessage("7 dias."),
      new HumanMessage("obrigada"),
      new AIMessage({ content: "", tool_calls: [call("set_labels", "c1")] }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("");
  });

  test("nothing is recovered in a turn that called skip_reply", () => {
    const msgs = [
      new HumanMessage("ok"),
      new AIMessage({ content: "tá", tool_calls: [call("set_labels", "c1")] }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage({ content: "", tool_calls: [call("skip_reply", "c2")] }),
      new ToolMessage({
        content: "skipped",
        tool_call_id: "c2",
        name: "skip_reply",
      }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("");
  });

  test("the final message is not read: whether it said anything is the caller's question", () => {
    const msgs = [
      new HumanMessage("oi"),
      new AIMessage({ content: "um", tool_calls: [call("set_labels", "c1")] }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage("final"),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("um");
  });
});
