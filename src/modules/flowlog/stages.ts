// Closed vocabulary for the execution-flow log, kept dependency-free so the schema layer and the
// read/controller layers can validate without importing the emit machinery.

// One stage per step the operator can be asked to explain. Most are pipeline steps a turn runs
// through; `route` and `command` sit BEFORE the turn (#318, #317) and `webhook` is not a turn at all
// (#325), which is why the vocabulary is the operator's question and not the pipeline's shape.
// Stored as a validated String on ExecutionLog (never a Prisma enum — adding a stage must not
// require a migration).
export const FLOW_STAGES = [
  // The step BEFORE any of the others: the delivery is matched to the agent that answers this
  // inbox. It writes only when there is none — an inbox nobody bound consumes the message and
  // answers nothing, and until issue #318 the only trace was a process log line.
  "route",
  // A control command (`/teste`, `/reset`) the delivery did NOT run. Also before the turn, and for
  // the same reason as `route`: past the gate the command is gone and every later line describes a
  // plain message, so the console had nothing to show for it (issue #317).
  "command",
  "stt", // inbound voice-note transcription
  "vision", // inbound image/document extraction
  "embed", // RAG embedding (search / ingest)
  "delivery", // an inbound delivery a process death interrupted: lost, or answered late
  "debounce", // inbound burst coalesced before a turn (one line per flush)
  "contact_auth", // external contact-authorization gate (allowed/denied/error before the turn)
  "generate", // the LLM turn (graph.invoke)
  "guardrail", // input/output moderation trip (a guardrails check fired)
  "tool", // a tool call the agent made during the turn (name + status + duration)
  "normalize", // the reply rewritten for speech before synthesis (its own model call)
  "tts", // audio-reply synthesis
  "split", // humanized balloon delivery
  "handoff", // an ownership gate closed: a takeover, or the conversation left the bot
  "memory", // a closed attendance folded into the contact's memory (compaction)
  // NOT a turn step, and the only stage here that is not: an outbound webhook delivery the bus gave
  // up on. It happens on a worker tick long after whatever produced the event, so it hangs off no
  // conversation and no contact. It is in this vocabulary because the vocabulary is what an alert
  // channel subscribes to and what the Logs page filters by, and a dropped event that reaches
  // neither is a loss nobody is told about (issue #325).
  "webhook",
  // NOT a turn step either, and the widest of the three: a unit of work that reached a TERMINAL
  // failure state — a scheduled job past its budget, an alert the bus gave up on, an inbound event
  // that will never be processed, a document that will never be indexed. One stage rather than one
  // per bus because it is one question ("what did the system give up on?"), which is what an
  // operator subscribes a channel to; `detail.unit` says which bus inside it (issue #356).
  "dead_letter",
] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

export function isFlowStage(s: string): s is FlowStage {
  return (FLOW_STAGES as readonly string[]).includes(s);
}

// The buses that can reach a terminal failure. Closed, because the `dead_letter` line is only
// legible if `unit` comes from a vocabulary and not from whatever each call site felt like writing —
// and because ALERT_DELIVERY is compared against by name in ./alerts.ts, where a typo would silently
// reopen the loop it exists to prevent.
// Named apart from the list because ./alerts.ts compares against it to break the loop, and a second
// spelling of the same string is exactly how that comparison would go quietly false.
export const ALERT_DELIVERY_UNIT = "alert_delivery";

export const DEAD_UNITS = [
  // A scheduler job past its retry budget, by either road (failJob's cap, or the reaper).
  "job",
  // A notification the alert bus itself gave up on. The one unit that can never be alerted about.
  ALERT_DELIVERY_UNIT,
  // An authenticated inbound event the receptor cannot process, or that exhausted its processing
  // attempts.
  "inbound_delivery",
  // A knowledge document whose indexing failed; the row stays FAILED and no retry is coming.
  "knowledge_document",
] as const;
export type DeadUnit = (typeof DEAD_UNITS)[number];

export const FLOW_LEVELS = ["info", "warn", "error"] as const;
export type FlowLevel = (typeof FLOW_LEVELS)[number];

export function isFlowLevel(s: string): s is FlowLevel {
  return (FLOW_LEVELS as readonly string[]).includes(s);
}

export type FlowStatus = "ok" | "error" | "skipped";

// The two worlds an alert has to tell apart, and the split is real-vs-test, never turn-vs-not:
// inbox = production, including the system work that serves it (a `webhook` line has no turn and
// still pages); playground = operator test turns, which never alert.
export type FlowSource = "inbox" | "playground";
