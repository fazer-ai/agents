import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
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

// A recording model that also counts tokens, so trimMessages has a budget to work against.
// getNumTokens is what BaseLanguageModel exposes as a tokenCounter; one "token" per 4 chars here
// keeps the arithmetic in the test obvious.
class CountingModel extends RecordingModel {
  async getNumTokens(content: unknown): Promise<number> {
    return Math.ceil(String(content).length / 4);
  }
}

// Regression for the unbounded-memory bug: the checkpointer thread is per contact-inbox and spans
// every conversation a contact ever had on the channel, and agentNode used to hand the model ALL of
// it, forever. Measured in production: 79.8k tokens of context against a 15.8k floor, i.e. ~64k of
// already-finished conversations re-sent on every single turn — which is what actually exhausted the
// provider's per-minute token quota.
describe("agentNode history ceiling (limits.maxHistoryTokens)", () => {
  // 40 chars ≈ 10 tokens with the counter above.
  const long = (tag: string) => `${tag} ${"x".repeat(37)}`;

  const history = () => [
    new HumanMessage(long("h1")),
    new AIMessage(long("a1")),
    new HumanMessage(long("h2")),
    new AIMessage(long("a2")),
    new HumanMessage(long("h3")),
  ];

  test("sends the whole history when no ceiling is set (previous behavior)", async () => {
    const model = new CountingModel();
    const graph = buildAgentGraph({
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
    });
    await graph.invoke(
      { messages: history() },
      { configurable: { thread_id: "no-ceiling" } },
    );
    // system prompt + all 5
    expect(model.seen[0]).toHaveLength(6);
  });

  test("drops the oldest messages to fit the ceiling and keeps the newest", async () => {
    const model = new CountingModel();
    const trims: { kept: number; dropped: number }[] = [];
    const graph = buildAgentGraph({
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      maxHistoryTokens: 25,
      onHistoryTrim: (info) => trims.push(info),
    });
    await graph.invoke(
      { messages: history() },
      { configurable: { thread_id: "ceiling" } },
    );
    const seen = model.seen[0];
    expect(seen).toBeDefined();
    if (!seen) return;
    // The prompt is always first and is never counted against the history budget.
    expect(seen[0]?.content).toBe("PROMPT");
    expect(seen.length).toBeLessThan(6);
    // The turn being answered survives; the oldest exchange is what goes.
    expect(seen.at(-1)?.content).toBe(long("h3"));
    expect(seen.some((m) => m.content === long("h1"))).toBe(false);
    // A trim that leaves no trace is indistinguishable from the agent forgetting things.
    expect(trims).toHaveLength(1);
    expect(trims[0]?.dropped).toBeGreaterThan(0);
  });

  // The budget here is deliberately calibrated so that a NAIVE "keep the last N tokens" window
  // would open exactly on the ToolMessage: tool-result + a1 + h2 fit, and adding the AIMessage that
  // issued the call does not. Without startOn:"human" this test fails — which is the point, since a
  // version of it with a rounder budget passes either way and pins nothing.
  test("a trimmed window never opens on a tool result whose call was dropped", async () => {
    const model = new CountingModel();
    const graph = buildAgentGraph({
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      maxHistoryTokens: 35,
    });
    await graph.invoke(
      {
        messages: [
          new HumanMessage(long("h1")),
          new AIMessage({
            // Non-empty on purpose: an empty content costs 0 tokens, so the call message would
            // always fit and the window could never land on the orphan in the first place.
            content: long("calling"),
            tool_calls: [{ id: "c1", name: "t", args: {} }],
          }),
          new ToolMessage({ content: long("tool-result"), tool_call_id: "c1" }),
          new AIMessage(long("a1")),
          new HumanMessage(long("h2")),
        ],
      },
      { configurable: { thread_id: "orphan" } },
    );
    const seen = model.seen[0];
    expect(seen).toBeDefined();
    if (!seen) return;
    // Providers reject an orphan tool result outright (OpenAI 400), so the first history message
    // after the prompt must never be one. This is why the trim starts on a human turn.
    expect(seen[1]?.getType()).not.toBe("tool");
    expect(seen.some((m) => m.getType() === "tool")).toBe(false);
  });

  test("falls back to the full history if trimming throws", async () => {
    // A counter that blows up: trimming is an optimization and must never cost an answer.
    class ExplodingModel extends RecordingModel {
      async getNumTokens(_content: unknown): Promise<number> {
        throw new Error("counter exploded");
      }
    }
    const model = new ExplodingModel();
    const graph = buildAgentGraph({
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      maxHistoryTokens: 25,
    });
    await graph.invoke(
      { messages: history() },
      { configurable: { thread_id: "explode" } },
    );
    expect(model.seen[0]).toHaveLength(6);
  });
});
