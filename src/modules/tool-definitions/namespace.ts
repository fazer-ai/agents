import { RAG_TOOL_NAMES } from "@/graph/tools/catalog";
import { normalizeToolName } from "@/graph/tools/toolName";
import type { ScopedDb } from "@/lib/tenancy";
import { documentToolName } from "@/modules/documents/slug";

// One tool name, one owner, across the two tables that hold tool rows (HTTP and code tools). Two
// tables means no shared unique index, so under READ COMMITTED two writes of the same name could
// both insert; every writer queues behind this lock instead. A TRANSACTION lock (`_xact_`), released
// on commit or rollback; keyed on `app.tenant_id`, the GUC `runScopedOn` sets for RLS. One lock per
// TENANT, not per name: an import claims many names, and per-name locks could deadlock two imports.
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

// Compared on the MODEL-FACING name, not the stored spelling: a legacy row can hold `Foo`, which the
// model sees as `foo`. A tenant has tens of tools and this runs on a write, so reading them is cheap.
// WHICH row a name resolves to, when the answer must be one row: legacy rows can hold both `Foo` and
// `foo`, and picking the first of an unordered read would bind a different endpoint and credential.
// The exact stored spelling wins; failing that, a single derived match; more than one is ambiguous,
// and a caller that cannot say WHICH must not pick.
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
