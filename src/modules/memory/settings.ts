// Per-agent memory compaction, read from `agent.settings.memory` (Json, additive). Mirrors
// readObservabilityConfig / readLimitsConfig.
//
// ON BY DEFAULT, which is the opposite of how every other block in this bag defaults, so the reason
// is worth writing down. The thread is keyed per contact-inbox and nothing ever pruned it, so a
// returning customer drags every past attendance into every turn (measured: 79,862 tokens of context
// against a 15,806-token floor of prompt + tool definitions). The token ceiling that shipped first
// bounds that by DISCARDING, so it defaults off — an instance that upgrades must not silently start
// forgetting. Compaction does not discard: it replaces the raw turns of an attendance that already
// ended with a summary of it, which is what the product intended by "the agent remembers this
// contact" in the first place. Defaulting it off would mean nobody's instance improves until an
// operator goes looking for a switch.
//
// What it costs: one extra generation per closed attendance, on the agent's own model, off the hot
// path (a scheduler job, after the reply is posted). What it loses: fine-grained detail. High-level
// facts survive a summary; the exact wording of a message three attendances ago does not. That is
// the documented trade of every compaction design, and it is stated on the editor field rather than
// left for an operator to discover.

export interface MemoryConfig {
  compaction: { enabled: boolean };
}

export function readMemoryConfig(settings: unknown): MemoryConfig {
  const def: MemoryConfig = { compaction: { enabled: true } };
  if (!settings || typeof settings !== "object") return def;
  const m = (settings as Record<string, unknown>).memory;
  if (!m || typeof m !== "object") return def;
  const c = (m as Record<string, unknown>).compaction;
  if (!c || typeof c !== "object") return def;
  // NOTE: Only an explicit false turns it off. Absent, malformed, or anything truthy reads as the
  // default — a bag written by an older build has no `memory` key at all, and that has to mean "the
  // default", not "off".
  const raw = (c as Record<string, unknown>).enabled;
  return { compaction: { enabled: !(raw === false || raw === "false") } };
}
