import type { BindToolsInput } from "@langchain/core/language_models/chat_models";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type BaseMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";

// A provider that answers 200 with no completion on its first N calls and then works. Extends the
// REAL BaseChatModel on purpose: the failure of issue #63 is not an error the provider returns, it
// is a TypeError LangChain raises afterwards reading `generations[0][0].message`, so a hand-built
// error would prove nothing about whether the retry predicate matches production.
export class EmptyThenReplyModel extends BaseChatModel {
  calls = 0;
  constructor(
    private readonly reply: string,
    private readonly emptyCount = 1,
  ) {
    super({});
  }
  _llmType() {
    return "fake-empty";
  }
  async _generate(): Promise<ChatResult> {
    this.calls += 1;
    if (this.calls <= this.emptyCount) return { generations: [] };
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

// A provider that always fails the same way. The error is handed in rather than built here, because
// what the fallback policy reads off it (the numeric `status`, the class name) is the whole subject
// of the test — a model that invented its own error would be testing the fixture.
export class FailingModel extends BaseChatModel {
  calls = 0;
  constructor(private readonly error: unknown) {
    super({});
  }
  _llmType() {
    return "fake-failing";
  }
  // The graph binds tools before invoking; returning `this` keeps the bound and bare paths on the
  // same counter, so "the primary was actually asked" is provable.
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    this.calls += 1;
    throw this.error;
  }
}

// Records the toolset it was BOUND to, which is the only way to see the difference between a model
// asked the agent's question and one asked a stripped version of it. A reply arrives either way.
export class ToolRecordingModel extends BaseChatModel {
  boundToolNames: string[] | null = null;
  constructor(private readonly reply: string) {
    super({});
  }
  _llmType() {
    return "fake-tool-recording";
  }
  override bindTools(tools: BindToolsInput[]) {
    this.boundToolNames = tools.map((t) =>
      typeof t === "object" && t !== null && "name" in t
        ? String((t as { name: unknown }).name)
        : "?",
    );
    return this;
  }
  async _generate(): Promise<ChatResult> {
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

// Runs a side effect INSIDE the generate call, then answers. The point is the window: a fence that
// only exists before the model and after it cannot be told apart from a correct one unless something
// happens while the model is running, and the model call is the widest wait on the turn.
export class SideEffectModel extends BaseChatModel {
  constructor(
    private readonly during: () => Promise<void>,
    private readonly reply = "olá!",
  ) {
    super({});
  }
  _llmType() {
    return "fake-side-effect";
  }
  async _generate(): Promise<ChatResult> {
    await this.during();
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

// Answers from a queue and REPORTS token usage on every call. Reporting is the point: UsageCapture
// drops a call whose counts are all zero, so a model that reports nothing looks exactly like a call
// that never happened, and a test for "this call is billed" would pass with the billing broken.
// One queue, consumed in call order, is what lets a turn tell its own generation apart from a
// secondary call that runs after it (the speech normalizer).
export class UsageReportingModel extends BaseChatModel {
  calls: string[] = [];
  private i = 0;
  constructor(
    private readonly responses: string[],
    private readonly tokens = { input: 11, output: 7 },
  ) {
    super({});
  }
  _llmType() {
    return "fake-usage";
  }
  // The graph binds tools before invoking; the normalizer invokes the bare model. Returning `this`
  // keeps both paths on the same queue.
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const last = messages[messages.length - 1];
    this.calls.push(typeof last?.content === "string" ? last.content : "");
    const text = this.responses[Math.min(this.i, this.responses.length - 1)];
    this.i += 1;
    return {
      generations: [
        {
          text: text ?? "",
          message: new AIMessage({
            content: text ?? "",
            usage_metadata: {
              input_tokens: this.tokens.input,
              output_tokens: this.tokens.output,
              total_tokens: this.tokens.input + this.tokens.output,
            },
          }),
        },
      ],
    };
  }
}

// Records the system prompt it is handed, then answers. The prompt is what several features
// ASSEMBLE (context blocks appended after the operator's own text), and the only place their result
// is observable is the message the model actually receives: asserting on the builder's output
// instead would pass with the block built and never wired to a turn.
export class PromptCapturingModel extends BaseChatModel {
  systemPrompts: string[] = [];
  constructor(private readonly reply: string) {
    super({});
  }
  _llmType() {
    return "fake-prompt-capture";
  }
  // The graph binds tools before invoking; without this the bound copy is a different object and
  // the turn's own call would be recorded nowhere.
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const system = messages.find((m) => m.getType() === "system");
    this.systemPrompts.push(
      typeof system?.content === "string" ? system.content : "",
    );
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

// A model that calls resolve_conversation once and then answers (possibly with empty text) —
// the "resolve + final reply in the same turn" shape seen in production. The raw invoke covers
// the hard-limit path. Shared by the runtime and debounce suites so the deferred-resolve
// contract is exercised against a single definition.
export class ResolveThenReplyModel {
  constructor(private reply: string) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                { name: "resolve_conversation", args: {}, id: "call_resolve" },
              ],
            })
          : new AIMessage(self.reply);
      },
    };
  }
}

// Calls handoff_to_human with a customer-facing closing line, then also returns a final reply.
// Reproduces the double-send when the handoff's mirror event lands after generation.
export class HandoffThenReplyModel {
  constructor(
    private reply: string,
    private customerMessage: string,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "handoff_to_human",
                  args: { customerMessage: self.customerMessage },
                  id: "call_handoff",
                },
              ],
            })
          : new AIMessage(self.reply);
      },
    };
  }
}

// Hands off successfully and then blows up on the next step. The transfer is done, the closing line
// is recorded, and the exception leaves through the graph — the shape where the promise has nobody
// left to deliver it unless the caller delivers on its failure path too.
export class HandoffThenThrowModel {
  constructor(private customerMessage: string) {}
  async invoke(): Promise<AIMessage> {
    throw new Error("model blew up");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        if (n === 1)
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "handoff_to_human",
                args: { customerMessage: self.customerMessage },
                id: "call_handoff",
              },
            ],
          });
        throw new Error("model blew up");
      },
    };
  }
}

// Hands off twice: the first attempt carries a closing line and fails inside the tool, the second
// carries none and succeeds, and the model then writes its own recovery text. The shape that tells a
// line bound to the transfer that HAPPENED apart from one recorded by an attempt that did not.
export class HandoffRetryModel {
  constructor(
    private firstMessage: string,
    private recovery: string,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.recovery);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        if (n === 1)
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "handoff_to_human",
                args: { customerMessage: self.firstMessage },
                id: "call_handoff_1",
              },
            ],
          });
        if (n === 2)
          return new AIMessage({
            content: "",
            tool_calls: [
              { name: "handoff_to_human", args: {}, id: "call_handoff_2" },
            ],
          });
        return new AIMessage(self.recovery);
      },
    };
  }
}

// Sets the customer's voice preference and only then hands off, both in the same turn. The pair that
// tells a closing line read from the pre-turn snapshot apart from one read at delivery time: the
// preference the customer just stated is in the database, and nowhere else yet.
export class SetVoiceThenHandoffModel {
  constructor(
    private preference: "audio" | "text" | "default",
    private customerMessage: string,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        if (n === 1)
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "set_voice_preference",
                args: { preference: self.preference },
                id: "call_voice",
              },
            ],
          });
        if (n === 2)
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "handoff_to_human",
                args: { customerMessage: self.customerMessage },
                id: "call_handoff",
              },
            ],
          });
        return new AIMessage("");
      },
    };
  }
}

// Calls send_image once (a product photo the agent already has the URL for), then answers with text.
// Mirrors ResolveThenReplyModel: the point is the ORDER of what reaches Chatwoot, not the content.
export class SendImageThenReplyModel {
  constructor(
    private reply: string,
    private url: string,
    private caption?: string,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "send_image",
                  args: { url: self.url, caption: self.caption },
                  id: "call_send_image",
                },
              ],
            })
          : new AIMessage(self.reply);
      },
    };
  }
}

// Queues an image and only then hands off. The image is not a duplicate of the handoff's closing
// line, so it still belongs to the customer: this is the shape that tells a suppressed duplicate
// apart from a dropped attachment.
export class SendImageThenHandoffModel {
  constructor(
    private url: string,
    private customerMessage: string,
    private caption?: string,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        if (n === 1)
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "send_image",
                args: { url: self.url, caption: self.caption },
                id: "call_send_image",
              },
            ],
          });
        if (n === 2)
          return new AIMessage({
            content: "",
            tool_calls: [
              {
                name: "handoff_to_human",
                args: { customerMessage: self.customerMessage },
                id: "call_handoff",
              },
            ],
          });
        return new AIMessage("");
      },
    };
  }
}

// Sends an image and then ends the turn with NO final text — the skip_reply shape, where the caption
// is the only thing the customer reads.
export class SendImageOnlyModel extends SendImageThenReplyModel {
  constructor(url: string, caption?: string) {
    super("", url, caption);
  }
}

// Several images in ONE response, which is how a model answers "show me the three colours". LangGraph
// runs the batch with Promise.all, so what the customer receives is only in the model's order if
// something remembers that order.
export class SendImageBatchModel {
  constructor(
    private reply: string,
    private images: { url: string; caption?: string }[],
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: self.images.map((img, i) => ({
                name: "send_image",
                args: { url: img.url, caption: img.caption },
                id: `call_send_image_${i}`,
                type: "tool_call" as const,
              })),
            })
          : new AIMessage(self.reply);
      },
    };
  }
}

// The picture IS the answer, and the agent closes the conversation in the same breath: both calls in
// one response, no final text. The pair the turn has to get right when the delivery fails.
export class SendImageAndResolveModel {
  constructor(private url: string) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage("");
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: "send_image",
                  args: { url: self.url },
                  id: "call_send_image",
                },
                { name: "resolve_conversation", args: {}, id: "call_resolve" },
              ],
            })
          : new AIMessage("");
      },
    };
  }
}

// A guardrail model double that answers BOTH call shapes, because which one goes out is decided by
// the PROVIDER and not by the test (`acceptsConstrainedOutput`, issue #131). `withStructuredOutput`
// reuses the same `invoke`, so a double that throws keeps throwing and one that records keeps
// recording, and a reply that is not json arrives with no parsed answer — the same thing the
// Anthropic adapter does with a model that answers in text instead of calling the forced tool.
export const guardrailModel = (
  invoke: (msgs: { content: unknown }[]) => Promise<{ content: string }>,
): BaseChatModel =>
  ({
    invoke,
    withStructuredOutput: () => ({
      invoke: async (msgs: { content: unknown }[]) => {
        const raw = await invoke(msgs);
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(raw.content);
        } catch {
          parsed = null;
        }
        return { raw, parsed };
      },
    }),
  }) as unknown as BaseChatModel;

// Issues a document, then answers. The reply does not repeat the prices, which is what the tool's
// own description asks for — so the assertion is about ORDER: the customer receives the PDF and then
// the sentence about it, never the other way round.
export class SendDocumentThenReplyModel {
  constructor(
    private reply: string,
    private toolName: string,
    private args: Record<string, unknown>,
    // Runs between the tool call and the final message — the window in which a document has been
    // issued and queued but not yet delivered. Lets a test act inside it.
    private betweenTurns?: () => Promise<void>,
  ) {}
  async invoke(): Promise<AIMessage> {
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    const self = this;
    let n = 0;
    return {
      async invoke(): Promise<AIMessage> {
        n++;
        if (n === 2) await self.betweenTurns?.();
        return n === 1
          ? new AIMessage({
              content: "",
              tool_calls: [
                {
                  name: self.toolName,
                  args: self.args,
                  id: "call_send_document",
                },
              ],
            })
          : new AIMessage(self.reply);
      },
    };
  }
}

// Asks for the same tool N times, then answers. The point is the tool LOOP: `toolsCondition` routes
// a tool call back through the agent node, so a model that calls a tool twice makes that node run
// three times, which is the only way to observe what the node does on a round that is not the first.
export class ToolLoopModel extends BaseChatModel {
  calls = 0;
  constructor(
    private readonly toolName: string,
    private readonly rounds: number,
    private readonly reply = "pronto",
  ) {
    super({});
  }
  _llmType() {
    return "fake-tool-loop";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    this.calls += 1;
    if (this.calls <= this.rounds) {
      const message = new AIMessage({
        content: "",
        tool_calls: [
          { name: this.toolName, args: {}, id: `call-${this.calls}` },
        ],
      });
      return { generations: [{ text: "", message }] };
    }
    return {
      generations: [{ text: this.reply, message: new AIMessage(this.reply) }],
    };
  }
}

// A provider that always fails the same way, after a measurable wait. `FailingModel` fails
// instantly, which cannot separate "the primary was asked again" from "the turn cost nothing" — and
// the cost is the whole subject when the failure being modelled is a timeout.
export class SlowFailingModel extends BaseChatModel {
  calls = 0;
  constructor(
    private readonly error: unknown,
    private readonly delayMs: number,
  ) {
    super({});
  }
  _llmType() {
    return "fake-slow-failing";
  }
  override bindTools(_tools: BindToolsInput[]) {
    return this;
  }
  async _generate(): Promise<ChatResult> {
    this.calls += 1;
    await new Promise((r) => setTimeout(r, this.delayMs));
    throw this.error;
  }
}
