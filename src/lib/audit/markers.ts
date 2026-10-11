// The keys a projection carries to say "this write moved a value the row does not show":
// `undisclosedChanged` (`markUndisclosed`, src/modules/audit/projection.ts) when an `UNDISCLOSED`
// column moved, and from src/modules/agents/audit-projection.ts `unreadConfigChanged` when a key no
// reader looks at moved and `entriesChanged` when a contact gate allowlist, recorded as counts, moved
// its entries. This module imports nothing because the console reads them and cannot import
// `src/modules`. A key missing here renders "no field values" over a real change, so a producer writes
// a marker only through `withAuditMarker`, biome-plugins/no-raw-audit-marker.grit refuses any other
// spelling, and tests/modules/audit-markers.test.ts fails on a `…Changed: true` a producer emits.
export const AUDIT_MARKER_KEYS = [
  "undisclosedChanged",
  "unreadConfigChanged",
  "entriesChanged",
] as const;

export type AuditMarkerKey = (typeof AUDIT_MARKER_KEYS)[number];

// A copy of the projection with the marker on it.
export function withAuditMarker<T extends object, K extends AuditMarkerKey>(
  projection: T,
  key: K,
): T & Record<K, true> {
  return { ...projection, [key]: true } as T & Record<K, true>;
}

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
