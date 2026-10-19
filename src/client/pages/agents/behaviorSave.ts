import { inRange, type NumberRange } from "@/lib/number-range";
import {
  CONTACT_AUTH_RANGES,
  DEBOUNCE_RANGES,
  delayRange,
  LIMITS_RANGES,
  MONITORING_RANGES,
  SERVICE_WINDOW_RANGES,
  SPLIT_RANGES,
  TTS_SPEAKABLE_RANGES,
  TTS_VOICE_RANGES,
} from "@/modules/agents/number-ranges";

// What a Behavior save writes (agents#1304): the blocks the operator edited, and nothing else. A block
// is edited when its FORM state differs from the same state read off the server's copy
// (`formOfSynced`); the comparison is made before serialization, which is lossy (`Number(x) || 15`
// writes a typed 15 and a stored 0 alike, so a 0 changed to 15 would read untouched). An unedited
// block goes back exactly as stored, which for a block the agent never had means absent. Written out
// instead, it would freeze the defaults the form showed into the agent: a later change of a default
// in the code would no longer reach it, and the stored settings would stop saying what the operator
// chose.

const MONITORING_TIMING = ["analysis", "window", "debounce"] as const;

/** The blocks of `settings` a Behavior save writes. The save writes only these, each after comparing
 * its form state with the server's, and the dirty snapshot reads the same states, so a block left off
 * this list is never saved rather than saved unmarked. */
export const BEHAVIOR_BLOCKS = [
  "availability",
  "debounce",
  "stt",
  "contactAuth",
  "tts",
  "calls",
  "split",
  "signature",
  "serviceWindow",
  "followUp",
  "snoozedFollowUp",
  "vision",
  "limits",
  "observability",
  "memory",
  "modelFallback",
  "monitoring",
  "attributeContext",
  "contactFields",
  "takeover",
  "otherInboxes",
] as const;

export type BehaviorBlock = (typeof BEHAVIOR_BLOCKS)[number];

/** Each declared block's form state, the unit both the save and the dirty snapshot compare. */
export type BehaviorState = Record<BehaviorBlock, unknown>;

/** The Behavior tab's dirty snapshot: the fields the tab saves outside `settings`, then every declared
 * block's state. Two snapshots differ exactly when one of those differs. */
export function behaviorSnapshot(
  state: BehaviorState,
  agentFields: Record<string, unknown>,
): string {
  return JSON.stringify({
    ...agentFields,
    ...Object.fromEntries(BEHAVIOR_BLOCKS.map((k) => [k, state[k]])),
  });
}

const isBag = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// The numbers a Behavior field draws, by path in its block (`*` is any list index), each with its range
// or, for a delay, the range its unit gives. A drawn field out of range holds Save (NumberInput), so
// one that reaches the save is in a section not on screen: switched off, or hidden by the mode.
type RangeOf = ((parent: Record<string, unknown>) => NumberRange) & {
  // The key restored with the value, when the range depends on it (a delay's unit).
  pairedWith?: string;
};
const at =
  (r: NumberRange): RangeOf =>
  () =>
    r;
const delay: RangeOf = Object.assign(
  (step: Record<string, unknown>) => delayRange(step.delayUnit),
  { pairedWith: "delayUnit" },
);
const fieldsOf = (ranges: Record<string, NumberRange>) =>
  Object.entries(ranges).map(([k, r]) => [[k], at(r)] as const);
const NUMBER_FIELDS: Partial<
  Record<BehaviorBlock, (readonly [readonly string[], RangeOf])[]>
> = {
  debounce: fieldsOf(DEBOUNCE_RANGES),
  split: fieldsOf(SPLIT_RANGES),
  serviceWindow: fieldsOf(SERVICE_WINDOW_RANGES),
  tts: fieldsOf({ ...TTS_VOICE_RANGES, ...TTS_SPEAKABLE_RANGES }),
  contactAuth: fieldsOf(CONTACT_AUTH_RANGES),
  // maxHistoryTokens is left out: 0 is its "off", outside the range on purpose.
  limits: fieldsOf({
    maxToolCalls: LIMITS_RANGES.maxToolCalls,
    maxTurnsPerHour: LIMITS_RANGES.maxTurnsPerHour,
    maxProactivePerDay: LIMITS_RANGES.maxProactivePerDay,
  }),
  followUp: [[["steps", "*", "delayValue"], delay]],
  snoozedFollowUp: [[["cadences", "*", "steps", "*", "delayValue"], delay]],
  monitoring: [
    [["window", "messages"], at(MONITORING_RANGES.windowMessages)],
    [["debounce", "windowSeconds"], at(MONITORING_RANGES.windowSeconds)],
    [["debounce", "maxWindowSeconds"], at(MONITORING_RANGES.maxWindowSeconds)],
  ],
};

// Such a number goes back as stored, or is left out for the reader's default: sent, the server refuses
// it and the operator cannot see the field to fix it. Changes `block` in place (a copy).
function keepUnseenNumbersAsStored(
  block: unknown,
  stored: unknown,
  path: readonly string[],
  rangeOf: RangeOf,
): void {
  if (!isBag(block) && !Array.isArray(block)) return;
  const [head, ...rest] = path;
  if (head === undefined) return;
  if (head === "*") {
    if (!Array.isArray(block)) return;
    block.forEach((item, i) => {
      keepUnseenNumbersAsStored(
        item,
        Array.isArray(stored) ? stored[i] : undefined,
        rest,
        rangeOf,
      );
    });
    return;
  }
  if (!isBag(block)) return;
  const storedBag = isBag(stored) ? stored : undefined;
  if (rest.length > 0) {
    keepUnseenNumbersAsStored(block[head], storedBag?.[head], rest, rangeOf);
    return;
  }
  const v = block[head];
  if (typeof v !== "number" || inRange(v, rangeOf(block))) return;
  if (storedBag && head in storedBag) block[head] = storedBag[head];
  else delete block[head];
  // The unit goes back with the value, or a default delay left out would read in the draft's unit.
  const unit = rangeOf.pairedWith;
  if (unit === undefined) return;
  if (storedBag && unit in storedBag) block[unit] = storedBag[unit];
  else delete block[unit];
}

// `fromForm`: each block as the save would write it. `formState` and `storedState`: each block's form
// state, keyed like the blocks, read off the form and off the server's copy at one instant.
export function editedBlocks(
  fromForm: Partial<Record<BehaviorBlock, unknown>>,
  formState: BehaviorState,
  storedState: BehaviorState,
  stored: Record<string, unknown>,
): Partial<Record<BehaviorBlock, unknown>> {
  const out: Partial<Record<BehaviorBlock, unknown>> = {};
  for (const key of BEHAVIOR_BLOCKS) {
    const formBlock = fromForm[key];
    if (formBlock === undefined) continue;
    if (JSON.stringify(formState[key]) === JSON.stringify(storedState[key])) {
      continue;
    }
    const block = structuredClone(formBlock);
    for (const [path, rangeOf] of NUMBER_FIELDS[key] ?? []) {
      keepUnseenNumbersAsStored(block, stored[key], path, rangeOf);
    }
    // Behavior owns only the timing half of `monitoring`; the decision setup is the decisions save's
    // (./observationFormState). An edited timing goes onto the block as stored, so the setup keeps
    // the bytes it was written with instead of its reading.
    out[key] =
      key === "monitoring" && isBag(block) && isBag(stored.monitoring)
        ? {
            ...stored.monitoring,
            ...Object.fromEntries(
              MONITORING_TIMING.filter((k) => k in block).map((k) => [
                k,
                block[k],
              ]),
            ),
          }
        : block;
  }
  return out;
}
