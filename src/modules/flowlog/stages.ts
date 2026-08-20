// Closed vocabulary for the execution-flow log, kept dependency-free so the schema layer and the
// read/controller layers can validate without importing the emit machinery.

// One stage per pipeline step a turn can run through. Stored as a validated String on ExecutionLog
// (never a Prisma enum — adding a stage must not require a migration).
export const FLOW_STAGES = [
  "stt", // inbound voice-note transcription
  "vision", // inbound image/document extraction
  "embed", // RAG embedding (search / ingest)
  "debounce", // inbound burst coalesced before a turn (one line per flush)
  "generate", // the LLM turn (graph.invoke)
  "guardrail", // input/output moderation trip (a guardrails check fired)
  "tool", // a tool call the agent made during the turn (name + status + duration)
  "normalize", // the reply rewritten for speech before synthesis (its own model call)
  "tts", // audio-reply synthesis
  "split", // humanized balloon delivery
  "handoff", // human takeover detected before posting
  "memory", // a closed attendance folded into the contact's memory (compaction)
] as const;
export type FlowStage = (typeof FLOW_STAGES)[number];

export function isFlowStage(s: string): s is FlowStage {
  return (FLOW_STAGES as readonly string[]).includes(s);
}

export const FLOW_LEVELS = ["info", "warn", "error"] as const;
export type FlowLevel = (typeof FLOW_LEVELS)[number];

export function isFlowLevel(s: string): s is FlowLevel {
  return (FLOW_LEVELS as readonly string[]).includes(s);
}

export type FlowStatus = "ok" | "error" | "skipped";

// inbox = real customer traffic; playground = operator test turns (never alerts).
export type FlowSource = "inbox" | "playground";
