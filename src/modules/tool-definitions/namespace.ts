import { RAG_TOOL_NAMES } from "@/graph/tools/catalog";
import type { ScopedDb } from "@/lib/tenancy";
import { documentToolName } from "@/modules/documents/slug";

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

// The rest of the namespace, which is not two tables but four kinds. `dropDuplicateToolNames` is
// the backstop for all of them and it decides by ASSEMBLY ORDER, so the loser is silent: a code
// tool named `search_knowledge` exists in the console, is granted, and never reaches the model
// because RAG was built first; a code tool named `send_orcamento` loses the same way to the
// document template whose slug is `orcamento`. Both names are knowable when the tool is written.
//
// Natives are checked separately by each service (`isNativeToolName`), because their refusal is a
// different sentence: a built-in cannot be renamed, while these two can.
export function isRagToolName(name: string): boolean {
  return (RAG_TOOL_NAMES as readonly string[]).includes(name);
}

// The document template whose `send_<slug>` is this name, if the tenant has one.
export async function documentHoldingToolName(
  db: ScopedDb,
  name: string,
): Promise<{ name: string } | null> {
  const slug = name.startsWith("send_") ? name.slice("send_".length) : null;
  if (!slug) return null;
  return db.documentTemplate.findFirst({
    where: { slug },
    select: { name: true },
  });
}

// The mirror, for the write that creates a document template: an HTTP or code tool already holding
// the name its slug would produce.
export async function toolHoldingName(
  db: ScopedDb,
  slug: string,
): Promise<{ name: string } | null> {
  const name = documentToolName(slug);
  const [http, code] = await Promise.all([
    db.toolDefinition.findFirst({ where: { name }, select: { label: true } }),
    db.codeToolDefinition.findFirst({
      where: { name },
      select: { label: true },
    }),
  ]);
  const holder = http ?? code;
  return holder ? { name: holder.label } : null;
}
