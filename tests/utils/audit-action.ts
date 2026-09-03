import type { AuditAction } from "@/lib/audit/actions";

/**
 * A synthetic action name, for a test about paging, ordering or filtering rather than about the
 * vocabulary.
 *
 * `AuditEntry.action` is `AuditAction` rather than `string` so production code cannot record a name
 * the console has no way to offer, and a fence is worth as much as its escape hatches: one named
 * door that greps, instead of ten anonymous `as` casts spread through the suite. What comes through
 * it are names chosen to SORT (`a.one`, `b.five`, `tie.two`) or to be obviously fake
 * (`test.action`), which is exactly what a real action cannot be. The column is plain `text`, so the
 * row is as valid as any other.
 */
export function syntheticAction(name: string): AuditAction {
  return name as AuditAction;
}
