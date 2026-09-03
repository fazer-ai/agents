import type { ScopedDb } from "@/lib/tenancy";

// One tool name, one owner — across the two tables that hold tool rows (issue #363). An HTTP tool
// and a code tool cannot share a name, and the checks that say so (`assertNameFree` in each
// service, and the import's own pre-check, which writes past both) read the OTHER table. Two tables
// means two unique indexes and no shared one, so under READ COMMITTED two writes claiming the same
// name can each read a table without the other's uncommitted row and both insert.
// `dropDuplicateToolNames` is the backstop at assembly, and a backstop that decides which tool the
// agent gets with a flow-log line as the only trace is exactly what the namespace exists to avoid.
//
// So every writer queues behind one lock. It is a TRANSACTION lock (`_xact_`), taken inside the
// scoped transaction the writers already open and released on commit or rollback, so a failed write
// never leaks it. `current_setting('app.tenant_id')` is the GUC `runScopedOn` sets for RLS, so the
// key cannot disagree with the rows the transaction can see.
//
// The key is the TENANT's namespace, not the name: an import claims many names in one transaction,
// and per-name locks taken in bundle order are two imports away from a deadlock (Postgres would
// abort one of them, and an import aborts whole — issue #221). One lock per transaction has no
// order to get wrong. It costs the serialization of tool writes within a tenant, which are rare and
// operator-driven.
export async function lockToolNames(db: ScopedDb): Promise<void> {
  await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.tenant_id') || ':tool-names', 0))`;
}
