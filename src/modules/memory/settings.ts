// Per-agent memory compaction, read from `agent.settings.memory` (Json, additive). Mirrors
// readObservabilityConfig / readLimitsConfig.
//
// ON BY DEFAULT, unlike every other block in this bag: the thread is keyed per contact-inbox and never
// pruned, and compaction does not discard (it replaces an ended attendance's raw turns with a summary).
// It costs one generation per closed attendance, off the hot path, and loses fine-grained detail.
// See docs/graph.md, Memory compaction.

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface MemoryConfig {
  compaction: {
    enabled: boolean;
    // The summarizer's OWN model, as an override of the agent's. All four null means "inherit the
    // agent's model", which every bag without this block means: compaction is on by default, so
    // demanding a provider here would stop it on every install. Pointing it at a cheaper model is not
    // recommended: it drops the customer's name about once in five (docs/graph.md, Memory compaction).
    provider: string | null;
    model: string | null;
    credentialRef: string | null;
    baseURL: string | null;
  };
  // When each message was sent, in front of it, in what the model reads; on by default like
  // compaction. The date is ABSOLUTE and rendered at call time from the instant stored on the message,
  // so it is byte-identical on every later turn and the prompt cache keeps the history prefix.
  historyDates: {
    enabled: boolean;
  };
}

function defaults(): MemoryConfig {
  return {
    compaction: {
      enabled: true,
      provider: null,
      model: null,
      credentialRef: null,
      baseURL: null,
    },
    historyDates: { enabled: true },
  };
}

// Only an explicit false turns a default-ON switch off: an absent or malformed key means the default.
function explicitlyOff(raw: unknown): boolean {
  return raw === false || raw === "false";
}

export function readMemoryConfig(settings: unknown): MemoryConfig {
  const def = defaults();
  if (!settings || typeof settings !== "object") return def;
  const m = (settings as Record<string, unknown>).memory;
  if (!m || typeof m !== "object") return def;
  const block = m as Record<string, unknown>;
  const h = block.historyDates;
  const historyDates = {
    enabled: !(
      h &&
      typeof h === "object" &&
      explicitlyOff((h as Record<string, unknown>).enabled)
    ),
  };
  const c = block.compaction;
  if (!c || typeof c !== "object") return { ...def, historyDates };
  const bag = c as Record<string, unknown>;
  return {
    compaction: {
      enabled: !explicitlyOff(bag.enabled),
      provider: str(bag.provider),
      model: str(bag.model),
      credentialRef: str(bag.credentialRef),
      baseURL: str(bag.baseURL),
    },
    historyDates,
  };
}
