import { RAG_TOOL_NAMES } from "@/graph/tools/catalog";
import { normalizeToolName } from "@/graph/tools/toolName";
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
  const wanted = normalizeToolName(name);
  if (!wanted.startsWith("send_")) return null;
  // By the MODEL-FACING name on both sides: a slug is already `[a-z0-9_]`, but the tool name being
  // checked may be any spelling a row holds, and `send_Foo` and `send_foo` are one name there.
  const templates = await db.documentTemplate.findMany({
    select: { name: true, slug: true },
  });
  return templates.find((t) => documentToolName(t.slug) === wanted) ?? null;
}

// The mirror, for the write that creates a document template: an HTTP or code tool already holding
// the name its slug would produce.
export async function toolHoldingName(
  db: ScopedDb,
  slug: string,
): Promise<{ name: string } | null> {
  const wanted = documentToolName(slug);
  // Read and normalized, for the reason `toolsUnderModelName` gives: a row stored as `Send_Foo`
  // reaches the model as `send_foo`, which is the name this slug would publish.
  const [http, code] = await Promise.all([
    db.toolDefinition.findMany({ select: { label: true, name: true } }),
    db.codeToolDefinition.findMany({ select: { label: true, name: true } }),
  ]);
  const holder = [...http, ...code].find(
    (r) => normalizeToolName(r.name) === wanted,
  );
  return holder ? { name: holder.label } : null;
}

// A row written before names were canonicalized (or by a path that wrote past the service) can hold
// a spelling the model never sees: `Foo` reaches it as `foo`. So the namespace is compared on the
// MODEL-FACING name, which means reading the tenant's names and normalizing them here rather than
// asking the index for an exact match. A tenant has tens of tools, and this runs on a write.
// WHICH row a name resolves to, when the answer has to be one row and not a set.
//
// `toolsUnderModelName` answers "is this name taken", where every match counts. This answers "which
// tool does this name mean", and the two are different questions the moment a destination holds
// legacy rows the old case-sensitive unique index allowed: `Foo` and `foo` both derive `foo`, and
// picking `[0]` off an unordered read hands the agent whichever the database listed first, which is
// a different endpoint and a different credential from the one the bundle named (round 29).
//
// The exact stored spelling wins, because it is the one thing that is not a guess. Failing that, a
// single derived match is unambiguous and is the case the canonicalization exists to serve. More
// than one is ambiguous and is answered as such: a caller that cannot say WHICH must not pick.
export type NameMatch =
  | { kind: "none" }
  | { kind: "one"; id: bigint }
  | { kind: "ambiguous"; ids: bigint[] };

export function resolveByModelName(
  rows: Array<{ id: bigint; name: string }>,
  name: string,
): NameMatch {
  const exact = rows.find((r) => r.name === name);
  if (exact) return { kind: "one", id: exact.id };
  const wanted = normalizeToolName(name);
  const derived = rows.filter((r) => normalizeToolName(r.name) === wanted);
  if (derived.length === 0) return { kind: "none" };
  const only = derived[0];
  if (derived.length === 1 && only) return { kind: "one", id: only.id };
  return { kind: "ambiguous", ids: derived.map((r) => r.id) };
}

export async function toolUnderModelName(
  db: ScopedDb,
  name: string,
  kind: "http" | "code",
): Promise<NameMatch> {
  const rows =
    kind === "http"
      ? await db.toolDefinition.findMany({ select: { id: true, name: true } })
      : await db.codeToolDefinition.findMany({
          select: { id: true, name: true },
        });
  return resolveByModelName(rows, name);
}

export async function toolsUnderModelName(
  db: ScopedDb,
  name: string,
): Promise<{ httpIds: bigint[]; codeIds: bigint[] }> {
  const wanted = normalizeToolName(name);
  const [http, code] = await Promise.all([
    db.toolDefinition.findMany({ select: { id: true, name: true } }),
    db.codeToolDefinition.findMany({ select: { id: true, name: true } }),
  ]);
  return {
    httpIds: http
      .filter((r) => normalizeToolName(r.name) === wanted)
      .map((r) => r.id),
    codeIds: code
      .filter((r) => normalizeToolName(r.name) === wanted)
      .map((r) => r.id),
  };
}
