// Which trail an audit read answers for.
//
// It lives HERE, beside `actions.ts` and for the same reason: a module that imports nothing, so the
// browser bundle can read it without dragging a `src/modules` file across the boundary
// `tests/client/bundle-boundary.test.ts` guards. The console needs the vocabulary to build its
// selector; the service needs it to decide which role to read under.
//
// `tenant` is the RLS read every caller has always had. The other two are a DIFFERENT QUERY rather
// than a wider filter: the rows keyed to no tenant are not filtered out of the tenant read, they are
// unreachable from it, because the policy is `tenant_id = current_setting('app.tenant_id')` and NULL
// satisfies no comparison. Reaching them means entering the fleet role, and that is SUPER_ADMIN's.
export const AUDIT_SCOPES = ["tenant", "fleet", "all"] as const;

export type AuditScope = (typeof AUDIT_SCOPES)[number];

/** Whether a string off a URL or a query string names a scope. */
export function isAuditScope(value: string): value is AuditScope {
  return (AUDIT_SCOPES as readonly string[]).includes(value);
}
