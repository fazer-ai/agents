import type { ToolRunnableConfig } from "@langchain/core/tools";

// A fence inside a tool that refused what a call asked: a protected label `set_labels` will not
// touch, a label outside the agent's allowed list, a tool precondition that does not hold. To the
// model the refusal is an ordinary tool result (precondition.ts says why), so a caller that has to
// tell "ran" from "refused" (the decisions engine's log line, docs/decisions.md) cannot read it off
// the result. It asks for it per call instead: a reporter on the call's own config, which reaches
// the handler with that call and no other, even when two calls share one label write.
export type FenceName = "protected_label" | "allowed_labels" | "precondition";

export interface FenceReport {
  fence: FenceName;
  // Something else the same call asked for was written (a free label beside a protected one).
  partial: boolean;
}

// Three more facts only the handler knows, on the same channel: the call returned without writing
// anything (a scope the conversation does not have), it wrote something that stays even though the
// call then threw (a handoff's note filed before its status change failed), or the other side
// answered that it did not take the call, in a status the operator declared a result rather than a
// failure (a 409 for a taken slot), which says nothing about whether anything was written.
export type CallReport =
  | FenceReport
  | { noEffect: true }
  | { committed: true }
  | { declined: true };

// `callId` is the id of the call that reported, when its config carries one (`ToolNode` hands each
// tool its own call): what lets a listener of a whole batch tell which call it was.
export type FenceReporter = (report: CallReport, callId?: string) => void;

// True for a report that says the call did not do what it was asked: refused whole by a fence, a
// write that changed nothing, or an answer the other side declined. A partial fence and a write that
// stayed (`committed`) did something.
export function reportsNoEffect(report: CallReport): boolean {
  if ("noEffect" in report || "declined" in report) return true;
  return "fence" in report && !report.partial;
}

const KEY = "fazeraiFenceReporter";

export function withFenceReporter(
  config: ToolRunnableConfig,
  reporter: FenceReporter,
): ToolRunnableConfig {
  return {
    ...config,
    configurable: { ...(config.configurable ?? {}), [KEY]: reporter },
  };
}

export function fenceReporterOf(
  config: ToolRunnableConfig | undefined,
): FenceReporter | undefined {
  const r = config?.configurable?.[KEY];
  if (typeof r !== "function") return undefined;
  const own = config?.toolCall?.id;
  return (report, callId) => (r as FenceReporter)(report, callId ?? own);
}
