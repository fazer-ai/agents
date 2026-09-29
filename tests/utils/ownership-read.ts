import { OWNERSHIP_PROJECTION } from "@/modules/chatwoot/human-takeover";

// IS THIS THE OWNERSHIP FENCE'S OWN READ? Asked by every probe that stands in its shoes to make it
// fail: the fence reads `conversation.findUnique`, and so does the config load, on the same row with
// a superset of these columns, and breaking that one ends the run before it reaches what those tests
// are about. Matched WHOLE, against the projection the unit itself declares rather than a copy: with
// a copy, a column added to the fence stops the probes injecting anything while leaving them green.
export function isOwnershipRead(select: unknown): boolean {
  const sel = (select ?? {}) as Record<string, unknown>;
  const want = Object.keys(OWNERSHIP_PROJECTION);
  return (
    Object.keys(sel).length === want.length &&
    want.every((k) => sel[k] === true)
  );
}
