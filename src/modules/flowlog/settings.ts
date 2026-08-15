// Per-agent observability knobs, read from `agent.settings.observability` (Json, additive).
// Mirrors readLimitsConfig / readDebounceConfig.
//
// `logToolValues` decides what a tool call leaves in `ExecutionLog.detail`: OFF (the default) stores
// each argument and result as its SHAPE (`{ cpf: "string(11)" }`, see shape.ts), which is what keeps
// that column's documented promise of carrying no message text or PII; ON stores the values the model
// actually sent.
//
// It is per AGENT rather than per instance because that matches how it gets used: turn it on for the
// one agent whose tool calls are misbehaving, reproduce, turn it off. The blast radius is that
// agent's log lines instead of every conversation in the deployment.
//
// The default is what the promise requires, and the switch is not gated by edition: taking the values
// away by default and then charging to see them again would leave the Free edition with no way at all
// to find out what the model passed to a tool, which the conversation does not show either.

export interface ObservabilityConfig {
  logToolValues: boolean;
}

export function readObservabilityConfig(
  settings: unknown,
): ObservabilityConfig {
  const def: ObservabilityConfig = { logToolValues: false };
  if (!settings || typeof settings !== "object") return def;
  const o = (settings as Record<string, unknown>).observability;
  if (!o || typeof o !== "object") return def;
  return {
    logToolValues:
      (o as Record<string, unknown>).logToolValues === true ||
      (o as Record<string, unknown>).logToolValues === "true",
  };
}
