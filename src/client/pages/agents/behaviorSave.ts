// What a Behavior save writes (agents#1304): the blocks the operator edited, and nothing else. A block
// is edited when its FORM state differs from the same state read off the server's copy
// (`formOfSynced`); the comparison is made before serialization, which is lossy (`Number(x) || 15`
// writes a typed 15 and a stored 0 alike, so a 0 changed to 15 would read untouched). An unedited
// block goes back exactly as stored, which for a block the agent never had means absent. Written out
// instead, it would freeze the defaults the form showed into the agent: a later change of a default
// in the code would no longer reach it, and the stored settings would stop saying what the operator
// chose.

const MONITORING_TIMING = ["analysis", "window", "debounce"] as const;

const isBag = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

// `fromForm`: each block as the save would write it. `formState` and `storedState`: each block's form
// state, keyed like the blocks, read off the form and off the server's copy at one instant.
export function editedBlocks(
  fromForm: Record<string, unknown>,
  formState: Record<string, unknown>,
  storedState: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, block] of Object.entries(fromForm)) {
    if (block === undefined) continue;
    // A block with no state to compare is written: dropping an edit is the worse mistake.
    if (
      key in formState &&
      JSON.stringify(formState[key]) === JSON.stringify(storedState[key])
    ) {
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
