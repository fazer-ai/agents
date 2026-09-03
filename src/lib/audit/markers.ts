// The keys a projection carries to say "this write moved a value the row does not show".
//
// There are two of them because they were built for two different halves of the same problem and
// neither can be expressed as the other: `undisclosedChanged` is the seam's, put on BOTH sides of a
// projection by `markUndisclosed` (`src/modules/audit/projection.ts`) when a column in a module's
// `UNDISCLOSED` list moved; `unreadConfigChanged` is #394's, put on the settings bag by
// `src/modules/agents/audit-projection.ts` when a key no canonical reader looks at moved.
//
// They live HERE, in a module that imports nothing, because the only reader that needs BOTH is the
// console, and the console cannot import a `src/modules` file (`tests/client/bundle-boundary.test.ts`
// keeps the server out of the browser bundle). A reader that knows one marker and not the other
// renders "this action recorded no field values" over a change that did happen, which is worse than
// saying nothing: it is the trail actively denying a mutation it holds. That is the bug this list
// exists to make impossible for the NEXT marker, and `tests/modules/audit-markers.test.ts` fails
// while a producer writes one that is not here.
export const AUDIT_MARKER_KEYS = [
  "undisclosedChanged",
  "unreadConfigChanged",
] as const;

export type AuditMarkerKey = (typeof AUDIT_MARKER_KEYS)[number];

// Whether a value carries a marker ANYWHERE inside it. The agent family puts its marker on the
// field's own projection (`{ settings: { unreadConfigChanged: true } }`), not at the top, so a
// top-level check finds nothing there, and when that field moved NOTHING else the two sides are
// equal marker objects that a diff drops. That is exactly how the change went missing.
export function carriesAuditMarker(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(carriesAuditMarker);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (AUDIT_MARKER_KEYS.some((k) => o[k] === true)) return true;
    return Object.values(o).some(carriesAuditMarker);
  }
  return false;
}
