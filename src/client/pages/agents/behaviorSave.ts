// What a Behavior save writes (agents#1304): the blocks the operator edited, and nothing else. Each
// block is serialized twice, from the form and from the server's copy read through the same readers
// (`formOfSynced`); a block whose two serializations match was not edited, so it goes back exactly as
// stored, which for a block the agent never had means absent. Written out instead, it would freeze
// the defaults the form showed into the agent: a later change of a default in the code would no
// longer reach it, and the stored settings would stop saying what the operator chose.

const MONITORING_TIMING = ["analysis", "window", "debounce"] as const;

const isBag = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

export function editedBlocks(
  fromForm: Record<string, unknown>,
  fromStored: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, block] of Object.entries(fromForm)) {
    if (block === undefined) continue;
    if (JSON.stringify(block) === JSON.stringify(fromStored[key])) continue;
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
