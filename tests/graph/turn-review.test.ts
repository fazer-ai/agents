import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";
import { contentToText } from "@/graph/message-text";
import { markRead, markReadOnly } from "@/graph/tools/reads";

// The turn review in the graph: a write call it flags never runs and the model reads why, a read is
// never reviewed, and a reply it flags is redone with the whole toolset and reviewed again. A made-up
// order desk; no real customer text.

type Step = {
  text: string;
  calls?: Array<{ name: string; args?: Record<string, unknown> }>;
};

// Answers by script and records, per call, the messages it saw and the tool names bound to it.
class BoundRecordingModel {
  seen: BaseMessage[][] = [];
  bound: string[][] = [];
  constructor(private steps: Step[]) {}
  private next(messages: BaseMessage[], names: string[]): AIMessage {
    this.seen.push(messages);
    this.bound.push(names);
    const step = this.steps[this.seen.length - 1];
    if (!step) return new AIMessage("");
    return new AIMessage({
      content: step.text,
      tool_calls: (step.calls ?? []).map((c, i) => ({
        name: c.name,
        args: c.args ?? {},
        id: `call_${this.seen.length}_${i}`,
      })),
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 10,
        total_tokens: 110,
      },
    });
  }
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    return this.next(messages, []);
  }
  bindTools(tools: Array<{ name: string }>) {
    const names = tools.map((t) => t.name);
    return { invoke: async (m: BaseMessage[]) => this.next(m, names) };
  }
}

const ran: string[] = [];
const buscarPedido = markReadOnly(
  markRead(
    tool(
      async () => {
        ran.push("buscar_pedido");
        return '{"pedido":"123","status":"em trânsito"}';
      },
      { name: "buscar_pedido", description: "pedido", schema: z.object({}) },
    ),
  ),
);
// A read whose result the model needs, with nothing saying it has no effect: an integration or MCP
// tool is marked this way, and it is reviewed.
const consultarAgenda = markRead(
  tool(
    async () => {
      ran.push("consultar_agenda");
      return '{"livre":"amanhã 10h"}';
    },
    { name: "consultar_agenda", description: "agenda", schema: z.object({}) },
  ),
);
const transferir = tool(
  async () => {
    ran.push("transferir");
    return "transferido";
  },
  { name: "transferir", description: "transfere", schema: z.object({}) },
);

const CALL_NOTE = "[Sistema] Revisão do turno: NOTA-DA-CHAMADA";
const REPLY_NOTE = "[Sistema] Revisão do turno: NOTA-DA-RESPOSTA";

async function run(
  model: BoundRecordingModel,
  hooks: {
    call?: (name: string) => string | null;
    reply?: (reply: string) => string | null;
  },
  opts: {
    history?: BaseMessage[];
    recoversReply?: () => boolean;
    halted?: () => boolean;
    stillWanted?: () => Promise<boolean>;
  } = {},
) {
  ran.length = 0;
  const calls: string[] = [];
  const replies: string[] = [];
  const canRedo: boolean[] = [];
  const graph = buildAgentGraph({
    primary: { provider: "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools: [buscarPedido, consultarAgenda, transferir],
    recoversReply: opts.recoversReply,
    turnReviewHalted: opts.halted,
    stillWanted: opts.stillWanted,
    reviewCall: async (_turn, call) => {
      calls.push(call.name);
      return hooks.call?.(call.name) ?? null;
    },
    reviewTurnReply: async (_turn, reply, o) => {
      replies.push(reply);
      canRedo.push(o?.canRedo ?? true);
      return hooks.reply?.(reply) ?? null;
    },
  });
  const out = await graph.invoke(
    {
      messages: opts.history ?? [
        new HumanMessage("Cadê meu pedido? Quero falar com alguém."),
      ],
    },
    { configurable: { thread_id: `tr-${Math.random()}` } },
  );
  return { messages: out.messages as BaseMessage[], calls, replies, canRedo };
}

const text = (m: BaseMessage | undefined) =>
  contentToText(m?.content ?? "").trim();

describe("the turn review in the graph", () => {
  test("a flagged write call does not run, the model reads the note, and the turn goes on", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "transferir" }] },
      { text: "Qual é o número do seu pedido?" },
    ]);
    const { messages, calls, replies } = await run(model, {
      call: (name) => (name === "transferir" ? CALL_NOTE : null),
    });
    expect(ran).toEqual([]);
    expect(calls).toEqual(["transferir"]);
    const answer = messages.find((m) => m.getType() === "tool") as ToolMessage;
    expect(text(answer)).toBe(CALL_NOTE);
    expect(answer.status).toBe("error");
    expect(
      model.seen[1]?.some(
        (m) => text(m) === CALL_NOTE && m.getType() === "tool",
      ),
    ).toBe(true);
    expect(text(messages.at(-1))).toBe("Qual é o número do seu pedido?");
    expect(replies).toEqual(["Qual é o número do seu pedido?"]);
  });

  test("a read is never reviewed, and a clean write runs", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "buscar_pedido" }, { name: "transferir" }] },
      { text: "Pronto, transferi." },
    ]);
    const { calls } = await run(model, {});
    expect(calls).toEqual(["transferir"]);
    expect(ran.sort()).toEqual(["buscar_pedido", "transferir"]);
  });

  test("beside a flagged write, the read of the same step still runs", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "buscar_pedido" }, { name: "transferir" }] },
      { text: "Seu pedido está em trânsito." },
    ]);
    const { messages } = await run(model, { call: () => CALL_NOTE });
    expect(ran).toEqual(["buscar_pedido"]);
    expect(
      messages.filter((m) => m.getType() === "tool").map((m) => text(m)),
    ).toContain(CALL_NOTE);
  });

  test("a flagged reply is redone with the whole toolset, its call is reviewed, and the draft never reaches the thread", async () => {
    const model = new BoundRecordingModel([
      { text: "Vou te passar para a equipe." },
      { text: "", calls: [{ name: "transferir" }] },
      { text: "Pronto, a equipe já vai te atender." },
    ]);
    const { messages, calls, replies } = await run(model, {
      reply: (r) => (r === "Vou te passar para a equipe." ? REPLY_NOTE : null),
    });
    expect(model.bound[1]).toEqual([
      "buscar_pedido",
      "consultar_agenda",
      "transferir",
    ]);
    expect(
      model.seen[1]?.some(
        (m) => m.getType() === "system" && text(m).includes(REPLY_NOTE),
      ),
    ).toBe(true);
    expect(calls).toEqual(["transferir"]);
    expect(ran).toEqual(["transferir"]);
    expect(replies).toEqual([
      "Vou te passar para a equipe.",
      "Pronto, a equipe já vai te atender.",
    ]);
    expect(
      messages.some((m) => text(m) === "Vou te passar para a equipe."),
    ).toBe(false);
    expect(text(messages.at(-1))).toBe("Pronto, a equipe já vai te atender.");
  });

  test("a redone reply is reviewed again, and the loop ends when the review lets it go", async () => {
    const model = new BoundRecordingModel([
      { text: "rascunho 1" },
      { text: "rascunho 2" },
      { text: "rascunho 3" },
    ]);
    let notes = 2;
    const { messages, replies } = await run(model, {
      reply: () => (notes-- > 0 ? REPLY_NOTE : null),
    });
    expect(replies).toEqual(["rascunho 1", "rascunho 2", "rascunho 3"]);
    expect(text(messages.at(-1))).toBe("rascunho 3");
    expect(model.seen).toHaveLength(3);
  });

  test("a read-only tool is not reviewed, and a read that may have effects is", async () => {
    const model = new BoundRecordingModel([
      {
        text: "",
        calls: [{ name: "buscar_pedido" }, { name: "consultar_agenda" }],
      },
      { text: "Seu pedido está em trânsito." },
    ]);
    const { calls } = await run(model, {});
    expect(calls).toEqual(["consultar_agenda"]);
  });

  test("a turn called off while the review ran refuses the call instead of running it", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "transferir" }] },
      { text: "Pronto." },
    ]);
    let reads = 0;
    const { calls, messages } = await run(
      model,
      {},
      {
        // Wanted at the veto before the review, gone by the read after it.
        stillWanted: async () => reads++ === 0,
      },
    );
    expect(calls).toEqual(["transferir"]);
    expect(ran).toEqual([]);
    expect(model.seen).toHaveLength(1);
    expect(text(messages.at(-1))).toBe("");
  });

  test("a review that held ends the round with every call refused", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "buscar_pedido" }, { name: "transferir" }] },
      { text: "Pronto." },
    ]);
    const { calls, messages } = await run(model, {}, { halted: () => true });
    expect(calls).toEqual(["transferir"]);
    expect(ran).toEqual([]);
    expect(model.seen).toHaveLength(1);
    expect(messages.filter((m) => m.getType() === "tool")).toHaveLength(2);
    expect(text(messages.at(-1))).toBe("");
  });

  test("the reply written beside an earlier call is reviewed, and a flagged one leaves the thread before the redo", async () => {
    const model = new BoundRecordingModel([
      {
        text: "Vou te passar para a equipe.",
        calls: [{ name: "buscar_pedido" }],
      },
      { text: "" },
      { text: "Seu pedido está em trânsito." },
    ]);
    const { messages, replies } = await run(
      model,
      {
        reply: (r) =>
          r === "Vou te passar para a equipe." ? REPLY_NOTE : null,
      },
      { recoversReply: () => true },
    );
    expect(replies).toEqual([
      "Vou te passar para a equipe.",
      "Seu pedido está em trânsito.",
    ]);
    expect(
      messages.some((m) => text(m) === "Vou te passar para a equipe."),
    ).toBe(false);
    expect(text(messages.at(-1))).toBe("Seu pedido está em trânsito.");
  });

  test("on a stalled turn the recovered reply is reviewed with no redo, and a flagged one leaves the thread", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "buscar_pedido" }] },
    ]);
    const { messages, replies, canRedo } = await run(
      model,
      { reply: () => REPLY_NOTE },
      {
        recoversReply: () => true,
        history: [
          new HumanMessage("Cadê meu pedido?"),
          new AIMessage({
            content: "Vou te passar para a equipe.",
            tool_calls: [{ name: "buscar_pedido", args: {}, id: "call_1_0" }],
          }),
          new ToolMessage({
            content: '{"pedido":"123"}',
            tool_call_id: "call_1_0",
            name: "buscar_pedido",
          }),
        ],
      },
    );
    expect([replies, canRedo]).toEqual([
      ["Vou te passar para a equipe."],
      [false],
    ]);
    expect(model.seen).toHaveLength(1);
    expect(
      messages.some((m) => text(m) === "Vou te passar para a equipe."),
    ).toBe(false);
  });
});
