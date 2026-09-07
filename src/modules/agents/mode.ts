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

// The modes a WRITE may set, which today is not all of them. `monitoring` is held back from every
// offer until the work that gives it an output lands: an agent bound as an observer BESIDE the
// inbox's responder (#476), and the job that classifies the conversation and writes the verdict as
// labels (#477). Without those, `Inbox.agentId` is one column, so choosing this mode means the
// inbox is answered by nobody and reports nothing back, which is not a feature to put in front of
// an operator.
//
// HELD BACK AT THE OFFER AND NOWHERE ELSE, deliberately. Dropping the value from `AGENT_MODES`
// would be one line and would collapse a stored `monitoring` into `production` at the fallback
// below, which is the worst failure this module has: an agent an operator silenced would start
// answering customers on upgrade. Every reader keeps the full set; the write side reads this one.
//
// THE WRITE SIDE IS ELEVEN SITES, COUNTED, on four surfaces: the console's control, the REST
// schema on create and on patch, the service schema on each, and on MCP a schema plus a handler
// signature plus a call-site argument type for each of the two tools. It was written by hand in
// every one of them before this constant existed, which is why the count was wrong twice while
// this change was being made: what enumerates them is the compiler, since `SelectableAgentMode` is
// a distinct type and a site that widens back stops building.
//
// Putting it back is deleting this constant and letting those eleven fall back on `AGENT_MODES`;
// `tests/modules/agent-mode-offer.test.ts` goes red when the mode ships, and says so.
export const SELECTABLE_AGENT_MODES = ["test", "production"] as const;
export type SelectableAgentMode = (typeof SELECTABLE_AGENT_MODES)[number];

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
