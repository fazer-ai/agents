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
    const block = fromForm[key];
    if (block === undefined) continue;
    if (JSON.stringify(formState[key]) === JSON.stringify(storedState[key])) {
      continue;
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
