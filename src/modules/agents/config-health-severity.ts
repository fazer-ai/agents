import type { ConfigIssueKey } from "@/modules/agents/config-health";

// How bad each configuration warning is, for a caller that must decide whether to stop, placed by
// what the customer experiences now: `blocking` (no answer, or an answer without a protection that
// reads "on"), `degraded` (a feature that is on does not run), `advisory` (nothing is off; a choice).
export type ConfigIssueSeverity = "blocking" | "degraded" | "advisory";

// Exhaustive BY TYPE rather than by a default, which is the whole point of the Record: a new
// ConfigIssueKey does not get a severity by accident, it fails the build until somebody decides.
// A default would have picked one for it, and the key most likely to be added is the one somebody
// just found in production — exactly the one nobody should be guessing about.
const SEVERITY: Record<ConfigIssueKey, ConfigIssueSeverity> = {
  // `loadAgentConfig` returns null for the whole agent when the model cannot be built, which is
  // silence on every message rather than one feature going quiet.
  model: "blocking",
  // No provider at all: `parseModelConfig` refuses the bag and the turn never starts.
  modelNotRunnable: "blocking",
  // openai-compatible with nowhere to dial: `createChatModel` throws instead of degrading.
  modelNoEndpoint: "blocking",
  // An endpoint that is stated and undialable: every request goes to an address nothing answers.
  modelBadEndpoint: "blocking",
  // Fail-open: the analysis is skipped and every message is delivered as if it had been screened.
  guardrails: "blocking",
  // The same consequence, observed rather than deduced: those turns already went out unscreened.
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
  // Suggestions still reach the queue, unreviewed.
  suggestionReviewModel: "degraded",
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
