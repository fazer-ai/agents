import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
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
