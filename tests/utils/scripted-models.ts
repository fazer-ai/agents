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
