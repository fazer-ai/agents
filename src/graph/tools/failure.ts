import { ToolMessage } from "@langchain/core/messages";
import {
  type StructuredToolInterface,
  type ToolRunnableConfig,
  tool,
} from "@langchain/core/tools";
import type { z } from "zod";

// Marks a friendly tool reply as an INTEGRATION FAILURE: the model still sees the exact same string
// (graceful degradation), but the flow log records the call as warn/error so alert channels can fire
// on it. Business-level replies ("no free slots", policy limits, bad model input) must NOT use this:
// they are normal operation, not failures.
export class ToolFailure {
  constructor(readonly message: string) {}
}

export function toolFailure(message: string): ToolFailure {
  return new ToolFailure(message);
}

type FailableFn = (
  // NOTE: `never` keeps the wrapper assignable from any concretely-typed tool fn (parameter
  // contravariance); each call site keeps its own inline input type, exactly as with tool().
  input: never,
  config: ToolRunnableConfig,
) => Promise<string | ToolFailure>;

// tool() wrapper whose fn may return toolFailure(...): the failure reaches the model as a ToolMessage
// with status "error" and the SAME string as content. LangChain's direct-tool-output passthrough
// hands that ToolMessage intact to handleToolEnd (ToolFlowLogger logs warn/error) and to ToolNode.
// Without a tool_call in scope (direct invocation, unit tests) it degrades to the plain string,
// since a ToolMessage requires a real tool_call_id. Anthropic and OpenAI-family adapters ignore
// ToolMessage.status and google-genai wraps it as an error detail with the string preserved; if an
// adapter starts emitting is_error, re-check this model-facing contract.
export function failableTool(
  fn: FailableFn,
  fields: { name: string; description: string; schema: z.ZodTypeAny },
): StructuredToolInterface {
  return tool(async (input: unknown, config: ToolRunnableConfig) => {
    const out = await fn(input as never, config);
    if (!(out instanceof ToolFailure)) return out;
    const id = config?.toolCall?.id;
    if (!id) return out.message;
    return new ToolMessage({
      status: "error",
      content: out.message,
      tool_call_id: id,
      name: fields.name,
    });
  }, fields) as unknown as StructuredToolInterface;
}
