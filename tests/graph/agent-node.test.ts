import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type {
  StructuredToolInterface,
  ToolRunnableConfig,
} from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import { z } from "zod";
import {
  buildAgentGraph,
  lastAssistantText,
  recursionLimitFor,
} from "@/graph/graph";
import { CALLED_OFF_TOOL_RESULT } from "@/graph/markers";
import { contentToText } from "@/graph/message-text";
import {
  SKIP_REPLY_ACK,
  SKIP_REPLY_MARK,
  SKIP_REPLY_TOOL,
} from "@/graph/silence";
import { buildThreadStateGraph } from "@/graph/thread-state";
import { failableTool, toolFailure } from "@/graph/tools/failure";
import { buildNativeTools } from "@/graph/tools/native";
import { guardedTool } from "@/graph/tools/precondition";
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
  boundRounds: BaseMessage[][] = [];
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
        self.boundRounds.push(messages);
        return new AIMessage({
          content: "",
          tool_calls: [{ name: "noop", args: {}, id: `call_${n}` }],
        });
      },
    };
  }
}

// The soft limit's wrap-up instruction, recognized wherever it sits in a request.
const WRAP_UP = "[Sistema] Você já usou";
const carriesWrapUp = (round: BaseMessage[]) =>
  round.some((m) => contentToText(m.content).includes(WRAP_UP));

const noopTool = tool(async () => "feito", {
  name: "noop",
  description: "noop",
  schema: z.object({}),
});

// The REAL `skip_reply`, not a double: since round 24 the tool identifies itself with a mark in
// `additional_kwargs` that only it can set, so a stand-in returning the ack string is no longer the
// tool as far as `skipReplyRan` is concerned — which is the whole point of that change. It calls
// nothing, so the ctx below is never reached.
function realSkipTool(): StructuredToolInterface {
  const t = buildNativeTools({ client: {} as never, conversationId: 1 }, [
    SKIP_REPLY_TOOL,
  ]).find((x) => x.name === SKIP_REPLY_TOOL);
  if (!t) throw new Error("skip_reply is not in the native catalog");
  return t;
}

describe("agentNode tool-call limit (soft+hard)", () => {
  // Issue #454, review rounds 5 and 11, then issue #639. Silence is a TOOL CALL, so the graph loops
  // back with the tool's result and asks the model AGAIN — and round 5 only stopped that round from
  // being told "Conclua agora: responda ao cliente". Rounds 9 and 11 then made the decision terminal,
  // because whatever the model writes on that round goes to the customer, and on the proactive path
  // that is an unsolicited message.
  //
  // #639 measured the price of ending the turn: everything the operator asked for AFTER the decision
  // stops running, which is a real prompt shape (`one tool at a time` plus numbered steps starting at
  // `skip_reply`). So the round is back, and what rounds 9 and 11 were protecting is kept in code
  // instead — the wrap-up still cannot land on it, and the turn's last word is blanked on the way
  // out. The COUNT is untouched, so the cap still bounds a model that loops on skip_reply.
  test("the round after the silence decision exists, and carries no wrap-up", async () => {
    const skipTool = realSkipTool();
    // One skip_reply call, then an empty answer — the shape a silent turn actually has.
    class SkipThenSilentModel {
      boundRounds: BaseMessage[][] = [];
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            n++;
            self.boundRounds.push(messages);
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
    // TWO rounds: the decision no longer ends the turn (#639). The wrap-up is what must not land on
    // the second one — "responda ao cliente" is the exact opposite of what the model just chose —
    // and the control below proves the same cap DOES produce it for an ordinary turn.
    expect(model.boundRounds).toHaveLength(2);
    expect(model.boundRounds.some(carriesWrapUp)).toBe(false);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // The defect round 11 named, in the shape that reaches a person: the round after the decision is
  // where a follow-up that chose silence writes to the customer anyway. Well below the cap, so no
  // limit is involved — only the decision.
  //
  // #639 moved WHERE that is stopped without moving WHETHER: the model gets the round (it is the
  // round the operator's remaining steps run in) and the sentence it writes there is taken out of the
  // message the runtime posts. Both halves are asserted, and they have to be: "nothing was posted" is
  // satisfied just as well by a model that wrote nothing at all.
  test("a model that speaks after skip_reply is not delivered", async () => {
    const skipTool = realSkipTool();
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
    // It DID get the chance — which is the point, because that round is where `resolve_conversation`
    // would have run — and the customer gets nothing all the same.
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    // …and the words it wrote are nowhere in the turn's messages either: left in the channel they are
    // a sentence the customer never saw, read by the next turn as something they were told.
    expect(
      result.messages.some((m) => String(m.content ?? "").includes("boleto")),
    ).toBe(false);
  });

  // Round 9: the HARD limit is the other way the decision gets talked over. At `maxToolCalls: 1` the
  // budget is spent by the very round that chose silence, and that path exists to force a TEXT
  // answer — it invokes the raw model with no tools bound. A deliberate silence became a message.
  test("the hard limit does not force text out of a turn that chose silence", async () => {
    const skipTool = realSkipTool();
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

  // Round 13. A model can put text in the very message that calls `skip_reply`, and that text is
  // never delivered — the runtime posts the LAST assistant message, which is the empty one the turn
  // ends on. Left in the channel it is a sentence the customer never saw, read by the next turn as
  // something they were told: the false memory this whole family is about, arriving through the
  // silence protocol instead of through a refusal.
  test("text written beside the decision does not stay in the channel", async () => {
    const skipTool = realSkipTool();
    const NARRATION = "Vou deixar quieto por ora.";
    class TalksWhileSkipping {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            // The round after the decision, which #639 gave back: this model has nothing more to do
            // with it, and a real one never repeats a message id, so it gets its own empty turn
            // instead of the same object twice.
            if (self.rounds > 1)
              return new AIMessage({ id: "ai-quiet", content: "" });
            return new AIMessage({
              id: "ai-skip-1",
              content: NARRATION,
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              response_metadata: { finish_reason: "tool_calls" },
              usage_metadata: {
                input_tokens: 20,
                output_tokens: 10,
                total_tokens: 30,
              },
            });
          },
        };
      }
    }
    const model = new TalksWhileSkipping();
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "silence-narration" } },
    );
    // TWO rounds since #639: the decision no longer ends the turn. This stub asks for the same call
    // every round, so the second round makes no progress and the turn ends there — the blanking is
    // what this test is about either way, and it happens on the round the decision was SEEN.
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    // Gone from the CHANNEL, which is the copy the next turn reads back.
    const state = await buildThreadStateGraph(checkpointer).getState({
      configurable: { thread_id: "silence-narration" },
    });
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages.filter((m) => JSON.stringify(m.content).includes("quieto")),
    ).toEqual([]);
    // The tool call and its result stay: the results already in the channel name that call, and an
    // orphaned `tool_call_id` is a provider error on the next turn.
    expect(
      messages.some((m) => ((m as AIMessage).tool_calls?.length ?? 0) > 0),
    ).toBe(true);
    expect(messages.some((m) => m.getType() === "tool")).toBe(true);
    // ...and so does everything BUT the content. Rebuilding the message from its id and content
    // alone drops the model's own usage and response fields, which is a second edit nobody asked
    // for — content is the only thing this rule may change.
    const rewritten = messages.find((m) => m.id === "ai-skip-1") as AIMessage;
    expect(rewritten.response_metadata?.finish_reason).toBe("tool_calls");
    expect(rewritten.usage_metadata?.total_tokens).toBe(30);
    // AN EMPTY BLOCK LIST, never `""`. This message keeps its tool calls, so it stays in the history
    // the model is sent — and `@langchain/anthropic` renders string content as a text block, which
    // Anthropic refuses when empty. An empty list renders no text block at all.
    expect(rewritten.content).toEqual([]);
    expect(contentToText(rewritten.content)).toBe("");
  });

  // Round 20, and it is where rounds 13 and 18 meet. A PARALLEL batch is not terminal, so the
  // narration written beside the decision no longer went out through the branch that blanks it —
  // and the turn could still finish silent, leaving that text standing as something the customer
  // was told.
  test("narration beside a parallel skip is blanked even without ending there", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class NarratesThenGoesQuiet {
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
                id: "ai-par-1",
                content: "Só vou reagir e ficar quieto.",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            // #639: the lone decision on round 2 no longer ends the turn, so this model is asked a
            // third time and has nothing left to do.
            if (self.rounds > 2) return new AIMessage("");
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const model = new NarratesThenGoesQuiet();
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "parallel-narration" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      cfg,
    );
    // THREE rounds since #639, and the extra one is the whole fix: the lone `skip_reply` of round 2
    // is where the operator's remaining step would run, so it buys a round instead of ending there.
    expect(model.rounds).toBe(3);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(messages.length).toBeGreaterThan(0);
    expect(
      messages.filter((m) => JSON.stringify(m.content).includes("quieto")),
    ).toEqual([]);
    // The reaction's own record stays: it really happened.
    expect(messages.some((m) => m.getType() === "tool")).toBe(true);
  });

  // Round 22. At the hard limit the graph invokes the RAW model with no tools bound, to force a text
  // answer — and round 18 made a parallel batch non-terminal, so a model that chose silence and had
  // a companion to inspect landed exactly there. Round 9 already named that defect; this is the same
  // one arriving through the parallel door. The budget stops the tools that ACT and leaves the one
  // that does not, so the model can reaffirm silence after seeing the companion's result.
  test("the hard limit leaves a silent turn the option to stay silent", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    const boundAtLimit: string[][] = [];
    class ReaffirmsSilence {
      rawInvokes = 0;
      rounds = 0;
      // The raw path is what forces text, and it must NOT be what runs here.
      async invoke(): Promise<AIMessage> {
        this.rawInvokes++;
        return new AIMessage("texto que o cliente não pediu");
      }
      bindTools(tls: unknown) {
        const self = this;
        const names = (tls as { name: string }[]).map((t) => t.name);
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            // The round the hard limit runs: only the inert tool is on offer, and the model takes it.
            boundAtLimit.push(names);
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const model = new ReaffirmsSilence();
    const hits: Array<{ maxToolCalls: number; toolCalls: number }> = [];
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      // Spent by the parallel batch itself.
      maxToolCalls: 2,
      onToolLimit: (info) => hits.push(info),
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "hard-limit-parallel-silence" } },
    );
    expect(model.rawInvokes).toBe(0);
    expect(boundAtLimit).toEqual([[SKIP_REPLY_TOOL]]);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    // ONCE. The cap is one event — the turn ran out of budget — and its handlers write an operator
    // line and can page. Two rounds now cross the limit (the batch, then the reaffirmation), and
    // reporting both meant two warnings for one event, the second describing a round that spent
    // nothing (round 23).
    expect(hits).toEqual([{ maxToolCalls: 2, toolCalls: 2 }]);
  });

  // ...and the same round may ANSWER instead, which is what the customer needs when the companion
  // failed. The option is the point; the outcome is the model's.
  test("the hard limit still lets that turn answer if it wants to", async () => {
    const skipTool = realSkipTool();
    const reactTool = failableTool(async () => toolFailure("could not react"), {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class AnswersAfterAFailedReaction {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("nunca deveria rodar cru");
      }
      bindTools(_tls: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("Recebido, obrigado!");
          },
        };
      }
    }
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new AnswersAfterAFailedReaction() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 2,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "hard-limit-parallel-answer" } },
    );
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Recebido, obrigado!",
    );
  });

  // Round 22, the other half: the blanking is a reducer update that lands AFTER the model call, so
  // the extra round a parallel batch buys would otherwise still be SENT the sentence the customer
  // never received — and the model can lean on it, or repeat it, in the answer that does go out.
  test("the extra round is not shown the narration it is about to lose", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    const seenNarration: boolean[] = [];
    class NarratesThenIsAskedAgain {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tls: unknown) {
        const self = this;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                id: "ai-sent-1",
                content: "Só vou reagir e ficar quieto.",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            seenNarration.push(
              messages.some((m) =>
                JSON.stringify(m.content).includes("quieto"),
              ),
            );
            // The lone decision no longer ends the turn (#639), so this model is asked once more.
            // It has nothing left to do, which is how a turn like this one ends now.
            if (self.rounds > 2) return new AIMessage("");
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new NarratesThenIsAskedAgain() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "narration-not-sent" } },
    );
    // TWO rounds see the history now, and neither may carry the sentence: #639 gave the lone
    // decision a round of its own, and the blanking has to survive every one of them.
    expect(seenNarration).toEqual([false, false]);
  });

  // s7 of the holdout. The decision is no longer terminal, so "the model keeps asking for silence"
  // has to end somewhere, and the budget is the wrong somewhere: it is far away (`maxToolCalls` is
  // ten by default) and it exists to bound ACTION, not repetition. The second lone decision is where
  // the information ends — asked again after deciding alone, the model did nothing new.
  test("a model that only ever asks for silence stops at the second decision", async () => {
    const skipTool = realSkipTool();
    class AlwaysSkips {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            // A FRESH call id each round, which is what a real provider does — otherwise `ToolNode`
            // skips the repeat and the turn would end through the stall rule instead, proving
            // nothing about this one.
            return new AIMessage({
              content: "",
              tool_calls: [
                { name: SKIP_REPLY_TOOL, args: {}, id: `c${self.rounds}` },
              ],
            });
          },
        };
      }
    }
    const model = new AlwaysSkips();
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
      { configurable: { thread_id: "always-skips" } },
    );
    // Two decisions and no more, well short of the ten-call budget: the count is the assertion, and
    // without it "the turn ended" would be satisfied by the budget catching it eight rounds later.
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // THE STALL, which only became reachable when the decision stopped ending the turn. `ToolNode`
  // skips a call whose id already has an answer, so a model that repeats a batch verbatim gets no
  // new result and is asked again with the same history — forever, because the budget counts tool
  // RESULTS and none are being produced. Not a silence case at all, which is why it is tested with
  // an ordinary tool: the rule is about repetition, not about `skip_reply`.
  test("a batch whose every call was already answered ends the turn", async () => {
    let ran = 0;
    const counter = tool(
      async () => {
        ran++;
        return "counted";
      },
      { name: "count_it", description: "count", schema: z.object({}) },
    );
    class RepeatsTheSameCall {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            return new AIMessage({
              content: "",
              tool_calls: [{ name: "count_it", args: {}, id: "same-id" }],
            });
          },
        };
      }
    }
    const model = new RepeatsTheSameCall();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [counter],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("conte")] },
      { configurable: { thread_id: "repeats-same-call" } },
    );
    // The tool ran ONCE — the positive half, which is what says the turn reached the tool at all —
    // and the model was asked twice, not until the recursion limit.
    expect(ran).toBe(1);
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // THE DECISION STICKS, which is the half of #639 that is not about the extra round. `staySilent`
  // answers "what did the model just do", and the batch after the decision is the operator's own
  // call — so read off the LAST batch the turn would go back to being allowed to write, which is the
  // hazard the terminal branch existed for, arriving through the new door. Caught by the mutation
  // battery: making `silentTurn` read only the last batch left every other test green.
  test("a decision two batches back still silences what the model writes at the end", async () => {
    const skipTool = realSkipTool();
    let resolved = false;
    const resolveTool = tool(
      async () => {
        resolved = true;
        return "resolved";
      },
      {
        name: "resolve_conversation",
        description: "resolve",
        schema: z.object({}),
      },
    );
    class SkipsResolvesThenTalks {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1)
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            if (self.rounds === 2)
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "resolve_conversation", args: {}, id: "c2" },
                ],
              });
            // Two batches after the decision, and a model that forgot it. The customer must not be
            // written to all the same.
            return new AIMessage("Pronto, resolvi para você!");
          },
        };
      }
    }
    const model = new SkipsResolvesThenTalks();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, resolveTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("obrigado!")] },
      { configurable: { thread_id: "sticky-silence" } },
    );
    expect(resolved).toBe(true);
    expect(model.rounds).toBe(3);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    expect(JSON.stringify(result.messages)).not.toContain("resolvi para você");
  });

  // …and the decision belongs to ITS turn. The scan stops at the last human message, so a turn that
  // went silent does not silence the next one — which is a real sequence on a shared contact-inbox
  // thread, where every turn reads the same history.
  test("a decision from an earlier turn does not silence this one", async () => {
    const skipTool = realSkipTool();
    class SkipsOnceThenAnswersNextTurn {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1)
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            return new AIMessage("Bom dia! Como posso ajudar?");
          },
        };
      }
    }
    const model = new SkipsOnceThenAnswersNextTurn();
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "silence-does-not-carry" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool],
      maxToolCalls: 10,
    });
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    // A SECOND turn on the same thread, whose history still carries the first turn's decision.
    const second = await graph.invoke(
      { messages: [new HumanMessage("bom dia")] },
      cfg,
    );
    expect(String(second.messages.at(-1)?.content ?? "")).toBe(
      "Bom dia! Como posso ajudar?",
    );
  });

  // A REFUSED `skip_reply` is not a decision, and the rule that ENDS the turn on a reaffirmation has
  // to agree with the rule that RECOGNISES one. An operator may declare a precondition on the native
  // name; unmet, it returns an ordinary result under that name, which `skipReplyRan` does not accept.
  // A refusal followed by a real decision is two lone `skip_reply` batches that are NOT "asked twice,
  // nothing new" — and the mutation battery is why this exists: letting the decision leak from one
  // batch to the older one left every other test green while ending this turn a round early, with
  // the operator's `resolve_conversation` never run.
  test("a refused skip_reply is not the decision a reaffirmation would end on", async () => {
    const refusal = unmetPreconditionMessage(SKIP_REPLY_TOOL, {
      kind: "attribute",
      scope: "conversation",
      key: "cpf",
    });
    let calls = 0;
    // Refused on the FIRST call and honoured on the second, which is what a precondition does when
    // the attribute arrives mid-turn — and the only shape where two lone batches disagree. The
    // second result carries the MARK, because that, and not the text, is what makes it the decision.
    const sometimesGuarded = tool(
      async (_args: unknown, config: ToolRunnableConfig) => {
        calls++;
        if (calls === 1) return refusal;
        // The MARK, through the same direct-tool-output passthrough the real tool uses: the text is
        // not what identifies a decision, so a stand-in returning the ack string would leave both
        // batches non-decisions and this test would prove nothing.
        return new ToolMessage({
          content: SKIP_REPLY_ACK,
          tool_call_id: String(config?.toolCall?.id),
          name: SKIP_REPLY_TOOL,
          additional_kwargs: { [SKIP_REPLY_MARK]: true },
        });
      },
      { name: SKIP_REPLY_TOOL, description: "skip", schema: z.object({}) },
    );
    let resolved = false;
    const resolveTool = tool(
      async () => {
        resolved = true;
        return "resolved";
      },
      {
        name: "resolve_conversation",
        description: "resolve",
        schema: z.object({}),
      },
    );
    class AsksTwiceThenResolves {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds <= 2)
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: SKIP_REPLY_TOOL, args: {}, id: `c${self.rounds}` },
                ],
              });
            if (self.rounds === 3)
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "resolve_conversation", args: {}, id: "c3" },
                ],
              });
            return new AIMessage("");
          },
        };
      }
    }
    const model = new AsksTwiceThenResolves();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [sometimesGuarded, resolveTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "refused-then-real" } },
    );
    // The turn went past the second batch and ran what the operator asked for — the positive half.
    // Read as a reaffirmation it would have ended there, and `resolved` would be false.
    expect(resolved).toBe(true);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // WHAT THE BLANKING MAY NOT TOUCH, in a silent turn. Only the message that ENDS the turn is
  // rewritten — a preamble beside an ordinary call ("Vou registrar isso") is followed by work that
  // may lean on it, and rewriting every tool-calling turn's history is the different change
  // `silenceNarration` already refuses to make.
  test("a silent turn leaves a preamble beside an ordinary call alone", async () => {
    const skipTool = realSkipTool();
    const resolveTool = tool(async () => "resolved", {
      name: "resolve_conversation",
      description: "resolve",
      schema: z.object({}),
    });
    class SkipsThenNarratesAnAct {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1)
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            if (self.rounds === 2)
              return new AIMessage({
                id: "ai-preamble",
                content: "Vou registrar isso.",
                tool_calls: [
                  { name: "resolve_conversation", args: {}, id: "c2" },
                ],
              });
            return new AIMessage("");
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "silent-preamble" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new SkipsThenNarratesAnAct() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool, resolveTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      cfg,
    );
    // Nothing reached the customer, and the preamble is still in the channel where the next turn can
    // read what this one was doing.
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    const preamble = messages.find((m) => m.id === "ai-preamble");
    expect(String(preamble?.content ?? "")).toBe("Vou registrar isso.");
  });

  // …and what it MUST touch, in the shape only one vendor has. For the Responses API the history is
  // serialized from the raw `output` array in `response_metadata`, not from `content`, so a rule that
  // cleared `content` alone left the sentence in the copy that actually travels. The blanking of the
  // decision's own message has covered this since round 23; the turn's LAST message needed it too,
  // and only got it when the turn stopped ending on the decision.
  test("the final message of a silent turn loses its text in the provider's own copy too", async () => {
    const skipTool = realSkipTool();
    class SkipsThenSpeaksThroughResponses {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1)
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            return new AIMessage({
              id: "ai-final",
              content: "Tudo certo por aqui!",
              response_metadata: {
                output: [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      { type: "output_text", text: "Tudo certo por aqui!" },
                    ],
                  },
                ],
              },
            });
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "silent-responses-api" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new SkipsThenSpeaksThroughResponses() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      cfg,
    );
    // The model DID write — the positive half, without which "no copy survives" is satisfied by a
    // model that wrote nothing — and neither copy of it survives.
    const final = result.messages.find((m) => m.id === "ai-final") as AIMessage;
    expect(final).toBeDefined();
    expect(final.response_metadata?.output).toBeDefined();
    expect(JSON.stringify(result.messages)).not.toContain("Tudo certo");
  });

  // The wrap-up is "Conclua agora: responda ao cliente", which is the opposite of what a silent turn
  // chose — and now that the turn goes on, it can reach the soft limit while still silent. Round 18
  // suppressed it for the batch that just decided; #639 has to keep it suppressed for the rest.
  test("the wrap-up does not land on the rounds after a lone decision", async () => {
    const skipTool = realSkipTool();
    const noop = tool(async () => "feito", {
      name: "noop2",
      description: "noop",
      schema: z.object({}),
    });
    class SkipsThenWorksUpToTheLimit {
      boundRounds: BaseMessage[][] = [];
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            self.rounds++;
            self.boundRounds.push(messages);
            if (self.rounds === 1)
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            if (self.rounds <= 3)
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "noop2", args: {}, id: `n${self.rounds}` },
                ],
              });
            return new AIMessage("");
          },
        };
      }
    }
    const model = new SkipsThenWorksUpToTheLimit();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, noop],
      // Small enough that the soft limit (max - 2) is crossed on the rounds after the decision.
      maxToolCalls: 4,
    });
    await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "silent-soft-limit" } },
    );
    // The turn really did cross the soft limit — without this the assertion below is satisfied by a
    // turn that never got near it.
    expect(model.rounds).toBeGreaterThanOrEqual(3);
    expect(model.boundRounds.some(carriesWrapUp)).toBe(false);
  });

  // A batch is a repeat only when EVERY call in it is already answered. One old call beside a new one
  // still produces a result, so the round after it sees something this one did not.
  test("a batch that repeats one call and makes another is not a stall", async () => {
    let ran = 0;
    const counter = tool(
      async () => {
        ran++;
        return "counted";
      },
      { name: "count_it", description: "count", schema: z.object({}) },
    );
    class RepeatsOneAndAddsOne {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1)
              return new AIMessage({
                content: "",
                tool_calls: [{ name: "count_it", args: {}, id: "old" }],
              });
            if (self.rounds === 2)
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "count_it", args: {}, id: "old" },
                  { name: "count_it", args: {}, id: "new" },
                ],
              });
            return new AIMessage("pronto");
          },
        };
      }
    }
    const model = new RepeatsOneAndAddsOne();
    const result = await buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [counter],
      maxToolCalls: 10,
    }).invoke(
      { messages: [new HumanMessage("conte")] },
      { configurable: { thread_id: "partial-repeat" } },
    );
    // The new call ran (twice in total) and the turn reached its answer.
    expect(ran).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("pronto");
  });

  // Round 26. A provider can emit a good `skip_reply` beside a call whose arguments do not parse, and
  // LangChain files that one under `invalid_tool_calls` — invisible to a check that reads
  // `tool_calls`. The batch then looked like nothing but the decision, the turn ended, and the model
  // never got the round where it would have seen the failure and answered.
  test("a malformed companion call is a companion", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({ emoji: z.string() }),
    });
    class SkipsBesideAMalformedCall {
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
                id: "ai-inv-1",
                content: "Vou reagir e sumir.",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
                invalid_tool_calls: [
                  {
                    name: "react_to_message",
                    args: "{ emoji: ",
                    id: "c2",
                    error: "Malformed args.",
                  },
                ],
              });
            }
            return new AIMessage("Recebido, obrigado!");
          },
        };
      }
    }
    const model = new SkipsBesideAMalformedCall();
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "malformed-companion" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      cfg,
    );
    // The turn did NOT end on the decision, and the customer got the answer.
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Recebido, obrigado!",
    );
    // The narration is still blanked, and the malformed call survives the rebuild: it is part of
    // what the model asked for, and dropping it erases the record of a call that failed to parse.
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    const rewritten = messages.find((m) => m.id === "ai-inv-1") as AIMessage;
    expect(contentToText(rewritten.content)).toBe("");
    expect(rewritten.invalid_tool_calls?.map((c) => c.name)).toEqual([
      "react_to_message",
    ]);
  });

  // Round 27. A provider can return blocks BESIDE the text, and Anthropic's `thinking` /
  // `redacted_thinking` are signed and must be replayed unchanged before the tool result they
  // precede — so emptying the block list deletes protocol data and the very next round fails at the
  // provider. And for models served over the Responses API, `@langchain/openai` replays the raw
  // `output` array from `response_metadata` rather than `content`, so blanking `content` alone hands
  // the narration back anyway. Text is the only thing this rule may remove, wherever it lives.
  test("blanking removes the text and nothing else", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class ThinksThenSkips {
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
                id: "ai-think-1",
                content: [
                  { type: "thinking", thinking: "hmm", signature: "sig-abc" },
                  { type: "text", text: "Vou só reagir." },
                ],
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
                response_metadata: {
                  output: [
                    { type: "reasoning", id: "rs_1", summary: [] },
                    {
                      type: "message",
                      role: "assistant",
                      content: [
                        { type: "output_text", text: "Vou só reagir." },
                      ],
                    },
                    { type: "function_call", name: SKIP_REPLY_TOOL, id: "fc1" },
                    // An item that ARRIVED empty is the provider's own: the filter removed nothing
                    // from it, so it is not this rule's to drop.
                    { type: "message", role: "assistant", content: [] },
                  ],
                },
              });
            }
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const cfg = { configurable: { thread_id: "blank-text-only" } };
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new ThinksThenSkips() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    await graph.invoke({ messages: [new HumanMessage("👍")] }, cfg);
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    const rewritten = messages.find((m) => m.id === "ai-think-1") as AIMessage;
    // The signed thinking block survives; the text is gone.
    expect(rewritten.content).toEqual([
      { type: "thinking", thinking: "hmm", signature: "sig-abc" },
    ]);
    // ...and so does the raw provider output, minus its text part. `reasoning` and `function_call`
    // are untouched: they carry state the provider needs back.
    const out = rewritten.response_metadata?.output as Array<
      Record<string, unknown>
    >;
    // The message item was nothing but text, so it goes with the text: left behind with an empty
    // content array it is the Responses API's own version of the empty text block, and the replay is
    // rejected. `reasoning` and `function_call` carry state the provider needs back and stay.
    expect(out.map((o) => o.type)).toEqual([
      "reasoning",
      "function_call",
      "message",
    ]);
    expect(out[2]?.content).toEqual([]);
    expect(JSON.stringify(rewritten)).not.toContain("Vou só reagir");
  });

  // The scope, pinned: a preamble beside an ORDINARY call is followed by a reply that may lean on
  // it, and rewriting the history of every tool-calling turn is a different change. Only the
  // decision to say nothing is rewritten here.
  test("a preamble beside an ordinary tool call is left alone", async () => {
    const echo = tool(async () => "pedido 42: enviado", {
      name: "search_order",
      description: "search",
      schema: z.object({}),
    });
    class PreamblesThenAnswers {
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
                id: "ai-pre-1",
                content: "Vou verificar seu pedido.",
                tool_calls: [{ name: "search_order", args: {}, id: "c1" }],
              });
            }
            return new AIMessage("Seu pedido 42 já foi enviado.");
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new PreamblesThenAnswers() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [echo],
      maxToolCalls: 10,
    });
    await graph.invoke(
      { messages: [new HumanMessage("cadê meu pedido?")] },
      { configurable: { thread_id: "ordinary-preamble" } },
    );
    const state = await buildThreadStateGraph(checkpointer).getState({
      configurable: { thread_id: "ordinary-preamble" },
    });
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(
      messages.filter((m) => JSON.stringify(m.content).includes("verificar")),
    ).not.toEqual([]);
  });

  // Round 17. `skip_reply` beside `react_to_message` is the documented way to answer with a reaction
  // ALONE — so the reaction IS the reply, and when it fails, ending the turn on the skip leaves the
  // customer with nothing at all. The model has to see that result and decide again, which is what
  // every other failed tool call already gets. (Round 18 widened the rule to every companion, for
  // the reason below; this case is what made the question visible.)
  test("a companion tool that FAILED keeps the turn going", async () => {
    const skipTool = realSkipTool();
    const reactTool = failableTool(
      async () => toolFailure("could not react: the message is a reaction"),
      { name: "react_to_message", description: "react", schema: z.object({}) },
    );
    class SkipsWithABrokenReaction {
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
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("Recebido, obrigado!");
          },
        };
      }
    }
    const model = new SkipsWithABrokenReaction();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "companion-failed" } },
    );
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Recebido, obrigado!",
    );
  });

  // ISSUE #639. A LONE decision no longer ENDS the turn, it makes the turn SILENT — two different
  // guarantees, and `docs/graph.md` only ever argued for the second ("a turn that chose silence
  // writes to the customer anyway" is the hazard). Ending it costs the operator everything they
  // asked for after the decision, and the shape that reaches it is ordinary: a prompt that forbids
  // parallel calls (the agent in the report carries one for `set_labels`, #604) and names
  // `skip_reply` before the rest. Measured live on the issue, the two failing cells are exactly the
  // two that name it first, and no wording fixes it — the note that takes gpt-5.2 from 0/12 to 12/12
  // does nothing on gpt-5.6-luna, because it asks the model to disobey the operator's own ordering.
  test("a lone skip_reply lets the rest of what the operator asked for run", async () => {
    const skipTool = realSkipTool();
    let resolved = false;
    const resolveTool = failableTool(
      async () => {
        resolved = true;
        return "resolved";
      },
      {
        name: "resolve_conversation",
        description: "resolve",
        schema: z.object({}),
      },
    );
    class OneToolAtATime {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            // The operator's numbered steps, obeyed literally: one call per round, skip first.
            if (self.rounds === 1)
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            if (self.rounds === 2)
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "resolve_conversation", args: {}, id: "c2" },
                ],
              });
            return new AIMessage("");
          },
        };
      }
    }
    const model = new OneToolAtATime();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, resolveTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("obrigado!")] },
      { configurable: { thread_id: "lone-skip-then-resolve" } },
    );
    // THE POSITIVE HALF FIRST, and it is not decoration: "nothing was delivered" is satisfied just
    // as well by a turn that stopped dead, which is the bug. The resolve having RUN is what says the
    // path was walked (the process note of 18/set, on assertions of absence).
    expect(resolved).toBe(true);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // ...and a companion the operator's own rule REFUSED is the same thing to the customer: the
  // reaction did not happen, so ending on the skip leaves them with nothing. Round 17 read that off
  // the RESULT; round 18 showed a result cannot answer it (a tool may decline through an ordinary
  // success string), so the rule moved to the CALLS. This case is covered by the same rule now, and
  // it stays because it is the shape an operator can actually configure.
  test("a companion tool that was REFUSED keeps the turn going", async () => {
    const skipTool = realSkipTool();
    const reactTool = guardedTool(
      tool(async () => "reacted with 👍", {
        name: "react_to_message",
        description: "react",
        schema: z.object({}),
      }),
      { kind: "attribute", scope: "conversation", key: "cpf" },
      // No attributes at all, so the condition is unmet.
      async () => ({ conversationAttributes: {}, contactAttributes: {} }),
    );
    class SkipsWithARefusedReaction {
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
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            return new AIMessage("Me confirma seu CPF?");
          },
        };
      }
    }
    const model = new SkipsWithARefusedReaction();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "companion-refused" } },
    );
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe(
      "Me confirma seu CPF?",
    );
  });

  // The control, and round 18 changed what it controls FOR. A batch that called something else has
  // produced information the model has not seen, so it decides again — whether that companion
  // worked or not, because a tool can decline through a perfectly ordinary success result and no
  // reader can tell. What the extra round must still deliver is SILENCE when the model asks for it
  // alone: the decision is terminal there, and the raw model never speaks.
  test("a companion that worked costs one round and still ends silent", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reacted with 👍", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class SkipsWithAReaction {
      rounds = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("nunca deveria falar");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(): Promise<AIMessage> {
            self.rounds++;
            if (self.rounds === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [
                  { name: "react_to_message", args: {}, id: "c1" },
                  { name: SKIP_REPLY_TOOL, args: {}, id: "c2" },
                ],
              });
            }
            // Having seen the reaction land, the model asks for silence ALONE. That used to end the
            // turn; since #639 it buys one round, because that round is where the operator's
            // remaining steps run. This model has none, so it spends the round and stops.
            if (self.rounds > 2) return new AIMessage("");
            return new AIMessage({
              content: "",
              tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c3" }],
            });
          },
        };
      }
    }
    const model = new SkipsWithAReaction();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [skipTool, reactTool],
      maxToolCalls: 10,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("👍")] },
      { configurable: { thread_id: "companion-ok" } },
    );
    // THREE since #639: the reaffirmation on round 2 is a lone decision, and a lone decision now
    // buys the round where the operator's remaining steps would run.
    expect(model.rounds).toBe(3);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("");
  });

  // Round 17, the other half. The terminal marker is an EMPTY assistant message, and it stays in the
  // channel on purpose — it is what keeps `lastAssistantText` reading "" instead of the skip tool's
  // acknowledgement, which would otherwise go to the customer as the reply. What it must not do is
  // reach the provider: `@langchain/anthropic` renders string content as a text block and Anthropic
  // refuses an empty one, so a thread that accumulated one would stop answering entirely.
  test("the empty turn stays in the channel and never reaches the model", async () => {
    const skipTool = realSkipTool();
    const seen: number[] = [];
    class CountsEmptyAssistantTurns {
      round = 0;
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            seen.push(
              messages.filter(
                (m) =>
                  m.getType() === "ai" &&
                  ((m as AIMessage).tool_calls?.length ?? 0) === 0 &&
                  String(m.content).trim() === "",
              ).length,
            );
            self.round++;
            if (self.round === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: SKIP_REPLY_TOOL, args: {}, id: "c1" }],
              });
            }
            return new AIMessage("Oi de novo!");
          },
        };
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new CountsEmptyAssistantTurns() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [skipTool],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "empty-turn-filtered" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    // A SECOND customer turn on the same thread, which is where the invalid history would land.
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    // The channel kept it...
    const state = await buildThreadStateGraph(checkpointer).getState(cfg);
    const messages = ((state.values as { messages?: BaseMessage[] })
      ?.messages ?? []) as BaseMessage[];
    expect(
      messages.filter(
        (m) =>
          m.getType() === "ai" &&
          ((m as AIMessage).tool_calls?.length ?? 0) === 0 &&
          String(m.content).trim() === "",
      ).length,
    ).toBeGreaterThan(0);
    // ...and the model never saw one, on any round.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual(seen.map(() => 0));
  });

  // Round 31, the half the filter above got wrong. "No text" and "empty" are not the same question:
  // a provider can return a turn whose whole content is a signed `thinking` block, with no tool
  // calls and no text at all. Classifying that as an empty turn deletes provider-native output from
  // every later prompt, and it deletes exactly what `silenceNarration` above takes such care to keep.
  test("a turn whose only content is a non-text block still reaches the model", async () => {
    const seen: number[] = [];
    class RecordsThinkingTurns {
      round = 0;
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        seen.push(
          messages.filter(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some(
                (b) => (b as { type?: unknown }).type === "thinking",
              ),
          ).length,
        );
        this.round++;
        // NOTE: The first turn answers with reasoning alone: no text, no tool calls.
        if (this.round === 1)
          return new AIMessage({
            content: [
              { type: "thinking", thinking: "pensando", signature: "sig-abc" },
            ],
            response_metadata: { model_provider: "anthropic" },
          });
        return new AIMessage("Oi de novo!");
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "anthropic", model: "test-model" },
      model: new RecordsThinkingTurns() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "thinking-only-turn" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    // The first round saw none because none existed yet; the second must see the one the first left.
    expect(seen).toEqual([0, 1]);
  });

  // ...and the exemption ends where the block stops being renderable. `@langchain/openai` builds an
  // assistant message out of the text blocks alone, so an Anthropic `thinking` block handed to an
  // OpenAI-shaped model arrives as `content: []` and the request is refused — every later turn on
  // the thread with it. The fallback can take over mid-invocation and is handed the same array, so
  // its vendor counts as a destination even on the turns it never answers.
  test("the same turn is dropped once another vendor can receive it", async () => {
    const seen: number[] = [];
    class ThinksThenCounts {
      round = 0;
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        seen.push(
          messages.filter(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some(
                (b) => (b as { type?: unknown }).type === "thinking",
              ),
          ).length,
        );
        this.round++;
        if (this.round === 1)
          return new AIMessage({
            content: [
              { type: "thinking", thinking: "pensando", signature: "sig-abc" },
            ],
            response_metadata: { model_provider: "anthropic" },
          });
        return new AIMessage("Oi de novo!");
      }
    }
    const model = new ThinksThenCounts() as unknown as BaseChatModel;
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "anthropic", model: "test-model" },
      // NOTE: The agent never falls over in this test; merely CONFIGURING a second vendor is what
      // makes the turn unsafe to keep, because the node cannot know in advance who answers.
      fallback: { model, provider: "openai", modelId: "gpt-test" },
      model,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "thinking-cross-vendor" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    expect(seen).toEqual([0, 0]);
  });

  // And an unsigned origin is not a licence either: a turn whose provider the metadata does not name
  // cannot be proved renderable anywhere, so it takes the same safe exit.
  test("a non-text turn of unknown origin is dropped", async () => {
    const seen: number[] = [];
    class ThinksWithoutSaying {
      round = 0;
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        seen.push(
          messages.filter(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some(
                (b) => (b as { type?: unknown }).type === "thinking",
              ),
          ).length,
        );
        this.round++;
        if (this.round === 1)
          return new AIMessage({
            content: [
              { type: "thinking", thinking: "pensando", signature: "sig-abc" },
            ],
          });
        return new AIMessage("Oi de novo!");
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "anthropic", model: "test-model" },
      model: new ThinksWithoutSaying() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "thinking-unknown-origin" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    expect(seen).toEqual([0, 0]);
  });

  // Nor is every vendor's block replayable by its own vendor. Google's adapter builds an assistant
  // message out of text too, so a Gemini reasoning turn does not survive even a same-provider trip:
  // the exemption is a short list of vendors that replay what they emitted, not a property of
  // "came from where it is going".
  test("a non-text turn from a vendor that does not replay its blocks is dropped", async () => {
    const seen: number[] = [];
    class ThinksOnce {
      round = 0;
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        seen.push(
          messages.filter(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some(
                (b) => (b as { type?: unknown }).type === "thinking",
              ),
          ).length,
        );
        this.round++;
        if (this.round === 1)
          return new AIMessage({
            content: [
              { type: "thinking", thinking: "pensando", signature: "sig-abc" },
            ],
            response_metadata: { model_provider: "google" },
          });
        return new AIMessage("Oi de novo!");
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "google", model: "test-model" },
      model: new ThinksOnce() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "thinking-google-origin" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    expect(seen).toEqual([0, 0]);
  });

  // And the destination has to be nameable at all. An install that reaches the node without naming a
  // provider proves nothing about where the turn lands, and "no destinations" must not read as "every
  // destination agrees" — which is what an unguarded `every` over an empty set would say.
  test("a non-text turn is dropped when no destination can be named", async () => {
    const seen: number[] = [];
    class ThinksOnce {
      round = 0;
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        seen.push(
          messages.filter(
            (m) =>
              Array.isArray(m.content) &&
              m.content.some(
                (b) => (b as { type?: unknown }).type === "thinking",
              ),
          ).length,
        );
        this.round++;
        if (this.round === 1)
          return new AIMessage({
            content: [
              { type: "thinking", thinking: "pensando", signature: "sig-abc" },
            ],
            response_metadata: { model_provider: "anthropic" },
          });
        return new AIMessage("Oi de novo!");
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "", model: "test-model" },
      model: new ThinksOnce() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "thinking-no-destination" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    expect(seen).toEqual([0, 0]);
  });

  // Round 1 of the follow-up, and it is the case the guard above must NOT make an exception for. A
  // call that failed to parse is never executed, so `toolsCondition` ends the graph and nothing ever
  // answers it — and `@langchain/openai` keeps the RAW calls in `additional_kwargs.tool_calls` and
  // replays those whenever `tool_calls` is empty. Keeping that turn hands OpenAI an assistant tool
  // call with no tool response, which it rejects, and every later turn on the thread dies with it.
  test("a turn whose only record is an unparseable call never reaches the model", async () => {
    const seen: number[] = [];
    class RecordsInvalidCallTurns {
      round = 0;
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        seen.push(
          messages.filter(
            (m) => ((m as AIMessage).invalid_tool_calls?.length ?? 0) > 0,
          ).length,
        );
        this.round++;
        if (this.round === 1) {
          return new AIMessage({
            content: "",
            invalid_tool_calls: [
              { name: "consultar", args: "{não é json", id: "b1", error: "x" },
            ],
          });
        }
        return new AIMessage("Oi de novo!");
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new RecordsInvalidCallTurns() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "invalid-call-only-turn" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    expect(seen).toEqual([0, 0]);
  });

  // The other side of the same guard: a block list is not automatically output. A provider that
  // answers with an empty string in block form produces a list of nothing but empty text, and that
  // IS the absence the filter exists for — asking `Array.isArray` alone, without asking what the
  // list holds, would keep it.
  test("a turn whose blocks are nothing but empty text never reaches the model", async () => {
    const seen: number[] = [];
    class RecordsBlockListTurns {
      round = 0;
      async invoke(messages: BaseMessage[]): Promise<AIMessage> {
        seen.push(
          messages.filter(
            (m) => m.getType() === "ai" && Array.isArray(m.content),
          ).length,
        );
        this.round++;
        if (this.round === 1) {
          return new AIMessage({ content: [{ type: "text", text: "" }] });
        }
        return new AIMessage("Oi de novo!");
      }
    }
    const checkpointer = new MemorySaver();
    const graph = buildAgentGraph({
      primary: { provider: "anthropic", model: "test-model" },
      model: new RecordsBlockListTurns() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer,
      tools: [],
      maxToolCalls: 10,
    });
    const cfg = { configurable: { thread_id: "empty-block-list-turn" } };
    await graph.invoke({ messages: [new HumanMessage("ok")] }, cfg);
    await graph.invoke({ messages: [new HumanMessage("e aí?")] }, cfg);
    expect(seen).toEqual([0, 0]);
  });

  // And the filter answers "is this an EMPTY ASSISTANT turn", so the type is load-bearing. A tool
  // that returns an empty string produces a `ToolMessage` with no content at all; reading that as an
  // empty turn drops it and orphans the `tool_call_id` the call before it opened, which every
  // provider rejects.
  test("a tool result that came back empty still reaches the model", async () => {
    const emptyTool = tool(async () => "", {
      name: "consultar",
      description: "consulta",
      schema: z.object({}),
    });
    const seen: number[] = [];
    class RecordsToolMessages {
      round = 0;
      bindTools(_tools: unknown) {
        const self = this;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            seen.push(messages.filter((m) => m.getType() === "tool").length);
            self.round++;
            if (self.round === 1) {
              return new AIMessage({
                content: "",
                tool_calls: [{ name: "consultar", args: {}, id: "t1" }],
              });
            }
            return new AIMessage("Pronto!");
          },
        };
      }
    }
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: new RecordsToolMessages() as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [emptyTool],
      maxToolCalls: 10,
    });
    await graph.invoke(
      { messages: [new HumanMessage("ok")] },
      { configurable: { thread_id: "empty-tool-result" } },
    );
    // The round after the call must carry the result, empty body and all.
    expect(seen).toEqual([0, 1]);
  });

  // Round 7: parallel tool calls. `skip_reply` alongside `react_to_message` is the documented way to
  // answer with a reaction alone, and whichever result lands last is an ordering accident — reading
  // only the last one made the wrap-up instruction depend on it.
  test("skip_reply counts even when another tool's result lands last", async () => {
    const skipTool = realSkipTool();
    const reactTool = tool(async () => "reagiu", {
      name: "react_to_message",
      description: "react",
      schema: z.object({}),
    });
    class ParallelThenSilentModel {
      boundRounds: BaseMessage[][] = [];
      async invoke(): Promise<AIMessage> {
        return new AIMessage("");
      }
      bindTools(_tools: unknown) {
        const self = this;
        let n = 0;
        return {
          async invoke(messages: BaseMessage[]): Promise<AIMessage> {
            n++;
            self.boundRounds.push(messages);
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
    // The batch was READ, not just its last result: the reaction landed AFTER the skip and the round
    // that follows was still not told to answer the customer. Two rounds now, because a batch that
    // called something else is not terminal (round 18) — which is exactly why reading the whole
    // batch still matters: the wrap-up instruction would otherwise land on the round after a
    // decision to stay quiet.
    expect(model.boundRounds.length).toBeGreaterThanOrEqual(2);
    expect(model.boundRounds.some(carriesWrapUp)).toBe(false);
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
    // The soft "wrap up" instruction was sent once the budget got close (N-2 = 1 execution in), and
    // the first invoke (0 executions) went without it.
    expect(model.boundRounds.map(carriesWrapUp)).toEqual([false, true, true]);
  });

  // Issue #628. The wrap-up is an instruction, so it travels in a role a customer cannot type into:
  // "[Sistema] ..." in a chat message arrives as a human message, and a real instruction sent the
  // same way would be indistinguishable from it. Checked on every path below, whatever else differs.
  const humanCarriesWrapUp = (round: BaseMessage[]) =>
    carriesWrapUp(round.filter((m) => m.getType() === "human"));

  const runToTheCap = async (
    threadId: string,
    primary: string,
    fallbackProvider?: string,
    noReplyChannel?: boolean,
  ) => {
    const model = new ToolLoopModel();
    const graph = buildAgentGraph({
      primary: { provider: primary, model: "test-model" },
      model: model as unknown as BaseChatModel,
      ...(fallbackProvider
        ? {
            fallback: {
              model: new ToolLoopModel() as unknown as BaseChatModel,
              provider: fallbackProvider,
              modelId: "fallback-model",
            },
          }
        : {}),
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [noopTool],
      maxToolCalls: 3,
      ...(noReplyChannel ? { noReplyChannel: true } : {}),
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("faça muitas coisas")] },
      { configurable: { thread_id: threadId } },
    );
    return { rounds: model.boundRounds, result };
  };

  // ISSUE #629. An observation turn has nobody to answer: its frame says any text it writes reaches
  // nowhere and its client is muted. The budget is the same, the sentence after it is not.
  const REPLY_SENTENCE = "responda ao cliente";
  const roundWithWrapUp = (rounds: BaseMessage[][]) => {
    const round = rounds.find(carriesWrapUp);
    if (!round) throw new Error("no round carried the wrap-up");
    return round.map((m) => contentToText(m.content)).join("\n");
  };

  test("a turn with no reply channel is told to finish with its tools, never to answer a customer", async () => {
    const { rounds } = await runToTheCap(
      "limit-noreply",
      "openai",
      undefined,
      true,
    );
    expect(rounds.map(carriesWrapUp)).toEqual([false, true, true]);
    const sent = roundWithWrapUp(rounds);
    expect(sent).not.toContain(REPLY_SENTENCE);
    expect(sent).toContain("encerre sem escrever nada");
    // NOTE: the budget itself is unchanged, and so is where the instruction travels.
    expect(sent).toContain("1 de 3 ferramentas");
    for (const round of rounds) expect(humanCarriesWrapUp(round)).toBe(false);
  });

  test("an ordinary turn still gets the answer-the-customer wording", async () => {
    const { rounds } = await runToTheCap("limit-reply", "openai");
    expect(roundWithWrapUp(rounds)).toContain(REPLY_SENTENCE);
  });

  test("the wording follows the turn, not the provider", async () => {
    const { rounds } = await runToTheCap(
      "limit-noreply-anthropic",
      "anthropic",
      undefined,
      true,
    );
    // NOTE: inside the system prompt here, and still without the reply sentence.
    const prompt = contentToText(rounds[1]?.[0]?.content ?? "");
    expect(prompt).toContain(WRAP_UP);
    expect(prompt).not.toContain(REPLY_SENTENCE);
  });

  // Where every destination takes a system message after the history, the instruction goes there,
  // because a provider caches a request by its exact prefix: nothing a previous round sent may
  // change, not the system prompt and not the history.
  test("on openai the wrap-up is a system message after the history, and everything before it is what the previous round sent", async () => {
    const { rounds, result } = await runToTheCap("limit-prefix", "openai");
    expect(rounds).toHaveLength(3);
    const shape = (m: BaseMessage) =>
      `${m.getType()}:${contentToText(m.content)}`;
    for (const [i, round] of rounds.entries()) {
      // The system prompt is the same bytes on every round, instruction or not.
      expect(round[0]?.getType()).toBe("system");
      expect(round[0]?.content).toBe("PROMPT");
      expect(humanCarriesWrapUp(round)).toBe(false);
      const systems = round.filter((m) => m.getType() === "system");
      if (carriesWrapUp(round)) {
        // The last message, a system one, and the only place the instruction is.
        expect(round.at(-1)?.getType()).toBe("system");
        expect(contentToText(round.at(-1)?.content ?? "")).toContain(WRAP_UP);
        expect(carriesWrapUp(round.slice(0, -1))).toBe(false);
        expect(systems).toHaveLength(2);
      } else {
        expect(systems).toHaveLength(1);
      }
      // Everything this round sent before its instruction opens the next round, message for message.
      const next = rounds[i + 1];
      if (!next) continue;
      const kept = carriesWrapUp(round) ? round.slice(0, -1) : round;
      expect(next.slice(0, kept.length).map(shape)).toEqual(kept.map(shape));
    }
    // Sent, not persisted: the thread the next turn loads carries no instruction.
    expect(carriesWrapUp(result.messages)).toBe(false);
  });

  // Anywhere else the late system message is refused before a request is made (Google, Anthropic) or
  // reaches a server whose rules are unknown, so the instruction stays inside the system prompt —
  // including when only the FALLBACK is such a provider, because it is handed the same messages.
  test.each([
    { label: "an anthropic agent", primary: "anthropic" },
    { label: "a google agent", primary: "google" },
    { label: "an openrouter agent", primary: "openrouter" },
    {
      label: "an openai agent whose fallback is google",
      primary: "openai",
      fallback: "google",
    },
  ])(
    "on $label the wrap-up stays inside the one system prompt",
    async ({ primary, fallback }) => {
      const { rounds, result } = await runToTheCap(
        `limit-prompt-${primary}-${fallback ?? "none"}`,
        primary,
        fallback,
      );
      expect(rounds.map(carriesWrapUp)).toEqual([false, true, true]);
      for (const round of rounds) {
        expect(round.filter((m) => m.getType() === "system")).toHaveLength(1);
        expect(round[0]?.getType()).toBe("system");
        expect(round.at(-1)?.getType()).not.toBe("system");
        expect(humanCarriesWrapUp(round)).toBe(false);
      }
      expect(contentToText(rounds[1]?.[0]?.content ?? "")).toContain(WRAP_UP);
      expect(carriesWrapUp(result.messages)).toBe(false);
    },
  );
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

// ISSUE #449. `stillWanted` is the runtime's own ask, and every seam it owns is BETWEEN two steps:
// before the divider, after the claim, before the invoke, at each outward write. A tool call happens
// INSIDE one, so a `/reset` that lands once the model call is in flight is refused on its memory
// step, says so, and the turn's tools then write an attribute, a label and a kanban card back onto
// the conversation the operator was just told about. The seam that covers every tool source at once
// is the node they all pass through.
describe("the tool boundary refuses a turn that was called off", () => {
  // Calls a tool, then answers. The shape of the turn the window is measured on.
  class CallsThenAnswers {
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
              tool_calls: [{ name: "writer", args: { v: "sim" }, id: "c1" }],
            });
          }
          return new AIMessage("pronto");
        },
      };
    }
  }

  const writerTool = (ran: string[]): StructuredToolInterface =>
    tool(
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

  test("the tool does not run, its call is still answered, and the turn ends", async () => {
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writerTool(ran)],
      stillWanted: async () => false,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("marca como qualificado")] },
      { configurable: { thread_id: "called-off" } },
    );
    // The write the operator was told had been undone.
    expect(ran).toEqual([]);
    // ONE round: answering the refusal back into the model would invite it to call the same tool
    // again, to the recursion limit, on a conversation that was already cleared.
    expect(model.rounds).toBe(1);
    // And the call is answered, which is the half a plain "route away" gets wrong: the next turn
    // loads this thread, and an assistant turn carrying tool calls that no ToolMessage answers is
    // what the providers reject (see the empty-turn rule above — @langchain/openai replays those
    // calls out of `additional_kwargs`).
    const answers = result.messages.filter((m) => m.getType() === "tool");
    expect(
      answers.map(
        (m) => (m as unknown as { tool_call_id: string }).tool_call_id,
      ),
    ).toEqual(["c1"]);
    expect(contentToText(answers[0]?.content ?? "")).toBe(
      CALLED_OFF_TOOL_RESULT,
    );
  });

  // AND IT DOES NOT END ON THAT MESSAGE. The runtime reads the reply off the LAST message of the
  // result whatever its type (`lastAssistantText`), so ending on the `ToolMessage` would offer the
  // refusal's own sentence as the text to post. The gate at each send refuses a called-off turn
  // today — but the fences this graph is handed are not all monotonic (the channel-redirect one
  // answers false while an agent is disabled and true once it is re-enabled), so the property has to
  // hold at this seam rather than depend on the caller agreeing with it later.
  test("the refused turn ends on an empty assistant message, so nothing is postable", async () => {
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writerTool(ran)],
      stillWanted: async () => false,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("marca como qualificado")] },
      { configurable: { thread_id: "called-off-tail" } },
    );
    expect(result.messages.at(-1)?.getType()).toBe("ai");
    expect(lastAssistantText(result.messages)).toBe("");
    // The refusal is still in the thread, one message back: it is the answer the NEXT turn needs.
    expect(result.messages.at(-2)?.getType()).toBe("tool");
  });

  // ALL OR NOTHING, and the rollback's pairing rests on it: the boundary reads ONE assistant turn and
  // answers every call it carries, so a batch never comes back half-run. Without this the positional
  // rule in ../graph/refused-turn.ts would be pairing against a shape nothing pins.
  test("a batch of calls is refused whole, and every one of them is answered", async () => {
    const ran: string[] = [];
    class CallsTwiceInOneTurn {
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
                tool_calls: [
                  { name: "writer", args: { v: "um" }, id: "c1" },
                  { name: "writer", args: { v: "dois" }, id: "c2" },
                ],
              });
            }
            return new AIMessage("pronto");
          },
        };
      }
    }
    const model = new CallsTwiceInOneTurn();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writerTool(ran)],
      stillWanted: async () => false,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("faz as duas coisas")] },
      { configurable: { thread_id: "called-off-batch" } },
    );
    expect(ran).toEqual([]);
    expect(
      result.messages
        .filter((m) => m.getType() === "tool")
        .map((m) => (m as unknown as { tool_call_id: string }).tool_call_id),
    ).toEqual(["c1", "c2"]);
    expect(model.rounds).toBe(1);
  });

  // THE SEAM CANNOT REFUSE BY THROWING, only break the thread. Measured against the real
  // checkpointer with a tools node that throws: the thread comes back `[human, ai(tool_calls=…)]`
  // with no ToolMessage — the exact broken sequence the refusal above exists to avoid. And a
  // throwing fence is not hypothetical: several of the ones the runtime hands down read a job row.
  test("a fence that cannot answer lets the tools run", async () => {
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writerTool(ran)],
      stillWanted: async () => {
        throw new Error("database is unreachable");
      },
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("marca como qualificado")] },
      { configurable: { thread_id: "unreadable-fence" } },
    );
    expect(ran).toEqual(["sim"]);
    expect(model.rounds).toBe(2);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("pronto");
  });

  // The control, and it is the one that says the refusal is not simply "tools are off": the same
  // graph with the same fence answering the other way runs the tool and finishes the turn.
  test("a turn that is still wanted runs its tools", async () => {
    const ran: string[] = [];
    const model = new CallsThenAnswers();
    const graph = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: model as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writerTool(ran)],
      stillWanted: async () => true,
    });
    const result = await graph.invoke(
      { messages: [new HumanMessage("marca como qualificado")] },
      { configurable: { thread_id: "still-wanted" } },
    );
    expect(ran).toEqual(["sim"]);
    expect(String(result.messages.at(-1)?.content ?? "")).toBe("pronto");
  });

  // WHAT IT COSTS, counted rather than estimated: one read per TOOL-CALLING hop, and none at all on
  // a turn that calls nothing. The issue named the cost as a reason this needed a design, on a path
  // that already pays for the fence #428 added.
  test("the fence is asked once per tool-calling hop, and never on a turn without one", async () => {
    const ran: string[] = [];
    let asked = 0;
    const answers = new CallsThenAnswers();
    const withTool = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: answers as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writerTool(ran)],
      stillWanted: async () => {
        asked += 1;
        return true;
      },
    });
    await withTool.invoke(
      { messages: [new HumanMessage("marca")] },
      { configurable: { thread_id: "cost-one-hop" } },
    );
    expect(asked).toBe(1);

    asked = 0;
    const silent = new RecordingModel();
    const noTool = buildAgentGraph({
      primary: { provider: "openai", model: "test-model" },
      model: silent as unknown as BaseChatModel,
      systemPrompt: "PROMPT",
      checkpointer: new MemorySaver(),
      tools: [writerTool(ran)],
      stillWanted: async () => {
        asked += 1;
        return true;
      },
    });
    await noTool.invoke(
      { messages: [new HumanMessage("oi")] },
      { configurable: { thread_id: "cost-no-hop" } },
    );
    expect(asked).toBe(0);
  });
});

// LANGGRAPH COUNTS SUPER-STEPS, NOT TOOL CALLS. One round of "the model calls a tool, the tool node
// runs it" is two steps, so its default 25 runs out at about twelve rounds — and `maxToolCalls` is
// an operator setting that goes to 50. A budget the graph cannot reach is a turn that dies with
// `GraphRecursionError` after the tools it already ran have had their side effects, instead of
// ending at the budget with a text answer.
describe("the recursion limit tracks the tool budget", () => {
  test("a budget of 20 gets the steps 20 rounds take", () => {
    // 2 per round, +1 for the answer the model gives after the last one, +3 of graph overhead.
    expect(recursionLimitFor(20)).toBe(44);
  });

  test("it never goes below LangGraph's own default", () => {
    // A small budget keeps the room it has today: this raises ceilings, it never lowers one.
    expect(recursionLimitFor(1)).toBe(25);
    expect(recursionLimitFor(10)).toBe(25);
  });

  test("no budget means the default budget, not an unbounded graph", () => {
    expect(recursionLimitFor(undefined)).toBe(recursionLimitFor(10));
  });
});
