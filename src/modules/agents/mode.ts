// The agent's operating mode. `test` answers only where /teste activated it; `production` answers;
// `monitoring` stays bound, receives every event and folds messages into memory, but never produces
// customer-facing output (no reply, typing, follow-up, template or away message), unlike a disabled agent.
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
