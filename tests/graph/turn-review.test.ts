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
import { buildAgentGraph, replyWrittenThisTurn } from "@/graph/graph";
import { isUnranToolResult, turnWasCalledOff } from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import { markRead, markReadOnly } from "@/graph/tools/reads";

// The turn review in the graph: a write call it flags never runs and the model reads why, a read is
// never reviewed, and a reply it flags is redone with the whole toolset and reviewed again. A made-up
// order desk; no real customer text.

type Step = {
  text: string;
  // `noId`: a provider may send a call with no id.
  calls?: Array<{
    name: string;
    args?: Record<string, unknown>;
    noId?: boolean;
  }>;
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
        ...(c.noId ? {} : { id: `call_${this.seen.length}_${i}` }),
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

// The silence tool by name: the graph's silence readers key on it.
const pularResposta = tool(
  async () => {
    ran.push("skip_reply");
    return "ok";
  },
  { name: "skip_reply", description: "silêncio", schema: z.object({}) },
);

const CALL_NOTE = "[Sistema] Revisão do turno: NOTA-DA-CHAMADA";
const REPLY_NOTE = "[Sistema] Revisão do turno: NOTA-DA-RESPOSTA";
const REVIEWER_FEEDBACK =
  "<parecer_do_revisor>\nMOTIVO-LIVRE-DO-REVISOR\n</parecer_do_revisor>";

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
    grounding?: (reply: string) => string | null;
    groundingReReview?: () => void;
    retrySilence?: () => boolean;
    standingNotices?: string[];
    spokenNotice?: () => string | null;
  } = {},
) {
  ran.length = 0;
  const calls: string[] = [];
  const replies: string[] = [];
  const canRedo: boolean[] = [];
  const alongside: string[][] = [];
  const instructions: string[] = [];
  const tools: Record<string, string>[] = [];
  const replyInstructions: string[] = [];
  const graph = buildAgentGraph({
    primary: { provider: "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools: [buscarPedido, consultarAgenda, transferir, pularResposta],
    recoversReply: opts.recoversReply,
    turnReviewHalted: opts.halted,
    stillWanted: opts.stillWanted,
    retrySilence: opts.retrySilence,
    standingNotices: opts.standingNotices,
    spokenNotice: opts.spokenNotice,
    revisionPlan: opts.groundingReReview
      ? () => ({
          sourceTools: [],
          maxToolCalls: 0,
          review: async () => opts.groundingReReview?.(),
        })
      : undefined,
    reviewReply: opts.grounding
      ? async (_turn, reply) => opts.grounding?.(reply) ?? null
      : undefined,
    reviewCall: async (_turn, call, o) => {
      calls.push(call.name);
      alongside.push((o?.alongside ?? []).map((c) => c.name));
      instructions.push(o?.instructions ?? "");
      tools.push({ ...(o?.tools ?? {}) });
      return hooks.call?.(call.name) ?? null;
    },
    reviewTurnReply: async (_turn, reply, o) => {
      replies.push(reply);
      canRedo.push(o?.canRedo ?? true);
      replyInstructions.push(o?.instructions ?? "");
      const note = hooks.reply?.(reply) ?? null;
      return note ? { instruction: note, feedback: REVIEWER_FEEDBACK } : null;
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
  return {
    messages: out.messages as BaseMessage[],
    calls,
    replies,
    canRedo,
    alongside,
    instructions,
    tools,
    replyInstructions,
  };
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
    // Marked as a call that never ran, so the side-effect accounting does not count it.
    expect(isUnranToolResult(answer)).toBe(true);
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
      "skip_reply",
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

  test("the reviewer's reason reaches the redo as data after the history, never in a system message", async () => {
    const model = new BoundRecordingModel([
      { text: "Vou te passar para a equipe." },
      { text: "Qual é o número do seu pedido?" },
    ]);
    await run(model, {
      reply: (r) => (r === "Vou te passar para a equipe." ? REPLY_NOTE : null),
    });
    const redo = model.seen[1] ?? [];
    expect(
      redo.some(
        (m) => m.getType() === "system" && text(m).includes("MOTIVO-LIVRE"),
      ),
    ).toBe(false);
    expect(
      redo.some(
        (m) => m.getType() === "human" && text(m) === REVIEWER_FEEDBACK,
      ),
    ).toBe(true);
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
    // Not a called-off turn: the caller still owns it and must reach the handover.
    expect(turnWasCalledOff(messages)).toBe(false);
    // Errors, not results: a refused read must not read as a source that answered.
    expect(
      messages
        .filter((m) => m.getType() === "tool")
        .map((m) => (m as ToolMessage).status),
    ).toEqual(["error", "error"]);
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

  test("each write of a step is reviewed with the writes already admitted beside it", async () => {
    const model = new BoundRecordingModel([
      {
        text: "",
        calls: [
          { name: "consultar_agenda" },
          { name: "transferir" },
          { name: "consultar_agenda" },
        ],
      },
      { text: "Pronto." },
    ]);
    const { calls, alongside } = await run(model, {
      call: (name) => (name === "transferir" ? CALL_NOTE : null),
    });
    expect(calls).toEqual([
      "consultar_agenda",
      "transferir",
      "consultar_agenda",
    ]);
    // The vetoed transfer is not beside the third call: it will not run.
    expect(alongside).toEqual([[], ["consultar_agenda"], ["consultar_agenda"]]);
  });

  test("after a flagged recovered draft and a blank redo, the older draft delivery would recover is reviewed too", async () => {
    const model = new BoundRecordingModel([
      { text: "Rascunho antigo.", calls: [{ name: "buscar_pedido" }] },
      { text: "Rascunho novo.", calls: [{ name: "buscar_pedido" }] },
      { text: "" },
      { text: "" },
    ]);
    // Two notes at most, as the gate's attempts would bound them.
    let notes = 2;
    const { messages, replies } = await run(
      model,
      { reply: () => (notes-- > 0 ? REPLY_NOTE : null) },
      { recoversReply: () => true },
    );
    expect(replies).toEqual(["Rascunho novo.", "Rascunho antigo."]);
    // Neither flagged draft is left for the runtime to recover.
    expect(replyWrittenThisTurn(messages)).toBe("");
  });

  test("a factual-grounding rewrite is the text headed out, so the turn review reads it, with no redo left", async () => {
    const model = new BoundRecordingModel([
      { text: "Abre às 16h." },
      { text: "Abre às 18h. Prometo reembolso." },
    ]);
    const { replies, canRedo, messages } = await run(
      model,
      { reply: (r) => (r.includes("reembolso") ? REPLY_NOTE : null) },
      {
        grounding: (r) =>
          r === "Abre às 16h." ? "[Sistema] NOTA-FACTUAL" : null,
      },
    );
    expect([replies, canRedo]).toEqual([
      ["Abre às 16h.", "Abre às 18h. Prometo reembolso."],
      [true, false],
    ]);
    expect(model.seen).toHaveLength(2);
    expect(text(messages.at(-1))).toBe("Abre às 18h. Prometo reembolso.");
  });

  test("a blank redo gets the one silence retry, and what it writes is reviewed", async () => {
    const model = new BoundRecordingModel([
      { text: "Vou te passar para a equipe." },
      { text: "" },
      { text: "Qual é o número do seu pedido?" },
    ]);
    const { replies, messages } = await run(
      model,
      {
        reply: (r) =>
          r === "Vou te passar para a equipe." ? REPLY_NOTE : null,
      },
      { retrySilence: () => true },
    );
    expect(replies).toEqual([
      "Vou te passar para a equipe.",
      "Qual é o número do seu pedido?",
    ]);
    expect(text(messages.at(-1))).toBe("Qual é o número do seu pedido?");
    // The retry carries the reviewer's note: the correction is not lost on the way.
    expect(
      model.seen[2]?.some(
        (m) => m.getType() === "system" && text(m).includes(REPLY_NOTE),
      ),
    ).toBe(true);
  });

  test("a skip_reply the review vetoed is no declared silence, so a blank answer gets the silence retry", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "skip_reply" }] },
      { text: "" },
      { text: "Posso ajudar em mais alguma coisa?" },
    ]);
    const { messages } = await run(
      model,
      { call: (name) => (name === "skip_reply" ? CALL_NOTE : null) },
      { retrySilence: () => true },
    );
    expect(ran).toEqual([]);
    expect(model.seen).toHaveLength(3);
    expect(text(messages.at(-1))).toBe("Posso ajudar em mais alguma coisa?");
  });

  test("the text beside a vetoed skip_reply is still a reply the runtime recovers, and it is reviewed", async () => {
    const model = new BoundRecordingModel([
      { text: "Até logo!", calls: [{ name: "skip_reply" }] },
      { text: "" },
    ]);
    const { replies, messages } = await run(
      model,
      { call: (name) => (name === "skip_reply" ? CALL_NOTE : null) },
      { recoversReply: () => true },
    );
    expect(replies).toEqual(["Até logo!"]);
    expect(replyWrittenThisTurn(messages)).toBe("Até logo!");
  });

  test("the reviewer judges against the instructions the graph gives the model, standing notices included", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "transferir" }] },
      { text: "Pronto." },
    ]);
    const { instructions, tools } = await run(
      model,
      {},
      { standingNotices: ["[Sistema] AVISO-DO-TURNO"] },
    );
    expect(instructions).toEqual(["PROMPT\n\n[Sistema] AVISO-DO-TURNO"]);
    // And the write tools it binds, each with the description the model was given.
    expect(tools).toEqual([
      {
        consultar_agenda: "agenda",
        transferir: "transfere",
        skip_reply: "silêncio",
      },
    ]);
  });

  test("the spoken-reply notice of a step reaches both of its reviews", async () => {
    const model = new BoundRecordingModel([
      { text: "", calls: [{ name: "transferir" }] },
      { text: "Pronto." },
    ]);
    // The notice changes from one round to the next: each review reads the one its step was given.
    const notices = ["[Sistema] AVISO-DE-VOZ-1", "[Sistema] AVISO-DE-VOZ-2"];
    let round = 0;
    const { instructions, replyInstructions } = await run(
      model,
      {},
      { spokenNotice: () => notices[round++] ?? null },
    );
    expect(instructions).toEqual(["PROMPT\n\n[Sistema] AVISO-DE-VOZ-1"]);
    expect(replyInstructions).toEqual(["PROMPT\n\n[Sistema] AVISO-DE-VOZ-2"]);
  });

  test("ownership is read again after a batch only when a review ran in it", async () => {
    const reads = async (first: { name: string }[]) => {
      let asked = 0;
      await run(
        new BoundRecordingModel([
          { text: "", calls: first },
          { text: "Pronto." },
        ]),
        {},
        {
          stillWanted: async () => {
            asked++;
            return true;
          },
        },
      );
      return asked;
    };
    // A read alone: the one read before the batch, nothing awaited after it.
    expect(await reads([{ name: "buscar_pedido" }])).toBe(1);
    // A write: read again once its review answered.
    expect(await reads([{ name: "transferir" }])).toBe(2);
  });

  test("a held review of a grounding rewrite stops grounding from reviewing it again", async () => {
    const model = new BoundRecordingModel([
      { text: "Abre às 16h." },
      { text: "Abre às 18h." },
    ]);
    let held = false;
    let reReviewed = 0;
    await run(
      model,
      {
        reply: (r) => {
          if (r === "Abre às 18h.") held = true;
          return null;
        },
      },
      {
        grounding: (r) =>
          r === "Abre às 16h." ? "[Sistema] NOTA-FACTUAL" : null,
        groundingReReview: () => {
          reReviewed++;
        },
        halted: () => held,
      },
    );
    expect(reReviewed).toBe(0);
  });

  test("two id-less calls to one tool keep their own results, the admitted one first and the veto second", async () => {
    const model = new BoundRecordingModel([
      {
        text: "",
        calls: [
          { name: "transferir", args: { equipe: "vendas" }, noId: true },
          { name: "transferir", args: { equipe: "suporte" }, noId: true },
        ],
      },
      { text: "Pronto." },
    ]);
    let reviewed = 0;
    const { messages } = await run(model, {
      call: () => (reviewed++ === 1 ? CALL_NOTE : null),
    });
    expect(ran).toEqual(["transferir"]);
    expect(
      messages
        .filter((m) => m.getType() === "tool")
        .map((m) => (isUnranToolResult(m) ? "veto" : text(m))),
    ).toEqual(["transferido", "veto"]);
  });

  test("a grounding rewrite after a refused recovered draft does not read that draft back", async () => {
    const model = new BoundRecordingModel([
      { text: "Rascunho recusado.", calls: [{ name: "buscar_pedido" }] },
      { text: "" },
      { text: "Abre às 16h." },
      { text: "Abre às 18h." },
    ]);
    const { messages } = await run(
      model,
      { reply: (r) => (r === "Rascunho recusado." ? REPLY_NOTE : null) },
      {
        recoversReply: () => true,
        grounding: (r) =>
          r === "Abre às 16h." ? "[Sistema] NOTA-FACTUAL" : null,
      },
    );
    expect(model.seen).toHaveLength(4);
    expect(
      model.seen[3]?.some(
        (m) => m.getType() === "ai" && text(m).includes("Rascunho recusado."),
      ),
    ).toBe(false);
    expect(text(messages.at(-1))).toBe("Abre às 18h.");
  });
});

// The bug it catches: the answers set aside pooled by kind of refusal, not by call, so with a
// repeated id a vetoed write took the contradicted handoff's answer and the handoff took the veto.
describe("answers set aside keep their call", () => {
  test("a veto and a contradicted handoff sharing an id each stay with their own call", async () => {
    const named = (name: string) =>
      tool(async () => "feito", {
        name,
        description: name,
        schema: z.object({}),
      });
    const steps: AIMessage[] = [
      new AIMessage({
        content: "",
        tool_calls: [
          { name: "agendar", args: {}, id: "x" },
          { name: "resolve_conversation", args: {}, id: "r" },
          { name: "handoff_to_human", args: {}, id: "x" },
        ],
      }),
    ];
    let n = 0;
    const model = {
      async invoke() {
        return steps[n++] ?? new AIMessage("ok");
      },
      bindTools() {
        return this;
      },
    };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [
        named("agendar"),
        named("resolve_conversation"),
        named("handoff_to_human"),
      ],
      maxToolCalls: 5,
      reviewCall: async (_turn, call) =>
        call.name === "agendar" ? CALL_NOTE : null,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("encerra")] },
      { configurable: { thread_id: `ids-${Math.random()}` } },
    );
    const answers = (result.messages as BaseMessage[])
      .filter((m) => m.getType() === "tool")
      .map((m) => [
        (m as ToolMessage).name,
        contentToText(m.content).slice(0, 14),
      ]);
    expect(answers).toEqual([
      ["agendar", CALL_NOTE.slice(0, 14)],
      ["resolve_conversation", "feito"],
      ["handoff_to_human", "Not transferre"],
    ]);
  });
});
