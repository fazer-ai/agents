import {
  isFullDetailWindowOpen,
  type ObservabilityConfig,
  readObservabilityConfig,
} from "./settings";

// THE ONE ANSWER TO "IS ANYTHING RECORDING MORE THAN THE DEFAULT RIGHT NOW?"
//
// Three switches widen what an execution log keeps, and they were designed NOT to be merged, because
// each answers a different question (issue #58):
//
//   agent  observability.logToolValues     the customer's PII   values instead of shapes
//   agent  observability.fullDetailUntil   database size        detail strings whole, not cut at 2000
//   tenant langfuse.sendContent            destination          content reaches an EXTERNAL service
//
// Merging any two of them inverts an operator's intent: joining the PII switch to the size switch
// makes "did my attribute block get injected?" start storing CPFs, and joining the destination
// switch to either makes a LOCAL debug toggle start shipping customer content to a third party.
//
// What IS shared is the warning. An operator does not need to remember which of three unrelated
// screens they touched last week — they need one place that says something is on, and which. So the
// keys stay apart and this module is the single derivation both surfaces read: the console's
// indicator and the agent read over MCP. A fourth switch added later belongs here, not in a second
// copy of the same `||`.
export interface DebugModes {
  // Whether ANY of the three is on. The indicator's own condition — never re-derive it from the
  // fields below, or a switch added here stops lighting it.
  any: boolean;
  logToolValues: boolean;
  fullDetail: boolean;
  // When the size switch expires, or null when it is off. It is the only one of the three that ends
  // on its own, and the only one that can say WHEN, so it is the only one carried as an instant.
  fullDetailUntil: Date | null;
  langfuseSendContent: boolean;
}

export function readDebugModes(
  agentSettings: unknown,
  tenantSettings: unknown,
  now: Date = new Date(),
): DebugModes {
  return debugModesFrom(
    readObservabilityConfig(agentSettings, now),
    readLangfuseSendContent(tenantSettings),
    now,
  );
}

// The same derivation over values already read, for the caller that holds the config rather than
// the bag — the console, which has the agent's settings parsed into its form state and the tenant's
// flag from its own fetch. It exists so the console does not spell the `||` out a second time: the
// one place a switch gets forgotten is the copy, and the copy is invisible to the tests that cover
// this file.
// `now` is re-judged rather than taken from the config, because ONE of these three switches turns
// itself off. A console that read the config at page load would keep reporting the size switch as on
// after its window closed — the same false answer this warning was just fixed for, arriving by the
// clock instead of by a click. Through the reader's own rule, so the two cannot fork.
export function debugModesFrom(
  obs: ObservabilityConfig,
  langfuseSendContent: boolean,
  now: Date = new Date(),
): DebugModes {
  const fullDetail = isFullDetailWindowOpen(obs.fullDetailUntil, now);
  return {
    any: obs.logToolValues || fullDetail || langfuseSendContent,
    logToolValues: obs.logToolValues,
    fullDetail,
    fullDetailUntil: fullDetail ? obs.fullDetailUntil : null,
    langfuseSendContent,
  };
}

// Read straight from the bag rather than through `readLangfuseConfig`: that one resolves a credential
// and answers whether tracing is RUNNABLE, and this question is narrower — whether the operator asked
// for content to leave. A tenant whose Langfuse credential is missing still has the switch on, and an
// indicator that went quiet because the credential broke would be lying about what is configured.
function readLangfuseSendContent(tenantSettings: unknown): boolean {
  if (!tenantSettings || typeof tenantSettings !== "object") return false;
  const lf = (tenantSettings as Record<string, unknown>).langfuse;
  if (!lf || typeof lf !== "object") return false;
  const v = (lf as Record<string, unknown>).sendContent;
  return v === true || v === "true";
}
