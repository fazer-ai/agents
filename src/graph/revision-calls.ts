import {
  AIMessage,
  type BaseMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { MessagesAnnotation } from "@langchain/langgraph";
import { contentToText } from "./message-text";
import { isReadOnlyTool } from "./tools/reads";

// The factual-grounding rewrite that may consult the check's sources (docs/factual-grounding.md). The
// model is bound to those tools alone, and the tool node runs only the calls the agent node admitted,
// so a name the model writes anyway (a transfer, a label, a tool it saw earlier in the thread) is
// answered with a refusal and never executes. Binding is what the model is offered; this is what runs.

// What the rewrite did, for the second review's line.
export interface RevisionInfo {
  // Calls that ran, and their names in order.
  toolCalls: number;
  tools: string[];
  // Calls asked for and not run: outside the sources, not a read, or past the cap.
  refused: string[];
  // The rewrite's own generations, summed over its rounds.
  inputTokens: number;
  outputTokens: number;
}

export const REVISION_REFUSED_RESULT =
  "[Sistema] Esta ferramenta não está disponível na reescrita: só as ferramentas de consulta indicadas podem ser chamadas, até o limite. Escreva a resposta ao cliente com o que já tem.";

// Appended to the reviewer's note when the rewrite has sources to call, naming them and the cap.
export function revisionToolsNote(
  names: readonly string[],
  max: number,
): string {
  return `Antes de reescrever, você pode consultar ${names.map((n) => `\`${n}\``).join(", ")} (no máximo ${max} ${max === 1 ? "chamada" : "chamadas"}) para confirmar ou corrigir essas afirmações. Só essas ferramentas estão disponíveis agora.`;
}

// The sources the rewrite may call: granted to the agent, named as a source, read-only (an MCP or
// integration tool counts as a read for an observation and may still send or charge), and run on the
// server (a client tool suspends the turn, and the rewrite would not survive the resume).
export function revisionTools(
  tools: readonly StructuredToolInterface[],
  sourceTools: readonly string[],
  clientNames: ReadonlySet<string>,
): StructuredToolInterface[] {
  const sources = new Set(sourceTools);
  return tools.filter(
    (t) => sources.has(t.name) && isReadOnlyTool(t) && !clientNames.has(t.name),
  );
}

// The call ids of a rewrite's batch that may run: the first `room` calls, those naming a source. The
// tool node runs by id, so an id two calls share admits neither: admitting it would run the other
// call too, whatever its name or position.
export function admitRevisionCalls(
  calls: readonly { name: string; id?: string }[],
  sources: ReadonlySet<string>,
  room: number,
): Set<string> {
  const seen = new Map<string, number>();
  for (const c of calls)
    if (typeof c.id === "string") seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  return new Set(
    calls
      .filter((_, i) => i < room)
      .filter(
        (c): c is { name: string; id: string } =>
          typeof c.id === "string" &&
          seen.get(c.id) === 1 &&
          sources.has(c.name),
      )
      .map((c) => c.id),
  );
}

// The batch as the tool node should run it: only the admitted call ids, with a refusal for the rest.
// `view` is null when nothing is left to run.
export function setAsideRevisionCalls(
  state: typeof MessagesAnnotation.State,
  admitted: ReadonlySet<string>,
): {
  view: typeof MessagesAnnotation.State | null;
  answers: ToolMessage[];
  ran: string[];
  refused: string[];
} {
  const last = state.messages.at(-1);
  if (last?.getType() !== "ai")
    return { view: state, answers: [], ran: [], refused: [] };
  const ai = last as AIMessage;
  const calls = ai.tool_calls ?? [];
  const run = calls.filter(
    (c) => typeof c.id === "string" && admitted.has(c.id),
  );
  const out = calls.filter((c) => !run.includes(c));
  const answers = out.map(
    (c) =>
      new ToolMessage({
        content: REVISION_REFUSED_RESULT,
        tool_call_id: c.id ?? "",
        name: c.name,
        status: "error",
      }),
  );
  const names = {
    ran: run.map((c) => c.name),
    refused: out.map((c) => c.name),
  };
  if (out.length === 0) return { view: state, answers, ...names };
  if (run.length === 0) return { view: null, answers, ...names };
  const view = new AIMessage({
    content: ai.content,
    id: ai.id,
    tool_calls: run,
  });
  return {
    view: {
      ...state,
      messages: [...state.messages.filter((m) => m !== last), view],
    },
    answers,
    ...names,
  };
}

// A rewrite's answer with no round left to run calls: the text it wrote, and the calls dropped.
export function textOnly(m: BaseMessage): AIMessage {
  const ai = m as AIMessage;
  return new AIMessage({
    content: contentToText(ai.content),
    ...(typeof ai.id === "string" ? { id: ai.id } : {}),
    ...(ai.usage_metadata ? { usage_metadata: ai.usage_metadata } : {}),
  });
}
