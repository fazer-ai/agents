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
import { SKIP_REPLY_ACK, SKIP_REPLY_TOOL } from "@/graph/silence";
import { unmetPreconditionMessage } from "@/modules/agents/tool-preconditions";

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
  // Issue #454, review rounds 5 and 11. Silence is a TOOL CALL now, so the graph loops back with the
  // tool's result and asks the model AGAIN — and round 5 only stopped that round from being told
  // "Conclua agora: responda ao cliente". The round itself was the defect: whatever the model writes
  // there goes to the customer, and on the proactive path that is an unsolicited message, which the
  // sentinel made impossible by being the final text. The decision is terminal now: no further round
  // at all. The COUNT is untouched, so the cap still bounds a model that loops on skip_reply.
  test("the turn ends on the silence decision: the model is not asked again", async () => {
    const skipTool = tool(
      async () => `${SKIP_REPLY_ACK}. Produce no message now.`,
      {
        name: "skip_reply",
        description: "skip",
        schema: z.object({}),
      },
    );
    // One skip_reply call, then an empty answer — the shape a silent turn actually has.
    class SkipThenSilentModel {
      boundSystemPrompts: string[] = [];
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            n++;
            self.boundSystemPrompts.push(String(messages[0]?.content ?? ""));
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: "skip_reply", args: {}, id: "c1" }],
              });
            }
            return new AIMessage("");
          },
        };
      }
    }
    const model = new SkipThenSilentModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool],
      maxToolCalls: 3,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("nada a fazer")] },
      { configurable: { thread_id: "limit-skip" } },
    );
    // ONE round: the decision ended the turn. The wrap-up instruction cannot land because there is
    // no round after it to land on (the control below proves the same cap DOES produce it).
    expect(model.boundSystemPrompts).toHaveLength(1);
    expect(
      model.boundSystemPrompts.some((p) =>
        p.includes("[Sistema] Você já usou"),
      ),
    ).toBe(false);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // The defect round 11 named, in the shape that reaches a person: the round after the decision is
  // where a follow-up that chose silence writes to the customer anyway. Well below the cap, so no
  // limit is involved — only the decision.
  test("a model that would speak after skip_reply never gets the chance", async () => {
    const skipTool = tool(
      async () => `${SKIP_REPLY_ACK}. Produce no message now.`,
      { name: SKIP_REPLY_TOOL, description: "skip", schema: z.object({}) },
    );
    class SkipThenTalksAnyway {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            }
            return new AIMessage("Oi! Só passando para lembrar do seu boleto.");
          },
        };
      }
    }
    const model = new SkipThenTalksAnyway();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "silence-terminal" } },
    );
    expect(model.rounds).toBe(1);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // Round 9: the HARD limit is the other way the decision gets talked over. At `maxToolCalls: 1` the
  // budget is spent by the very round that chose silence, and that path exists to force a TEXT
  // answer — it invokes the raw model with no tools bound. A deliberate silence became a message.
  test("the hard limit does not force text out of a turn that chose silence", async () => {
    const skipTool = tool(
      async () => `${SKIP_REPLY_ACK}. Produce no message now.`,
      {
        name: "skip_reply",
        description: "skip",
        schema: z.object({}),
      },
    );
    class SkipThenWouldSpeakModel {
      rawInvokes = 0;
      // The raw path is what the hard limit reaches for, and it is what must NOT run here.
      async invoke(): Promise<AIMessage> {
        this.rawInvokes++;
        return new AIMessage("texto que o cliente não deveria receber");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(): Promise<AIMessage> {
            n++;
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: "skip_reply", args: {}, id: "c1" }],
              });
            }
            return self.invoke();
          },
        };
      }
    }
    const model = new SkipThenWouldSpeakModel();
    const hits: Array<{ maxToolCalls: number; toolCalls: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool],
      maxToolCalls: 1,
      onToolLimit: (info) => hits.push(info),
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("nada a fazer")] },
      { configurable: { thread_id: "limit-hard-skip" } },
    );
    // The turn ends silent, the raw model never spoke, and the call still COUNTED — which is what
    // keeps a model that loops on skip_reply bounded.
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    expect(model.rawInvokes).toBe(0);
    expect(hits).toEqual([{ maxToolCalls: 1, toolCalls: 1 }]);
  });

  // Round 10: the SAME name, the opposite outcome. `skip_reply` is a native name, so an operator may
  // declare a precondition on it (`isGuardableToolName`); unmet, the wrapper returns a normal tool
  // result under that name telling the model to carry on. Read by name that is a decision to stay
  // silent, and at `maxToolCalls: 1` the turn then ends with NO text — a customer left waiting by
  // the guard that was supposed to make the agent more careful.
  test("a refused skip_reply is not silence: the hard limit still forces an answer", async () => {
    const refusal = unmetPreconditionMessage(SKIP_REPLY_TOOL, {
      kind: "attribute",
      scope: "conversation",
      key: "cpf",
    });
    const guardedSkip = tool(async () => refusal, {
      name: SKIP_REPLY_TOOL,
      description: "skip",
      schema: z.object({}),
    });
    class SkipRefusedThenSpeaks {
      rawInvokes = 0;
      async invoke(): Promise<AIMessage> {
        this.rawInvokes++;
        return new AIMessage("Claro! Me confirma seu CPF?");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(): Promise<AIMessage> {
            n++;
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            }
            return self.invoke();
          },
        };
      }
    }
    const model = new SkipRefusedThenSpeaks();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [guardedSkip],
      maxToolCalls: 1,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("quero a segunda via")] },
      { configurable: { thread_id: "limit-hard-skip-refused" } },
    );
    expect(model.rawInvokes).toBe(1);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Claro! Me confirma seu CPF?",
    );
  });

  // Round 7: parallel tool calls. `skip_reply` alongside `react_to_message` is the documented way to
  // answer with a reaction alone, and whichever result lands last is an ordering accident — reading
  // only the last one made the wrap-up instruction depend on it.
  test("skip_reply counts even when another tool's result lands last", async () => {
    const skipTool = tool(
      async () => `${SKIP_REPLY_ACK}. Produce no message now.`,
      {
        name: "skip_reply",
        description: "skip",
        schema: z.object({}),
      },
    );
    const reactTool = tool(async () => "reagiu", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class ParallelThenSilentModel {
      boundSystemPrompts: string[] = [];
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            n++;
            self.boundSystemPrompts.push(String(messages[0]?.content ?? ""));
            if (n === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "skip_reply", args: {}, id: "c1" },
                  { name: "react_to_message", args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("");
          },
        };
      }
    }
    const model = new ParallelThenSilentModel();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 3,
    });
    await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "limit-parallel" } },
    );
    // The batch was READ, not just its last result: the reaction landed after the skip and the turn
    // still ended on the decision, in one round.
    expect(model.boundSystemPrompts).toHaveLength(1);
    expect(
      model.boundSystemPrompts.some((p) =>
        p.includes("[Sistema] Você já usou"),
      ),
    ).toBe(false);
  });

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
