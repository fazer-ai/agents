// The keys a projection carries to say "this write moved a value the row does not show".
// `undisclosedChanged` is put on BOTH sides of a projection by `markUndisclosed`
// (`src/modules/audit/projection.ts`) when an `UNDISCLOSED` column moved; `unreadConfigChanged` is put
// on the settings bag by `src/modules/agents/audit-projection.ts` when a key no reader looks at moved.
// They live in a module that imports nothing because the console reads both and cannot import
// `src/modules`. A reader missing one renders "no field values" over a real change, so
// `tests/modules/audit-markers.test.ts` fails while a producer writes a marker not listed here.
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
