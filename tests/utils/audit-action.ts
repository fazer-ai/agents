import type { AuditAction } from "@/lib/audit/actions";

/**
 * A synthetic action name, for a test about paging, ordering or filtering rather than about the
 * vocabulary. `AuditEntry.action` is `AuditAction` so production code cannot record a name the
 * console cannot offer, and this is the one named door that greps, instead of anonymous `as`
 * casts spread through the suite. Names through it SORT (`a.one`, `tie.two`) or are obviously fake
 * (`test.action`); the column is plain `text`, so the row is as valid as any other.
 */
export function syntheticAction(name: string): AuditAction {
  return name as AuditAction;
}
