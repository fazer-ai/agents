import {
  AIMessage,
  type BaseMessage,
  type ToolMessage,
} from "@langchain/core/messages";

// The ids a provider would replay for an assistant message: the LangChain calls, the Chat
// Completions copy in `additional_kwargs.tool_calls`, the Responses API items in
// `response_metadata.output`, which `@langchain/openai` replays VERBATIM when present, and the
// `tool_use` blocks Anthropic keeps in `content`.
export function replayedCallIds(m: AIMessage): string[] {
  const ids = new Set<string>();
  for (const c of m.tool_calls ?? []) if (c.id) ids.add(c.id);
  const kw = (m.additional_kwargs?.tool_calls ?? []) as { id?: string }[];
  for (const c of kw) if (c.id) ids.add(c.id);
  const output = (m.response_metadata?.output ?? []) as {
    type?: string;
    call_id?: string;
  }[];
  for (const item of output)
    if (item?.type === "function_call" && item.call_id) ids.add(item.call_id);
  if (Array.isArray(m.content)) {
    for (const b of m.content as { type?: string; id?: string }[])
      if (b?.type === "tool_use" && b.id) ids.add(b.id);
  }
  return [...ids];
}

// Refuses a history the way OpenAI does: every call an assistant message replays needs its output
// among the tool messages right after it, and a reasoning item cannot be the last item replayed,
// whether it comes from `response_metadata.output` or, without one, from `additional_kwargs.reasoning`
// on a message with nothing else to send.
export class StrictProvider {
  seen: BaseMessage[][] = [];
  constructor(private reply = "ok") {}
  async invoke(messages: BaseMessage[]): Promise<AIMessage> {
    this.seen.push(messages);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m?.getType() !== "ai") continue;
      const ai = m as AIMessage;
      const answered = new Set<string>();
      for (let j = i + 1; j < messages.length; j++) {
        const t = messages[j];
        if (t?.getType() !== "tool") break;
        answered.add((t as ToolMessage).tool_call_id);
      }
      for (const id of replayedCallIds(ai)) {
        if (!answered.has(id))
          throw new Error(`400 No tool output found for function call ${id}.`);
      }
      const output = (ai.response_metadata?.output ?? []) as {
        type?: string;
      }[];
      const loneReasoning =
        output.length === 0 &&
        ai.additional_kwargs?.reasoning !== undefined &&
        (ai.tool_calls?.length ?? 0) === 0 &&
        !(typeof ai.content === "string" ? ai.content : "").trim();
      if (
        (output.length > 0 && output.at(-1)?.type === "reasoning") ||
        loneReasoning
      )
        throw new Error(
          "400 Item of type 'reasoning' was provided without its required following item.",
        );
    }
    return new AIMessage(this.reply);
  }
  bindTools(_tools: unknown) {
    return this;
  }
}

// An assistant message the way the Responses API leaves it in the checkpoint: the reasoning item,
// then one function_call per call, mirrored in `tool_calls`.
export function assistantCalling(
  id: string,
  callIds: string[],
  text = "",
): AIMessage {
  return new AIMessage({
    id,
    content: text,
    tool_calls: callIds.map((c) => ({
      id: c,
      name: "consultar_evento",
      args: { termo: c },
      type: "tool_call" as const,
    })),
    additional_kwargs: {
      tool_calls: callIds.map((c) => ({
        id: c,
        type: "function",
        function: { name: "consultar_evento", arguments: `{"termo":"${c}"}` },
      })),
    },
    response_metadata: {
      output: [
        { type: "reasoning", id: `rs_${id}`, summary: [] },
        ...(text
          ? [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text }],
              },
            ]
          : []),
        ...callIds.map((c) => ({
          type: "function_call",
          call_id: c,
          name: "consultar_evento",
          arguments: `{"termo":"${c}"}`,
        })),
      ],
    },
  });
}

export function orphansIn(messages: BaseMessage[]): string[] {
  const out: string[] = [];
  messages.forEach((m, i) => {
    if (m.getType() !== "ai") return;
    const answered = new Set<string>();
    for (let j = i + 1; j < messages.length; j++) {
      const t = messages[j];
      if (t?.getType() !== "tool") break;
      answered.add((t as ToolMessage).tool_call_id);
    }
    for (const id of replayedCallIds(m as AIMessage))
      if (!answered.has(id)) out.push(id);
  });
  return out;
}
