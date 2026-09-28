import type { StructuredToolInterface } from "@langchain/core/tools";
import type { FlowEvent } from "@/modules/flowlog/service";

// One agent, one meaning per tool name. Only the assembly sees every name at once (MCP and toolpack
// names are known only when built), and a duplicate that reached the model would be rejected by some
// providers or routed by ToolNode's first match to the wrong implementation. Duplicates are DROPPED,
// not fatal, so one name cannot take the agent down; EARLIER WINS, and natives come first. `reserved`
// holds native names even when the native is not built, because preconditions and the hand-back read
// a native's name as its identity (docs/graph.md, tool preconditions). Dropped names are returned so
// the caller can report them.
export function dropDuplicateToolNames(
  tools: StructuredToolInterface[],
  reserved: readonly string[] = [],
): {
  tools: StructuredToolInterface[];
  dropped: string[];
} {
  const seen = new Set<string>(reserved);
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

// The flow-log line for a tool that lost its name, so the operator sees the missing tool in the Logs
// page next to the turn. INFO, not warn: a duplicate stands until the operator renames something, so
// a warn would page the alert channels once per turn for as long as it lasts.
export function droppedToolNamesEvent(dropped: string[]): FlowEvent {
  return {
    stage: "tool",
    level: "info",
    status: "ok",
    detail: { phase: "duplicate_name_dropped", tools: [...new Set(dropped)] },
  };
}
