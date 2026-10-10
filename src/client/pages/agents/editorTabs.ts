import type { MonitoringEngine } from "@/modules/observe/settings";

// The tabs a monitoring agent's editor draws, by engine (agents#1224). A watcher never speaks, so
// GUARDRAILS (screen a reply), the CHANNEL REDIRECT (messages on another channel) and the PLAYGROUND
// (a conversation with the agent) are never drawn. TOOLS stays on both engines: its grants, handoff
// target, label permissions and preconditions fence a rule's action exactly as they fence the
// model's call. KNOWLEDGE is the model's (the decisions engine searches no base), and QUESTIONS AND
// RULES is the decisions engine's. Nothing is deleted when a tab is not drawn: switch back and it
// returns as it was.
const LLM_WATCHER_TABS: ReadonlySet<string> = new Set([
  "general",
  "channels",
  "tools",
  "knowledge",
  "behavior",
]);
const DECISIONS_WATCHER_TABS: ReadonlySet<string> = new Set([
  "general",
  "channels",
  "decisions",
  "tools",
  "behavior",
]);

export function watcherTabKeys(engine: MonitoringEngine): ReadonlySet<string> {
  return engine === "decisions" ? DECISIONS_WATCHER_TABS : LLM_WATCHER_TABS;
}

// The sections only one engine draws: memory is compacted by a chat model, the backup provider
// stands in for one, and General's Model card configures it; the Classifier card is the decisions
// engine's. Asked of the engine AS EDITED, so a warning never links to a card the switch replaced.
const CHAT_MODEL_SECTIONS: ReadonlySet<string> = new Set([
  "memory",
  "modelFallback",
  "general-model",
]);
const DECISIONS_SECTIONS: ReadonlySet<string> = new Set(["general-classifier"]);

export function watcherSectionUsed(
  engine: MonitoringEngine,
  sectionId: string | undefined,
): boolean {
  if (sectionId === undefined) return true;
  return engine === "decisions"
    ? !CHAT_MODEL_SECTIONS.has(sectionId)
    : !DECISIONS_SECTIONS.has(sectionId);
}

// The warnings with no tab of their own that are about knowledge bases (a base to index, the
// embedding key): the decisions engine searches none.
const KNOWLEDGE_ISSUE_KEYS: ReadonlySet<string> = new Set([
  "knowledge",
  "embedding",
]);

export function watcherIssueUsed(
  engine: MonitoringEngine,
  key: string,
): boolean {
  return engine !== "decisions" || !KNOWLEDGE_ISSUE_KEYS.has(key);
}

// The anchor of a native tool's card on the Tools tab, so a link from elsewhere (a rule's "Open
// Tools") lands on that tool rather than on the top of the tab.
export function nativeToolAnchor(name: string): string {
  return `tools-native-${name}`;
}
