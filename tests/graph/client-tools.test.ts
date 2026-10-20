import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  type ToolMessage,
} from "@langchain/core/messages";
import { type StructuredToolInterface, tool } from "@langchain/core/tools";
import { Command, MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import {
  boundClientAnswers,
  buildClientToolStubs,
  type ClientToolsInterrupt,
} from "@/graph/client-tools";
import { buildAgentGraph } from "@/graph/graph";

// One batch with a server tool and two client tools, then an answer. Records what each round saw.
class MixedBatchThenAnswers {
  rounds = 0;
  seen: BaseMessage[][] = [];
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    return {
      async invoke(messages: BaseMessage[]) {
        self.rounds++;
        self.seen.push(messages);
        if (self.rounds === 1)
          return new AIMessage({
            content: "",
            tool_calls: [
              { id: "s1", name: "writer", args: { v: "x" } },
              { id: "c1", name: "ler_nota", args: { id: 7 } },
              { id: "c2", name: "navegar", args: { rota: "/notas/7" } },
            ],
          });
        return new AIMessage("pronto");
      },
    };
  }
}

function countingWriter(ran: string[]): StructuredToolInterface {
  return tool(
    async ({ v }: { v: string }) => {
      ran.push(v);
      return `wrote ${v}`;
    },
    {
      name: "writer",
      description: "writes something to the world",
      schema: z.object({ v: z.string() }),
    },
  ) as unknown as StructuredToolInterface;
}

const specs = [
  {
    name: "ler_nota",
    description: "lê a nota",
    parameters: {
      type: "object",
      properties: { id: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "navegar",
    description: "abre uma tela",
    parameters: {
      type: "object",
      properties: { rota: { type: "string" } },
      required: ["rota"],
    },
  },
];

function build(model: MixedBatchThenAnswers, ran: string[]) {
  return buildAgentGraph({
    primary: { provider: "openai", model: "test-model" },
    model: model as unknown as BaseChatModel,
    systemPrompt: "PROMPT",
    checkpointer: new MemorySaver(),
    tools: [countingWriter(ran), ...buildClientToolStubs(specs)],
    clientToolNames: new Set(specs.map((s) => s.name)),
  });
}

describe("client tools", () => {
  test("a mixed batch suspends once with every client call, and the server tool runs once", async () => {
    const model = new MixedBatchThenAnswers();
    const ran: string[] = [];
    const graph = build(model, ran);
    const cfg = { configurable: { thread_id: "t1" } };

    const first = await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      cfg,
    );
    const interrupts = (first as { __interrupt__?: { value: unknown }[] })
      .__interrupt__;
    expect(interrupts).toHaveLength(1);
    const value = interrupts?.[0]?.value as ClientToolsInterrupt;
    expect(value.calls.map((c) => c.toolCallId)).toEqual(["c1", "c2"]);
    expect(ran).toEqual(["x"]);

    const second = await graph.invoke(
      new Command({
        resume: {
          c1: { ok: true, result: { numero: 7, situacao: "AUTORIZADA" } },
          c2: { ok: false, error: "rota inexistente" },
        },
      }) as never,
      cfg,
    );
    expect(ran).toEqual(["x"]);
    expect(model.rounds).toBe(2);
    const results = (second.messages as BaseMessage[]).filter(
      (m) => m.getType() === "tool",
    ) as ToolMessage[];
    const byId = Object.fromEntries(results.map((m) => [m.tool_call_id, m]));
    expect(byId.s1?.content).toBe("wrote x");
    expect(byId.c1?.content).toContain("AUTORIZADA");
    expect(byId.c2?.status).toBe("error");
    expect(byId.c2?.content).toBe("rota inexistente");
    expect((second.messages as BaseMessage[]).at(-1)?.content).toBe("pronto");
  });

  test("a call the application did not answer reaches the model as an error", async () => {
    const model = new MixedBatchThenAnswers();
    const graph = build(model, []);
    const cfg = { configurable: { thread_id: "t2" } };
    await graph.invoke({ messages: [new HumanMessage("oi")] }, cfg);
    const done = await graph.invoke(
      new Command({ resume: { c1: { ok: true, result: "ok" } } }) as never,
      cfg,
    );
    const c2 = (done.messages as BaseMessage[]).find(
      (m) => m.getType() === "tool" && (m as ToolMessage).tool_call_id === "c2",
    ) as ToolMessage;
    expect(c2.status).toBe("error");
  });

  // The browser writes the error text as freely as a result, and a failed answer is checkpointed and
  // sent to the model in the current turn, where no history ceiling reaches. The same clip, both ways.
  test("a huge answer reaches the model clipped, failed or not", async () => {
    const model = new MixedBatchThenAnswers();
    const graph = build(model, []);
    const cfg = { configurable: { thread_id: "t3" } };
    await graph.invoke({ messages: [new HumanMessage("oi")] }, cfg);
    const huge = "x".repeat(200_000);
    const done = await graph.invoke(
      new Command({
        resume: {
          c1: { ok: true, result: huge },
          c2: { ok: false, error: huge },
        },
      }) as never,
      cfg,
    );
    const sizes = Object.fromEntries(
      (done.messages as BaseMessage[])
        .filter((m) => m.getType() === "tool")
        .map((m) => [
          (m as ToolMessage).tool_call_id,
          String(m.content).length < 21_000 &&
            String(m.content).endsWith("[cut at 20000 characters]"),
        ]),
    );
    expect(sizes).toEqual({ s1: false, c1: true, c2: true });
  });

  // The turn resumes with the answers already bound, and the node renders them again: the model has to
  // read the same text either way, so the clip must leave a clipped answer as it is.
  test("an answer bound before the resume reads exactly as the raw answer would", () => {
    const huge = "y".repeat(50_000);
    const raw = {
      a: { ok: true as const, result: { rows: [huge] } },
      b: { ok: false as const, error: huge },
      c: { ok: true as const, result: "curto" },
    };
    const once = boundClientAnswers(raw);
    expect(boundClientAnswers(once)).toEqual(once);
    expect(
      Object.values(once).map((a) =>
        a.ok ? String(a.result).length <= 20_000 : a.error.length <= 20_000,
      ),
    ).toEqual([true, true, true]);
    expect(once.c).toEqual({ ok: true, result: "curto" });
  });

  test("without client tools the graph never suspends", async () => {
    const model = new MixedBatchThenAnswers();
    const ran: string[] = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [countingWriter(ran)],
    });
    const out = await graph.invoke(
      { messages: [new HumanMessage("oi")] },
      { configurable: { thread_id: "t3" } },
    );
    expect((out as { __interrupt__?: unknown }).__interrupt__).toBeUndefined();
    expect((out.messages as BaseMessage[]).at(-1)?.content).toBe("pronto");
  });
});

describe("a suspended turn seen from a graph with no tools this round", () => {
  test("the interrupt is still there, so the turn reads as waiting and not as abandoned", async () => {
    const saver = new MemorySaver();
    const config = { configurable: { thread_id: "toolless-rebuild" } };
    const asks = {
      async invoke() {
        return new AIMessage("");
      },
      bindTools() {
        return {
          async invoke() {
            return new AIMessage({
              content: "",
              tool_calls: [{ id: "c1", name: "ler_nota", args: { id: 7 } }],
            });
          },
        };
      },
    };
    const withTools = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: asks as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: saver,
      tools: buildClientToolStubs(specs),
      clientToolNames: new Set(specs.map((s) => s.name)),
    });
    await withTools.invoke({ messages: [new HumanMessage("oi")] }, config);

    const toolless = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: asks as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: saver,
      tools: [],
      clientToolNames: new Set(),
    });
    const snapshot = await toolless.getState(config);
    const interrupts = snapshot.tasks.flatMap((t) => t.interrupts);
    expect(
      (interrupts[0]?.value as ClientToolsInterrupt | undefined)?.calls.map(
        (c) => c.toolCallId,
      ),
    ).toEqual(["c1"]);
  });
});
