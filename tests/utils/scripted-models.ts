import { AIMessage } from "@langchain/core/messages";

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
