import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import { buildAgentGraph } from "@/graph/graph";

// Records the messages handed to the model on each invoke (the only thing agentNode does with it).
class RecordingModel {
  seen: BaseMessage[][] = [];
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.seen.push(messages);
    return new AIMessage("ok");
  }
}

// Regression for the production follow-up bug: agentNode must hand the model EXACTLY ONE system
// message, first. A proactive nudge used to be injected as a SystemMessage; combined with the
// per-turn system prompt that produced [system, …, system], which strict providers (Google) reject
// with "System messages are only permitted as the first passed message". The node now strips any
// system message from the history before prepending the prompt — auto-healing old threads too.
describe("agentNode system-message normalization", () => {
  test("prepends one system prompt and drops a system message leaked into history", async () => {
    const model = new RecordingModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
    });
    await graph.invoke(
      {
        messages: [
          new SystemMessage("OLD NUDGE"),
          new HumanMessage("oi"),
          new AIMessage("olá"),
          new HumanMessage("tudo bem?"),
        ],
      },
      { configurable: { thread_id: "t1" } },
    );
    const seen = model.seen[0];
    expect(seen).toBeDefined();
    if (!seen) return;
    const systems = seen.filter((m) => m.getType() === "system");
    expect(systems).toHaveLength(1);
    expect(seen[0]?.getType()).toBe("system");
    expect(seen[0]?.content).toBe("PROMPT");
    // the leaked nudge text is gone, the rest of the history is preserved in order
    expect(seen.some((m) => m.content === "OLD NUDGE")).toBe(false);
    expect(seen.slice(1).map((m) => m.content)).toEqual([
      "oi",
      "olá",
      "tudo bem?",
    ]);
  });
});

// A model that keeps calling a tool while tools are bound, and answers in text when they are NOT
// (the hard-limit path invokes the raw model). Records the system prompt seen on each bound invoke.
class ToolLoopModel {
  boundSystemPrompts: string[] = [];
  rawInvokes = 0;
  // Hard-limit path: raw model, no tools → a plain text answer ends the turn.
  async invoke(_messages: BaseMessage[]): Promise<AIMessage> {
    this.rawInvokes++;
    return new AIMessage("resposta final");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        n++;
        self.boundSystemPrompts.push(String(messages[0]?.content ?? ""));
        return new AIMessage({
          content: "",
          tool_calls: [{ name: "noop", args: {}, id: `call_${n}` }],
        });
      },
    };
  }
}

const noopTool = tool(async () => "feito", {
  name: "noop",
  description: "noop",
  schema: z.object({}),
});

describe("agentNode tool-call limit (soft+hard)", () => {
  test("forces a no-tools answer at the hard limit and fires onToolLimit", async () => {
    const model = new ToolLoopModel();
    const hits: Array<{ maxToolCalls: number; toolCalls: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [noopTool],
      maxToolCalls: 3,
      onToolLimit: (info) => hits.push(info),
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("faça muitas coisas")] },
      { configurable: { thread_id: "limit-1" } },
    );
    // Ended in a text answer (the raw model), not a GraphRecursionError.
    const last = result.messages.at(-1);
    expect(last?.content).toBe("resposta final");
    expect(model.rawInvokes).toBe(1);
    // Hard limit fired exactly once, at maxToolCalls executions.
    expect(hits).toHaveLength(1);
    expect(hits[0]).toEqual({ maxToolCalls: 3, toolCalls: 3 });
    // The soft "wrap up" instruction was appended once the budget got close (N-2 = 1 execution in).
    expect(
      model.boundSystemPrompts.some((p) =>
        p.includes("[Sistema] Você já usou"),
      ),
    ).toBe(true);
    // The first invoke (0 executions) used the plain prompt.
    expect(model.boundSystemPrompts[0]).toBe("PROMPT");
  });
});

// The ceiling is wired through the node, so what it is worth is measured where it matters: in the
// list the model actually receives. See tests/graph/history-window.test.ts for the rule itself.
describe("agentNode history ceiling", () => {
  // Eight turns of a chatty contact. Every message is long enough that a small ceiling has to cut.
  const seed = (): BaseMessage[] => {
    const out: BaseMessage[] = [];
    for (let i = 0; i < 8; i++) {
      out.push(new HumanMessage(`pergunta ${i} ${"palavra ".repeat(200)}`));
      out.push(new AIMessage(`resposta ${i} ${"palavra ".repeat(200)}`));
    }
    return out;
  };

  test("without a ceiling the whole thread travels", async () => {
    const model = new RecordingModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
    });
    await graph.invoke(
      { messages: seed() },
      { configurable: { thread_id: "ceiling-off" } },
    );
    // 16 seeded + the system prompt the node prepends.
    expect(model.seen[0]).toHaveLength(17);
  });

  test("with a ceiling the oldest attendances are dropped and the trim is announced", async () => {
    const model = new RecordingModel();
    const trims: Array<{ kept: number; dropped: number; tokens: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      maxHistoryTokens: 2_000,
      onHistoryTrim: (info) => trims.push(info),
    });
    await graph.invoke(
      { messages: seed() },
      { configurable: { thread_id: "ceiling-on" } },
    );
    const seen = model.seen[0];
    expect(seen).toBeDefined();
    if (!seen) return;
    expect(seen.length).toBeLessThan(17);
    // One system prompt, first, and the window opens on a customer message right after it.
    expect(seen[0]?.getType()).toBe("system");
    expect(seen[1]?.getType()).toBe("human");
    // The turn being answered is never the thing that gets dropped.
    expect(seen.at(-1)?.content).toContain("resposta 7");
    expect(String(seen[1]?.content)).not.toContain("pergunta 0");
    expect(trims).toHaveLength(1);
    expect(trims[0]?.dropped).toBeGreaterThan(0);
    expect(trims[0]?.kept).toBe(seen.length - 1);
    expect(trims[0]?.tokens).toBeGreaterThan(0);
  });

  test("a ceiling the thread already fits under changes nothing and stays silent", async () => {
    const model = new RecordingModel();
    const trims: unknown[] = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      maxHistoryTokens: 1_000_000,
      onHistoryTrim: (info) => trims.push(info),
    });
    await graph.invoke(
      { messages: seed() },
      { configurable: { thread_id: "ceiling-slack" } },
    );
    expect(model.seen[0]).toHaveLength(17);
    expect(trims).toHaveLength(0);
  });
});
