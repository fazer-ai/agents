// Closed vocabulary for the execution-flow log, kept dependency-free so the schema layer and the
// read/controller layers can validate without importing the emit machinery.

// One stage per step the operator can be asked to explain. `route` and `command` sit BEFORE the
// turn and `webhook` is not a turn at all, which is why the vocabulary follows the operator's
// question and not the pipeline. Stored as a validated String on ExecutionLog, never a Prisma enum,
// so adding a stage needs no migration.
export const FLOW_STAGES = [
  // The step BEFORE any of the others: the delivery is matched to the agent that answers this
  // inbox. It writes only when there is none, since an inbox nobody bound consumes the message and
  // answers nothing.
  "route",
  // A control command (`/teste`, `/reset`) the delivery did NOT run. Also before the turn: past the
  // gate the command reads as a plain message, so no later line would show it.
  "command",
  "stt", // inbound voice-note transcription
  "vision", // inbound image/document extraction
  "embed", // RAG embedding (search / ingest)
  "delivery", // an inbound delivery a process death interrupted: lost, or answered late
  "debounce", // inbound burst coalesced before a turn (one line per flush)
  "contact_auth", // external contact-authorization gate (allowed/denied/error before the turn)
  // The per-tenant token ceiling refusing a turn, or warning that it is about to. Before the turn
  // like `contact_auth`, and for the same reason it is worth a line: past this gate nothing runs,
  // so without one the operator sees an agent that stopped answering and no cause.
  "spend_ceiling",
  // The per-conversation turn limit handing a conversation to a person: the agent answered so often
  // in the last hour that the other side is most likely automated. Before the turn, like the ceiling.
  "turn_limit",
  "generate", // the LLM turn (graph.invoke)
  "guardrail", // input/output moderation trip (a guardrails check fired)
  "tool", // a tool call the agent made during the turn (name + status + duration)
  "normalize", // the reply rewritten for speech before synthesis (its own model call)
  "tts", // audio-reply synthesis
  // The detector's verdict on a synthesized audio: passed, regenerated, rejected (the reply went as
  // text), or sent corrupted in shadow mode. Its own stage so an alert channel can subscribe to
  // broken audio without subscribing to every synthesis.
  "tts_check",
  "split", // humanized balloon delivery
  // The CHANNEL refused a reply after Chatwoot accepted it: the failure arrives later, on a
  // `message_updated` carrying `external_error`. One line per report, naming the code and what was
  // done about it (resent as text, or nothing), never the channel's sentence or the reply.
  "channel_error",
  "handoff", // an ownership gate closed: a takeover, or the conversation left the bot
  "memory", // a closed attendance folded into the contact's memory (compaction)
  // A watching agent's verdict on a conversation it does not answer, written as labels by the
  // OBSERVE job. One line per tick, whether or not anything changed, because "the observer ran and
  // agreed with the label already there" is the answer an operator asks for when a label looks
  // stale.
  "observe",
  // NOT a turn step: an outbound webhook delivery the bus gave up on, on a worker tick long after
  // whatever produced the event, so it hangs off no conversation and no contact. It is here because
  // this vocabulary is what an alert channel subscribes to and what the Logs page filters by.
  "webhook",
  // NOT a turn step either: a unit of work that reached a TERMINAL failure state (a scheduled job
  // past its budget, an alert the bus gave up on, an inbound event or a document that will never be
  // processed). One stage for every bus because it is one question ("what did the system give up
  // on?"); `detail.unit` says which bus.
  "dead_letter",
  // NOT a turn step either: a reply that WAITED for capacity past the operator's threshold, either
  // a due debounce flush with no free slot in its lane or a model call with no free permit in the
  // process-wide semaphore. `detail.waitedOn` says which. Its own stage so a channel can subscribe
  // to saturation without subscribing to every generate warning.
  "capacity",
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
