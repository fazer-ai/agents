import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph, type RevisionInfo } from "@/graph/graph";
import { contentToText } from "@/graph/message-text";
import { admitRevisionCalls } from "@/graph/revision-calls";
import { markRead, markReadOnly } from "@/graph/tools/reads";

// The factual-grounding rewrite that may consult the check's sources: which tools it is handed, what
// runs when it asks for another one, the cap on its calls, and the second review of what it wrote.
// A made-up price list; no real customer text.

type Step = {
  text: string;
  calls?: Array<{ name: string; args?: Record<string, unknown> }>;
  usage?: { input_tokens: number; output_tokens: number };
};

// Answers by script and records, per call, which tool names were bound to it ("raw" when none).
class BoundRecordingModel {
  seen: BaseMessage[][] = [];
  bound: string[][] = [];
  constructor(private steps: Step[]) {}
  private next(messages: BaseMessage[], names: string[]): AIMessage {
    this.seen.push(messages);
    this.bound.push(names);
    const step = this.steps[this.seen.length - 1];
    if (!step) return new AIMessage("");
    const usage = step.usage ?? { input_tokens: 100, output_tokens: 10 };
    return new AIMessage({
      content: step.text,
      tool_calls: (step.calls ?? []).map((c, i) => ({
        name: c.name,
        args: c.args ?? {},
        id: `call_${this.seen.length}_${i}`,
      })),
      usage_metadata: {
        ...usage,
        total_tokens: usage.input_tokens + usage.output_tokens,
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
const consultarPreco = markReadOnly(
  tool(
    async () => {
      ran.push("consultar_preco");
      return '{"evento":"Show X","preco":"187 créditos"}';
    },
    {
      name: "consultar_preco",
      description: "preço do ingresso",
      schema: z.object({}),
    },
  ),
);
const abrirChamado = tool(
  async () => {
    ran.push("abrir_chamado");
    return "chamado aberto";
  },
  { name: "abrir_chamado", description: "abre chamado", schema: z.object({}) },
);
// An MCP or integration tool: a read for an observation, and still able to send an e-mail.
const enviarEmail = markRead(
  tool(
    async () => {
      ran.push("enviar_email");
      return "enviado";
    },
    { name: "enviar_email", description: "envia e-mail", schema: z.object({}) },
  ),
);
const setLabels = tool(
  async () => {
    ran.push("set_labels");
    return "ok";
  },
  { name: "set_labels", description: "etiquetas", schema: z.object({}) },
);

const NOTE = "[Sistema] Revisão factual: NOTA-DE-TESTE";

async function run(
  model: BoundRecordingModel,
  opts: {
    sourceTools?: string[];
    maxToolCalls?: number;
    turnMax?: number;
    second?: (turn: BaseMessage[], reply: string, info: RevisionInfo) => void;
    revised?: string[];
    plan?: boolean;
  } = {},
) {
  ran.length = 0;
  let reviews = 0;
  const graph = buildAgentGraph({
    primary: { provider: "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools: [consultarPreco, abrirChamado, setLabels, enviarEmail],
    maxToolCalls: opts.turnMax,
    reviewReply: async () => (reviews++ === 0 ? NOTE : null),
    revisionPlan:
      opts.plan === false
        ? undefined
        : () => ({
            sourceTools: opts.sourceTools ?? ["consultar_preco"],
            maxToolCalls: opts.maxToolCalls ?? 3,
            review: async (turn, reply, info) => {
              opts.second?.(turn, reply, info);
            },
          }),
    onReplyRevised: (t) => opts.revised?.push(t),
    recoversReply: () => true,
  });
  const out = await graph.invoke(
    { messages: [new HumanMessage("Quanto custa o ingresso do Show X?")] },
    { configurable: { thread_id: `rt-${Math.random()}` } },
  );
  return { messages: out.messages as BaseMessage[], reviews };
}

const text = (m: BaseMessage | undefined) =>
  contentToText(m?.content ?? "").trim();

describe("a rewrite that may consult the sources", () => {
  // The bug it catches: the rewrite ran without tools, so a price the agent never looked up could only
  // be dropped or turned into "I don't have that information", never corrected from the source.
  test("calls the source, writes from its result, and the second review sees that call", async () => {
    const model = new BoundRecordingModel([
      { text: "O ingresso custa 120 créditos." },
      { text: "", calls: [{ name: "consultar_preco" }] },
      {
        text: "O ingresso custa 187 créditos.",
        usage: { input_tokens: 300, output_tokens: 20 },
      },
    ]);
    const seconds: Array<{
      reply: string;
      info: RevisionInfo;
      results: string[];
    }> = [];
    const revised: string[] = [];
    const { messages } = await run(model, {
      revised,
      second: (turn, reply, info) =>
        seconds.push({
          reply,
          info,
          results: turn
            .filter((m) => m.getType() === "tool")
            .map((m) => text(m)),
        }),
    });
    expect(model.bound[1]).toEqual(["consultar_preco"]);
    expect(ran).toEqual(["consultar_preco"]);
    expect(text(messages.at(-1))).toBe("O ingresso custa 187 créditos.");
    expect(messages.some((m) => text(m).includes("120,00"))).toBe(false);
    expect(seconds).toHaveLength(1);
    expect(seconds[0]?.reply).toBe("O ingresso custa 187 créditos.");
    expect(seconds[0]?.results).toEqual([
      '{"evento":"Show X","preco":"187 créditos"}',
    ]);
    expect(seconds[0]?.info).toMatchObject({
      toolCalls: 1,
      tools: ["consultar_preco"],
      refused: [],
      inputTokens: 400,
      outputTokens: 30,
    });
    expect(revised).toEqual(["O ingresso custa 187 créditos."]);
    // The rewrite's call is in the thread, answered, for the next turn to read as a source.
    const caller = messages.find(
      (m) => (m as AIMessage).tool_calls?.[0]?.name === "consultar_preco",
    );
    expect(caller).toBeDefined();
  });

  test("a call to a tool outside the sources is refused and never runs", async () => {
    const model = new BoundRecordingModel([
      { text: "O ingresso custa 120 créditos." },
      { text: "", calls: [{ name: "abrir_chamado" }] },
      { text: "O ingresso custa 187 créditos." },
    ]);
    const infos: RevisionInfo[] = [];
    const { messages } = await run(model, {
      second: (_t, _r, info) => infos.push(info),
    });
    expect(ran).toEqual([]);
    const refusal = messages.find(
      (m) =>
        m.getType() === "tool" && (m as ToolMessage).name === "abrir_chamado",
    ) as ToolMessage | undefined;
    expect(refusal?.status).toBe("error");
    expect(infos[0]).toMatchObject({
      toolCalls: 0,
      refused: ["abrir_chamado"],
    });
  });

  test("a source that is not a read is neither offered nor run", async () => {
    const model = new BoundRecordingModel([
      { text: "O ingresso custa 120 créditos." },
      {
        text: "",
        calls: [{ name: "set_labels" }, { name: "consultar_preco" }],
      },
      { text: "O ingresso custa 187 créditos." },
    ]);
    await run(model, { sourceTools: ["consultar_preco", "set_labels"] });
    expect(model.bound[1]).toEqual(["consultar_preco"]);
    expect(ran).toEqual(["consultar_preco"]);
  });

  // The bug it catches: an MCP or integration source, a read only for an observation, handed to the
  // rewrite, which could then send an e-mail or create a charge a second time.
  test("a source that only an observation reads (MCP, integration) is neither offered nor run", async () => {
    const model = new BoundRecordingModel([
      { text: "O ingresso custa 120 créditos." },
      { text: "", calls: [{ name: "enviar_email" }] },
      { text: "O ingresso custa 187 créditos." },
    ]);
    await run(model, { sourceTools: ["consultar_preco", "enviar_email"] });
    expect(model.bound[1]).toEqual(["consultar_preco"]);
    expect(ran).toEqual([]);
  });

  test("calls past the cap are refused, in one batch and across rounds, and the turn ends on text", async () => {
    const model = new BoundRecordingModel([
      { text: "O ingresso custa 120 créditos." },
      {
        text: "",
        calls: [
          { name: "consultar_preco", args: { a: 1 } },
          { name: "consultar_preco", args: { a: 2 } },
          { name: "consultar_preco", args: { a: 3 } },
          { name: "consultar_preco", args: { a: 4 } },
        ],
      },
      { text: "", calls: [{ name: "consultar_preco", args: { a: 5 } }] },
      { text: "", calls: [{ name: "consultar_preco", args: { a: 6 } }] },
    ]);
    const infos: RevisionInfo[] = [];
    const revised: string[] = [];
    await run(model, {
      maxToolCalls: 2,
      revised,
      second: (_t, _r, info) => infos.push(info),
    });
    expect(ran).toEqual(["consultar_preco", "consultar_preco"]);
    // After the cap the model is asked with no tool bound, and a call it still writes is not run.
    expect(model.bound.slice(2)).toEqual([[]]);
    expect(model.seen).toHaveLength(3);
    expect(infos[0]?.toolCalls).toBe(2);
    expect(revised).toEqual([""]);
  });

  test("with no plan the rewrite is the one tool-less generation, and it is not reviewed again", async () => {
    const model = new BoundRecordingModel([
      { text: "O ingresso custa 120 créditos." },
      { text: "", calls: [{ name: "consultar_preco" }] },
    ]);
    const revised: string[] = [];
    const { reviews } = await run(model, { plan: false, revised });
    expect(model.bound[1]).toEqual([]);
    expect(ran).toEqual([]);
    expect(model.seen).toHaveLength(2);
    expect(reviews).toBe(1);
    expect(revised).toEqual([""]);
  });

  test("the note is in front of the model on every round of the rewrite", async () => {
    const model = new BoundRecordingModel([
      { text: "O ingresso custa 120 créditos." },
      { text: "", calls: [{ name: "consultar_preco" }] },
      { text: "O ingresso custa 187 créditos." },
    ]);
    await run(model);
    for (const round of model.seen.slice(1)) {
      expect(text(round.at(-1)).startsWith(NOTE)).toBe(true);
      expect(text(round.at(-1))).toContain(
        "`consultar_preco` (no máximo 3 chamadas)",
      );
    }
  });

  // The bug it catches: a rewrite handed its sources after the turn spent its tool budget, so the
  // flagged turn runs more calls than any turn may.
  test("a turn that spent its tool budget rewrites without tools", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "consultar_preco" }] },
      { text: "O ingresso custa 120 créditos." },
      { text: "", calls: [{ name: "consultar_preco", args: { a: 1 } }] },
    ]);
    const revised: string[] = [];
    await run(model, { turnMax: 1, revised });
    expect(ran).toEqual(["consultar_preco"]);
    expect(model.bound[2]).toEqual([]);
    expect(revised).toEqual([""]);
  });

  // The bug it catches: a rewrite batch admitted by its own cap alone, so a turn with one call left
  // runs three more and passes the limit every turn obeys.
  test("a batch is cut at the turn's remaining budget when that is smaller than the rewrite's cap", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "consultar_preco", args: { a: 0 } }] },
      { text: "O ingresso custa 120 créditos." },
      {
        text: "",
        calls: [
          { name: "consultar_preco", args: { a: 1 } },
          { name: "consultar_preco", args: { a: 2 } },
          { name: "consultar_preco", args: { a: 3 } },
        ],
      },
      { text: "O ingresso custa 187 créditos." },
    ]);
    const infos: RevisionInfo[] = [];
    await run(model, {
      turnMax: 2,
      maxToolCalls: 3,
      second: (_t, _r, info) => infos.push(info),
    });
    expect(ran).toEqual(["consultar_preco", "consultar_preco"]);
    expect(infos[0]).toMatchObject({ toolCalls: 1 });
  });
});

// The admission as a table: which ids of a batch the tool node may run.
describe("admitRevisionCalls", () => {
  const sources = new Set(["consultar_preco"]);
  // The bug it catches: an id shared by a source and a write, so admitting the source ran the write.
  test("an id two calls share admits neither; names outside the sources and calls past the room are out", () => {
    expect([
      ...admitRevisionCalls(
        [
          { name: "consultar_preco", id: "a" },
          { name: "set_labels", id: "a" },
          { name: "consultar_preco", id: "b" },
          { name: "abrir_chamado", id: "c" },
          { name: "consultar_preco", id: "d" },
          { name: "consultar_preco" },
        ],
        sources,
        4,
      ),
    ]).toEqual(["b"]);
  });
});
