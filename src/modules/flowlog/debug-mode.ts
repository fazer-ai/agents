import {
  isFullDetailWindowOpen,
  type ObservabilityConfig,
  readObservabilityConfig,
} from "./settings";

// The one answer to "is anything recording more than the default right now?". Three switches widen
// what a log keeps and stay separate, since each answers a different question:
//   agent  observability.logToolValues     the customer's PII   values instead of shapes
//   agent  observability.fullDetailUntil   database size        detail strings whole, not cut at 2000
//   tenant langfuse.sendContent            destination          content reaches an EXTERNAL service
// Only the warning is shared: this is the single derivation the console indicator and the MCP read
// use, and a new switch belongs here rather than in a second copy of the `||`.
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

// The same derivation over values already read (the console's form state and tenant flag), so the
// console does not spell the `||` out again. `now` is re-judged through the reader's own rule
// because the size switch turns itself off, and a page-load reading would keep reporting it on.
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
