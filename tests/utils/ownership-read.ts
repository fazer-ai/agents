import { OWNERSHIP_PROJECTION } from "@/modules/chatwoot/human-takeover";

// IS THIS THE OWNERSHIP FENCE'S OWN READ? Asked by every probe that wants to stand in its shoes and
// make it fail, and it cannot be answered any other way: the fence reads `conversation.findUnique`,
// and so does the config load, on the same row, with a superset of these columns. Breaking that one
// instead ends the run before it reaches what those tests are about.
//
// Matched WHOLE, and against the projection the unit itself declares rather than a copy of it. A
// copy is how a column added to the fence stops three probes from injecting anything at all while
// leaving them green — which is the failure mode a "guards the guard" assertion exists to catch, so
// the comparison has to move with the fence on its own.
export function isOwnershipRead(select: unknown): boolean {
  const sel = (select ?? {}) as Record<string, unknown>;
  const want = Object.keys(OWNERSHIP_PROJECTION);
  return (
    Object.keys(sel).length === want.length &&
    want.every((k) => sel[k] === true)
  );
}
