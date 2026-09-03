// The agent's operating mode, and the two questions every reader of it asks.
//
// `test` answers only in a conversation the customer activated with /teste; `production` answers
// normally; `monitoring` never answers at all (issue #209). Monitoring is not `enabled: false`: a
// disabled agent is not asked anything, while a monitoring agent stays bound, receives every event,
// analyzes media and folds every message into its memory — it only never produces a customer-facing
// output. No reply, no typing, no follow-up, no template, no away message, and /teste never
// activates it.
export const AGENT_MODES = ["test", "production", "monitoring"] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

// The column is a plain string, and a value this build does not know reads as production, as it
// always has. `monitoring` is named here BEFORE that fallback on purpose: read through the old
// `=== "test" ? "test" : "production"` ternary, a monitoring agent came back as a fully answering
// one — the worst failure the mode can have, and the reason this is one function rather than a
// ternary per reader.
export function normalizeAgentMode(raw: string | null | undefined): AgentMode {
  return raw === "test" || raw === "monitoring" ? raw : "production";
}

// Whether the agent is forbidden from ever speaking to the customer. Asked at the ONE seam every
// speaking caller passes through (`loadAgentConfig`), at the receiver before a turn is armed, and by
// the two sends that do not load a config (the generic and the redirect follow-ups).
export function isMonitoring(mode: string): boolean {
  return mode === "monitoring";
}

// Whether the receiver keeps the agent's picture of the conversation current on messages no turn
// handles: media analyzed before any gate, and every unanswered message folded into memory.
// Production has always done this; monitoring exists to do it and nothing else. A test agent keeps
// its cost fence (nothing until /teste). `enabled` is read beside this predicate, never inside it.
export function ingestsContinuously(mode: string): boolean {
  return mode === "production" || mode === "monitoring";
}
