// Per-agent configuration of the SNOOZED ladder, from agent.settings.snoozedFollowUp.

// The ordinary follow-up (./settings.ts) chases a customer who went quiet on the BOT. This one chases
// a customer who went quiet on a PERSON: the person asked for something and snoozed the conversation
// in Chatwoot "until next reply", and without this nobody ever reminds the customer or closes it.
// Same step shape, read by the same step reader, so a step means the same thing in both ladders.

// The cadence is chosen per conversation by label, so the team can pick it with a Chatwoot macro that
// snoozes and labels in one click. `label: null` is the default cadence, for a plain snooze.

import { clipText } from "@/lib/text";
import {
  FOLLOW_UP_MAX_STEPS,
  SNOOZED_FOLLOW_UP_MAX_CADENCES,
} from "@/modules/agents/text-caps";
import { type FollowUpStep, parseFollowUpStep } from "./settings";

export { SNOOZED_FOLLOW_UP_MAX_CADENCES } from "@/modules/agents/text-caps";

export interface SnoozedFollowUpCadence {
  // The Chatwoot label that selects this cadence. null = the default cadence.
  label: string | null;
  steps: FollowUpStep[]; // always 1..FOLLOW_UP_MAX_STEPS after a read
}

export interface SnoozedFollowUpConfig {
  enabled: boolean;
  cadences: SnoozedFollowUpCadence[];
  // Whether the agent's signature goes under the reminder. The reminder speaks for whoever asked, a
  // person, so the bot's sign-off is usually wrong there; the operator decides.
  signature: boolean;
}

function cloneDefaults(): SnoozedFollowUpConfig {
  return { enabled: false, cadences: [], signature: false };
}

export const SNOOZED_FOLLOW_UP_DEFAULTS: SnoozedFollowUpConfig =
  cloneDefaults();

function readCadence(raw: unknown): SnoozedFollowUpCadence | null {
  if (!raw || typeof raw !== "object") return null;
  const bag = raw as Record<string, unknown>;
  const label =
    typeof bag.label === "string" && bag.label.trim()
      ? clipText(bag.label.trim(), 100)
      : null;
  const steps = (Array.isArray(bag.steps) ? bag.steps : [])
    .slice(0, FOLLOW_UP_MAX_STEPS)
    .map(parseFollowUpStep)
    .filter((s): s is FollowUpStep => s !== null);
  // A cadence with no step reminds nobody: dropped, rather than given a default step that would send a
  // message the operator never wrote.
  if (steps.length === 0) return null;
  // `resolve` is honored on the last step only, as in the ordinary ladder.
  const lastIdx = steps.length - 1;
  return {
    label,
    steps: steps.map((s, i) => {
      if (i === lastIdx || !s.resolve) return s;
      const { resolve: _dropped, ...kept } = s;
      return kept;
    }),
  };
}

export function readSnoozedFollowUpConfig(
  settings: unknown,
): SnoozedFollowUpConfig {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).snoozedFollowUp
      : undefined;
  if (!raw || typeof raw !== "object") return cloneDefaults();
  const bag = raw as Record<string, unknown>;
  const cadences: SnoozedFollowUpCadence[] = [];
  // One cadence per label: a second one with the same label could never be picked, and a second
  // default is the same. The first wins, as `pickSnoozedCadence` reads the list.
  const seen = new Set<string>();
  for (const c of (Array.isArray(bag.cadences) ? bag.cadences : [])
    .slice(0, SNOOZED_FOLLOW_UP_MAX_CADENCES)
    .map(readCadence)) {
    if (!c) continue;
    const key = c.label === null ? "\u0000default" : c.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    cadences.push(c);
  }
  return {
    enabled: bag.enabled === true,
    cadences,
    signature: bag.signature === true,
  };
}

// Which cadence a conversation follows: the first cadence, in the operator's order, whose label the
// conversation carries; otherwise the default one. Labels compare ignoring case, as Chatwoot stores
// them lowercased. null = no cadence applies (no label matches and there is no default), and the
// conversation is not chased.
export function pickSnoozedCadence(
  cfg: SnoozedFollowUpConfig,
  labels: readonly string[],
): SnoozedFollowUpCadence | null {
  const have = new Set(labels.map((l) => l.toLowerCase()));
  for (const c of cfg.cadences) {
    if (c.label !== null && have.has(c.label.toLowerCase())) return c;
  }
  return cfg.cadences.find((c) => c.label === null) ?? null;
}
