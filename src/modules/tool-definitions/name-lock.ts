import type { ScopedDb } from "@/lib/tenancy";

// One tool name, one owner — across the two tables that hold tool rows (issue #363). An HTTP tool
// and a code tool cannot share a name, and the check that says so (`assertNameFree`, written twice
// because each service owns its refusal) reads the OTHER table. Two tables means two unique
// indexes and no shared one, so under READ COMMITTED two writes claiming the same name can each
// read a table without the other's uncommitted row and both insert. `dropDuplicateToolNames` is
// the backstop at assembly, and a backstop that decides which tool the agent gets with a flow-log
// line as the only trace is exactly what the namespace exists to avoid.
//
// So the two checks queue behind one lock, keyed on tenant and name. It is a TRANSACTION lock
// (`_xact_`): taken inside the scoped transaction both services already open, released on commit or
// rollback, and never leaked by a failed write. `current_setting('app.tenant_id')` is the GUC
// `runScopedOn` sets for RLS, so the key cannot disagree with the rows the transaction can see.
// One lock per transaction, so there is no ordering between locks to deadlock on.
export async function lockToolName(db: ScopedDb, name: string): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id') || ':' || ${name}, 0))`;
}
