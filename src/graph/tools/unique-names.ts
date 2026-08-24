import type { StructuredToolInterface } from "@langchain/core/tools";

// One agent, one meaning per tool name.
//
// The toolset is assembled from independent sources — native tools, document templates, HTTP tool
// definitions, MCP servers, toolpacks, knowledge bases — and only some of them can be asked about
// when a name is written down. An MCP server names its own tools when it is contacted, and a
// toolpack's names come from the pack, so "is this name still free?" is a question no authoring-time
// check can finish answering. The assembly is the one place that sees every name at once, so it is
// where the answer is decided; the write-time checks that CAN run (a document slug against the
// built-ins) stay, because an error at the keyboard beats a surprise at the turn.
//
// What a duplicate costs if it survives to here: the model is handed two functions with one name.
// Providers differ on what they do with that — some reject the request outright, taking the agent
// silent — and LangGraph's ToolNode resolves a call by the first match, so the operator sees one
// tool's arguments arriving at the other tool's implementation.
//
// DROPPED rather than fatal: refusing to build the toolset would take a whole agent down over one
// name, while dropping leaves every other tool working and exactly one tool missing. The names that
// lost are returned rather than swallowed, so the caller can say so.
//
// EARLIER WINS, and the order the toolset is built in is the precedence. That order puts the native
// tools first, which is the half that matters: they are the ones the operator cannot rename.
export function dropDuplicateToolNames(tools: StructuredToolInterface[]): {
  tools: StructuredToolInterface[];
  dropped: string[];
} {
  const seen = new Set<string>();
  const kept: StructuredToolInterface[] = [];
  const dropped: string[] = [];
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      dropped.push(tool.name);
      continue;
    }
    seen.add(tool.name);
    kept.push(tool);
  }
  return { tools: kept, dropped };
}
