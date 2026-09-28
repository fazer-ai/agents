// Which trail an audit read answers for. It imports nothing, like `actions.ts`, so the console can
// build its selector from it without crossing the bundle boundary.
//
// `fleet` and `all` are a DIFFERENT QUERY rather than a wider filter: rows keyed to no tenant are
// unreachable from the RLS read (`tenant_id = app.tenant_id`, which NULL never satisfies), so
// reaching them means entering the fleet role, which is SUPER_ADMIN's.
export const AUDIT_SCOPES = ["tenant", "fleet", "all"] as const;

export type AuditScope = (typeof AUDIT_SCOPES)[number];

/** Whether a string off a URL or a query string names a scope. */
export function isAuditScope(value: string): value is AuditScope {
  return (AUDIT_SCOPES as readonly string[]).includes(value);
}
