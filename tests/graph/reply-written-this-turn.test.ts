import { describe, expect, test } from "bun:test";
import { AIMessage, HumanMessage, ToolMessage } from "@langchain/core/messages";
import { replyWrittenThisTurn } from "@/graph/graph";

// The text a model wrote beside a tool call, read back when the turn ends empty. The
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

  test("a `—` beside a call is no reply, and does not hide an earlier one", () => {
    const msgs = [
      new HumanMessage("oi"),
      new AIMessage({ content: "um", tool_calls: [call("set_labels", "c1")] }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage({ content: "—", tool_calls: [call("set_labels", "c2")] }),
      new ToolMessage({ content: "ok", tool_call_id: "c2" }),
      // The same dash as a block list, the shape Anthropic returns.
      new AIMessage({
        content: [{ type: "text", text: "..." }],
        tool_calls: [call("set_labels", "c3")],
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c3" }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("um");
  });

  // Anthropic hid the answer written before the last call (the 5.5 models under `display:
  // "updates"`): the preamble before it is not the reply, and nothing written this turn can be.
  test("a preamble before a hidden note is not recovered", () => {
    const msgs = [
      new HumanMessage("quero ver o conteúdo do curso"),
      new AIMessage({
        content: [{ type: "text", text: "Vou buscar o conteúdo." }],
        tool_calls: [call("search_knowledge", "c1")],
      }),
      new ToolMessage({ content: "5 módulos", tool_call_id: "c1" }),
      new AIMessage({
        content: [
          {
            type: "thinking",
            thinking:
              "O curso tem 5 módulos; a matrícula está no link que eu deixei acima.",
            signature: "sig",
          },
        ],
        tool_calls: [call("set_labels", "c2")],
        response_metadata: { model_provider: "anthropic" },
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c2" }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("");
  });

  test("text written after a hidden note is still the reply", () => {
    const msgs = [
      new HumanMessage("oi"),
      new AIMessage({
        content: [{ type: "thinking", thinking: "nota", signature: "sig" }],
        tool_calls: [call("search_knowledge", "c1")],
        response_metadata: { model_provider: "anthropic" },
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage({
        content: "Aqui está.",
        tool_calls: [call("set_labels", "c2")],
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c2" }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("Aqui está.");
  });

  test("an empty thinking block (display omitted, or reasoning) is no hidden note", () => {
    const msgs = [
      new HumanMessage("oi"),
      new AIMessage({
        content: "Vou ver.",
        tool_calls: [call("search_knowledge", "c1")],
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage({
        content: [{ type: "thinking", thinking: "", signature: "sig" }],
        tool_calls: [call("set_labels", "c2")],
        response_metadata: { model_provider: "anthropic" },
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c2" }),
      new AIMessage(""),
    ];
    expect(replyWrittenThisTurn(msgs)).toBe("Vou ver.");
  });

  test("in one message, a note after the preamble wins; text after the note is the reply", () => {
    const turn = (content: unknown[]) => [
      new HumanMessage("oi"),
      new AIMessage({
        content: content as never,
        tool_calls: [call("set_labels", "c1")],
        response_metadata: { model_provider: "anthropic" },
      }),
      new ToolMessage({ content: "ok", tool_call_id: "c1" }),
      new AIMessage(""),
    ];
    const note = { type: "thinking", thinking: "nota", signature: "sig" };
    expect(
      replyWrittenThisTurn(turn([{ type: "text", text: "Vou buscar." }, note])),
    ).toBe("");
    expect(
      replyWrittenThisTurn(turn([note, { type: "text", text: "Aqui está." }])),
    ).toBe("Aqui está.");
  });
});
