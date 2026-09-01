import type { ConfigIssueKey } from "@/modules/agents/config-health";

// How bad each configuration warning is, for a caller that has to DECIDE something with it. The
// editor never needed this: a person reads the sentence and judges. An automated onboarding cannot,
// and "is this agent healthy" is not a yes/no — it finishes with a list, and the only useful next
// question is whether to stop or to note it and carry on.
//
// The three levels are not a scale of annoyance. Each answers a different question about what the
// customer experiences RIGHT NOW, and every key below is placed by the consequence its own block in
// config-health.ts already names, never by how alarming the sentence sounds:
//
//   blocking   The agent does not answer, or it answers without a protection whose switch reads
//              "on". Nothing else about the install matters while one of these is live.
//   degraded   The agent answers. A feature the operator turned on does not run, silently, so the
//              install delivers less than it was configured to.
//   advisory   Nothing is off. Two settings contradict each other, or text already stored is longer
//              than its reader keeps. The operator picks; there is no wrong state to repair.
export type ConfigIssueSeverity = "blocking" | "degraded" | "advisory";

// Exhaustive BY TYPE rather than by a default, which is the whole point of the Record: a new
// ConfigIssueKey does not get a severity by accident, it fails the build until somebody decides.
// A default would have picked one for it, and the key most likely to be added is the one somebody
// just found in production — exactly the one nobody should be guessing about.
const SEVERITY: Record<ConfigIssueKey, ConfigIssueSeverity> = {
  // `loadAgentConfig` returns null for the whole agent when the model cannot be built, which is
  // silence on every message rather than one feature going quiet.
  model: "blocking",
  // Fail-open: the analysis is skipped and every message is delivered as if it had been screened.
  guardrails: "blocking",
  // The same consequence, except measured rather than deduced: those turns already went out
  // unscreened.
  guardrailsFailing: "blocking",
  // The gate fails closed, so the agent goes silent for every contact.
  contactAuth: "blocking",
  // The same, from the other direction: an enabled gate with no endpoint refuses every message.
  contactAuthNoUrl: "blocking",

  stt: "degraded",
  tts: "degraded",
  // Best-effort at runtime: the audio still goes out, unrewritten.
  ttsNormalize: "degraded",
  // The attendance is never summarized, and nothing goes back for it later.
  memoryModel: "degraded",
  // The one override whose whole purpose is the day the primary fails.
  modelFallback: "degraded",
  vision: "degraded",
  // Documents are in the base and unsearchable until somebody indexes them.
  knowledge: "degraded",
  // The prerequisite for the line above: indexing cannot run at all.
  embedding: "degraded",
  // The funnel is inert; the runtime no-ops.
  redirect: "degraded",

  // Both switches are legitimate on their own, so config-health says it rather than resolving it.
  contactAuthUnlockHandoff: "advisory",
  contactAuthSilentRefusal: "advisory",
  // Two products answering out of hours, or one announcing a closure the other serves through.
  // Nothing here is broken: half the fix lives on Chatwoot's screen, and the operator decides.
  outOfHoursBoth: "advisory",
  outOfHoursChatwoot: "advisory",
  // Text already in the row, past what its reader keeps.
  textCap: "advisory",
};

export function severityOf(key: ConfigIssueKey): ConfigIssueSeverity {
  return SEVERITY[key];
}

// Ordered worst-first, which is the order a caller reads and the order the summary counts in.
export const SEVERITY_ORDER: readonly ConfigIssueSeverity[] = [
  "blocking",
  "degraded",
  "advisory",
];
