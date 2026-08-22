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

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export interface MemoryConfig {
  compaction: {
    enabled: boolean;
    // The summarizer's OWN model, as an override of the agent's. All four null means "inherit the
    // agent's model", which is what every bag written before this existed means and what it has to
    // keep meaning: compaction is on by default, so a reader that demanded a provider here would
    // stop compacting on every install that never configured one.
    //
    // MEASURED before recommending anything, because the obvious use of this knob — point it at the
    // cheapest model on the same account — turned out to be a bad trade. `bun
    // scripts/measure-summary-battery.ts` drives the real summarizer with a real key and scores it
    // on the axes ./summarize.ts already publishes. On the hard dialogue (the value changes
    // mid-conversation, one constraint stated once at the start, nothing closed), n=128 per cell:
    //
    //                     name kept      leaked script    median
    //   gpt-5.4-mini       128/128          10/128          308
    //   gpt-5.4-nano       102/128           0/128          322
    //
    // The cheaper model loses the customer's NAME on one attendance in five, and writes slightly
    // more while doing it (on the simple dialogue, n=32: 239 chars against 138, for no extra fact).
    // Every incomplete summary it produced was incomplete for that one reason.
    //
    // That is the same trade ./summarize.ts recorded when it rejected prompt variant C: cleaner
    // script, worse memory. The criterion carries over unchanged — forgetting who the customer is is
    // memory damage, and this summary is read on every later turn with that contact and is never
    // rewritten, while leaked script is cosmetic. So the knob exists, and pointing it at a weaker
    // model on this vendor is NOT the recommendation.
    provider: string | null;
    model: string | null;
    credentialRef: string | null;
    baseURL: string | null;
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
  };
}

export function readMemoryConfig(settings: unknown): MemoryConfig {
  const def = defaults();
  if (!settings || typeof settings !== "object") return def;
  const m = (settings as Record<string, unknown>).memory;
  if (!m || typeof m !== "object") return def;
  const c = (m as Record<string, unknown>).compaction;
  if (!c || typeof c !== "object") return def;
  // NOTE: Only an explicit false turns it off. Absent, malformed, or anything truthy reads as the
  // default — a bag written by an older build has no `memory` key at all, and that has to mean "the
  // default", not "off".
  const bag = c as Record<string, unknown>;
  const raw = bag.enabled;
  return {
    compaction: {
      enabled: !(raw === false || raw === "false"),
      provider: str(bag.provider),
      model: str(bag.model),
      credentialRef: str(bag.credentialRef),
      baseURL: str(bag.baseURL),
    },
  };
}
