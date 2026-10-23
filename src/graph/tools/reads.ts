import { UTILITY_NATIVE_TOOL_NAMES } from "./catalog";
import { isEffectFreeTool } from "./effect-free";

// Whether the model has to SEE this tool's result before the turn can end, carried by the tool
// OBJECT the way the effect-free mark is (./effect-free.ts), so it rides the prototype through the
// guarded and fenced wrappers. An observation ends after a step of writes alone (graph.ts), since the
// closing model call would only write text the muted client drops; a read keeps that call, because
// its result is what the next step acts on. A separate question from the effect-free mark, which says
// whether a repeat costs anything: an HTTP GET is a read here and an effect for the tick's retry.
export const READ_TOOL = Symbol.for("fazerai.tool.read");

export function markRead<T extends object>(t: T): T {
  (t as unknown as Record<symbol, boolean>)[READ_TOOL] = true;
  return t;
}

// A read is a tool marked so (an HTTP GET, an MCP tool, an integration's), an effect-free one
// (`search_knowledge`, the code tools) or a utility native (its name is reserved). Everything else is
// a write: the native actions, `skip_reply`, `handoff_to_human`, an HTTP tool with any other method.
const UTILITY_NAMES: ReadonlySet<string> = new Set(UTILITY_NATIVE_TOOL_NAMES);

export function isReadTool(t: { name: string }): boolean {
  return (
    (t as unknown as Record<symbol, unknown>)[READ_TOOL] === true ||
    isEffectFreeTool(t) ||
    UTILITY_NAMES.has(t.name)
  );
}
