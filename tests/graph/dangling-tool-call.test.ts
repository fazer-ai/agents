import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import { buildAgentGraph } from "@/graph/graph";
import {
  SKIP_REPLY_ACK,
  SKIP_REPLY_MARK,
  SKIP_REPLY_TOOL,
} from "@/graph/silence";
import { buildThreadStateGraph } from "@/graph/thread-state";
import { buildNativeTools } from "@/graph/tools/native";
import {
  assistantCalling,
  orphansIn,
  replayedCallIds,
  StrictProvider,
} from "@/tests/utils/strict-provider";

function build(
  model: StrictProvider,
  checkpointer = new MemorySaver(),
  repairs: { calls: number }[] = [],
) {
  const graph = buildAgentGraph({
    primary: { provider: "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer,
    onDanglingToolCalls: (info) => repairs.push(info),
  });
  return { graph, repairs, checkpointer };
}

describe("an assistant message whose tool calls never got their output", () => {
  test("the next turn answers, and the provider never sees the unanswered call", async () => {
    const model = new StrictProvider("resposta recuperada");
    const { graph, repairs } = build(model);
    const cfg = { configurable: { thread_id: "dangling-1" } };
    const out = await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "qual o horário do show?" }),
          assistantCalling("ai1", ["call_interrompida"]),
          new HumanMessage({ id: "h2", content: "pode responder agora?" }),
        ],
      },
      cfg,
    );
    expect(out.messages.at(-1)?.content).toBe("resposta recuperada");
    expect(model.seen).toHaveLength(1);
    const sent = model.seen[0] ?? [];
    expect(orphansIn(sent)).toEqual([]);
    // the conversation around the interrupted call is still there
    expect(sent.map((m) => m.content)).toContain("qual o horário do show?");
    expect(sent.map((m) => m.content)).toContain("pode responder agora?");
    expect(repairs).toEqual([{ calls: 1 }]);
    // and the repair is in the thread, not only in what this round sent
    expect(orphansIn(out.messages)).toEqual([]);
  });

  test("the repair is written once: the turn after it reads a clean thread", async () => {
    const model = new StrictProvider("primeira");
    const { graph, repairs } = build(model);
    const cfg = { configurable: { thread_id: "dangling-2" } };
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "oi" }),
          assistantCalling("ai1", ["call_persistencia"]),
          new HumanMessage({ id: "h2", content: "alô?" }),
        ],
      },
      cfg,
    );
    expect(repairs).toHaveLength(1);
    const second = await graph.invoke(
      { messages: [new HumanMessage({ id: "h3", content: "e agora?" })] },
      cfg,
    );
    expect(repairs).toHaveLength(1);
    expect(second.messages.map((m) => m.content)).toContain("primeira");
    expect(orphansIn(model.seen.at(-1) ?? [])).toEqual([]);
  });

  test("a re-engage with nothing new after the interrupted call still answers", async () => {
    const model = new StrictProvider("resposta do reengage");
    const { graph, repairs } = build(model);
    const out = await graph.invoke(
      {
        messages: [
          new HumanMessage({
            id: "h1",
            content: "o ingresso dá direito a tudo?",
          }),
          assistantCalling("ai1", ["call_reengage"]),
        ],
      },
      { configurable: { thread_id: "dangling-3" } },
    );
    expect(out.messages.at(-1)?.content).toBe("resposta do reengage");
    expect(orphansIn(model.seen[0] ?? [])).toEqual([]);
    expect(repairs).toEqual([{ calls: 1 }]);
  });

  test("a parallel batch with one output missing keeps the call that ran, with its result", async () => {
    const model = new StrictProvider("lote recuperado");
    const { graph, repairs } = build(model);
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "dois eventos" }),
          assistantCalling("ai1", ["call_parcial_a", "call_parcial_b"]),
          new ToolMessage({
            id: "t1",
            tool_call_id: "call_parcial_a",
            name: "consultar_evento",
            content: "resultado real de a",
          }),
          new HumanMessage({ id: "h2", content: "e então?" }),
        ],
      },
      { configurable: { thread_id: "dangling-4" } },
    );
    const sent = model.seen[0] ?? [];
    expect(orphansIn(sent)).toEqual([]);
    const ai = sent.find((m) => m.id === "ai1") as AIMessage | undefined;
    expect(ai ? replayedCallIds(ai) : []).toEqual(["call_parcial_a"]);
    const result = sent.find((m) => m.id === "t1");
    expect(result?.content).toBe("resultado real de a");
    expect(repairs).toEqual([{ calls: 1 }]);
  });

  test("text the model wrote beside the interrupted call stays in the history", async () => {
    const model = new StrictProvider("ok");
    const { graph } = build(model);
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "oi" }),
          assistantCalling("ai1", ["call_x"], "Vou consultar o evento."),
          new HumanMessage({ id: "h2", content: "e aí?" }),
        ],
      },
      { configurable: { thread_id: "dangling-5" } },
    );
    const sent = model.seen[0] ?? [];
    expect(orphansIn(sent)).toEqual([]);
    const ai = sent.find((m) => m.id === "ai1") as AIMessage | undefined;
    expect(ai?.content).toBe("Vou consultar o evento.");
  });
});

describe("the shapes an unanswered call can be stored in", () => {
  test("a call id the model reused later does not count as answering the first one", async () => {
    const model = new StrictProvider("ok");
    const { graph, repairs } = build(model);
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "oi" }),
          assistantCalling("ai1", ["call_0"]),
          new HumanMessage({ id: "h2", content: "e aí?" }),
          assistantCalling("ai2", ["call_0"]),
          new ToolMessage({
            id: "t1",
            tool_call_id: "call_0",
            name: "consultar_evento",
            content: "resultado",
          }),
          new AIMessage({ id: "ai3", content: "pronto" }),
          new HumanMessage({ id: "h3", content: "valeu" }),
        ],
      },
      { configurable: { thread_id: "reused-id" } },
    );
    expect(orphansIn(model.seen[0] ?? [])).toEqual([]);
    expect(repairs).toEqual([{ calls: 1 }]);
  });

  test("the reasoning that led to the dropped call goes with it", async () => {
    const model = new StrictProvider("ok");
    const { graph } = build(model);
    const stored = assistantCalling("ai1", ["call_feita", "call_perdida"]);
    const [first, done, lost] = stored.response_metadata.output as unknown[];
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "oi" }),
          new AIMessage({
            id: "ai1",
            content: "",
            tool_calls: stored.tool_calls,
            response_metadata: {
              output: [
                first,
                done,
                { type: "reasoning", id: "rs_2", summary: [] },
                lost,
              ],
            },
          }),
          new ToolMessage({
            id: "t1",
            tool_call_id: "call_feita",
            name: "consultar_evento",
            content: "resultado",
          }),
          new HumanMessage({ id: "h2", content: "e aí?" }),
        ],
      },
      { configurable: { thread_id: "interleaved-reasoning" } },
    );
    expect(model.seen).toHaveLength(1);
    const ai = (model.seen[0] ?? []).find((m) => m.id === "ai1") as AIMessage;
    expect(ai.response_metadata.output).toEqual([first, done]);
  });

  test("Anthropic's tool_use block goes with the call it carries", async () => {
    const model = new StrictProvider("ok");
    const { graph } = build(model);
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "oi" }),
          new AIMessage({
            id: "ai1",
            content: [
              { type: "text", text: "Consultando." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "consultar_evento",
                input: {},
              },
            ],
            tool_calls: [
              {
                id: "toolu_1",
                name: "consultar_evento",
                args: {},
                type: "tool_call",
              },
            ],
          }),
          new HumanMessage({ id: "h2", content: "e aí?" }),
        ],
      },
      { configurable: { thread_id: "anthropic-block" } },
    );
    const sent = model.seen[0] ?? [];
    expect(orphansIn(sent)).toEqual([]);
    const ai = sent.find((m) => m.id === "ai1") as AIMessage | undefined;
    expect(ai?.content).toEqual([{ type: "text", text: "Consultando." }]);
  });

  test("reasoning kept only in additional_kwargs is not left with nothing to follow it", async () => {
    const model = new StrictProvider("ok");
    const { graph } = build(model);
    const stored = assistantCalling("ai1", ["call_y"]);
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "oi" }),
          new AIMessage({
            id: "ai1",
            content: "",
            tool_calls: stored.tool_calls,
            additional_kwargs: {
              reasoning: { id: "rs_1", type: "reasoning", summary: [] },
            },
          }),
          new HumanMessage({ id: "h2", content: "e aí?" }),
        ],
      },
      { configurable: { thread_id: "kwargs-reasoning" } },
    );
    expect(model.seen).toHaveLength(1);
  });
});

describe("a repaired message the same round also rewrites", () => {
  // The silence decision blanks the text beside it by replacing the calling message, and that can be
  // the message the repair replaced: a parallel batch whose `skip_reply` ran and whose companion
  // never did. The reducer applies the later replacement, so the repair has to come first.
  test("the text beside a silence decision still leaves the channel", async () => {
    const skip = buildNativeTools({ client: {} as never, conversationId: 1 }, [
      SKIP_REPLY_TOOL,
    ]).find((t) => t.name === SKIP_REPLY_TOOL);
    if (!skip) throw new Error("skip_reply is not in the native catalog");
    const model = new StrictProvider("");
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skip],
    });
    const cfg = { configurable: { thread_id: "repair-and-silence" } };
    await graph.invoke(
      {
        messages: [
          new HumanMessage({ id: "h1", content: "ok, obrigado" }),
          new AIMessage({
            id: "ai1",
            content: "Vou deixar quieto por ora.",
            tool_calls: [
              {
                id: "call_skip",
                name: SKIP_REPLY_TOOL,
                args: { reason: "acknowledged" },
                type: "tool_call",
              },
              {
                id: "call_perdida",
                name: "consultar_evento",
                args: {},
                type: "tool_call",
              },
            ],
          }),
          new ToolMessage({
            id: "t1",
            tool_call_id: "call_skip",
            name: SKIP_REPLY_TOOL,
            content: SKIP_REPLY_ACK,
            additional_kwargs: { [SKIP_REPLY_MARK]: true },
          }),
        ],
      },
      cfg,
    );
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const stored = (state.values.messages as BaseMessage[]).find(
      (m) => m.id === "ai1",
    ) as AIMessage;
    expect(stored.tool_calls?.map((c) => c.id)).toEqual(["call_skip"]);
    expect(stored.content).not.toContain("Vou deixar quieto por ora.");
  });
});

describe("a history whose tool calls all have their outputs", () => {
  test("is sent unchanged, parallel calls included, and nothing is reported", async () => {
    const model = new StrictProvider("ok");
    const { graph, repairs } = build(model);
    const history = [
      new HumanMessage({ id: "h1", content: "dois eventos" }),
      assistantCalling("ai1", ["call_completa_a", "call_completa_b"]),
      new ToolMessage({
        id: "t1",
        tool_call_id: "call_completa_a",
        name: "consultar_evento",
        content: "resultado a",
      }),
      new ToolMessage({
        id: "t2",
        tool_call_id: "call_completa_b",
        name: "consultar_evento",
        content: "resultado b",
      }),
      new AIMessage({ id: "ai2", content: "aqui estão os dois" }),
      new HumanMessage({ id: "h2", content: "obrigado" }),
    ];
    await graph.invoke(
      { messages: history },
      { configurable: { thread_id: "complete-1" } },
    );
    const sent = (model.seen[0] ?? []).slice(1);
    expect(sent.map((m) => m.id)).toEqual(history.map((m) => m.id));
    const ai = sent[1] as AIMessage;
    expect(replayedCallIds(ai).sort()).toEqual([
      "call_completa_a",
      "call_completa_b",
    ]);
    expect(ai.response_metadata).toEqual(history[1]?.response_metadata ?? {});
    expect(repairs).toEqual([]);
  });

  test("a first turn on an empty thread reports nothing", async () => {
    const model = new StrictProvider("primeira resposta");
    const { graph, repairs } = build(model);
    const out = await graph.invoke(
      { messages: [new HumanMessage({ id: "h1", content: "Olá" })] },
      { configurable: { thread_id: "empty-1" } },
    );
    expect(out.messages.at(-1)?.content).toBe("primeira resposta");
    expect(repairs).toEqual([]);
  });
});
