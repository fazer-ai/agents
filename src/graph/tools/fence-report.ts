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

// Two more facts only the handler knows, on the same channel: the call returned without writing
// anything (a scope the conversation does not have), or it wrote something that stays even though
// the call then threw (a handoff's note filed before its status change failed).
export type CallReport = FenceReport | { noEffect: true } | { committed: true };

export type FenceReporter = (report: CallReport) => void;

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
  return typeof r === "function" ? (r as FenceReporter) : undefined;
}
