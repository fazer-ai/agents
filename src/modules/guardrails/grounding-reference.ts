import { parseDbId } from "@/lib/db-id";
import type { ScopedDb } from "@/lib/tenancy";
import { GROUNDING_REFERENCE_MAX } from "./grounding";

// The reference bases of the factual-grounding check (docs/factual-grounding.md): the READY documents
// of the knowledge bases the operator picked, read whole on every reviewed turn as sources the agent
// did not have to search. Read once per turn, so an edited document counts from the next turn on.

export interface GroundingReferenceDoc {
  base: string;
  title: string;
  content: string;
}

export interface GroundingReference {
  // Empty when the documents are past the ceiling: then they are counted and measured, never read.
  docs: GroundingReferenceDoc[];
  count: number;
  // Characters of document content, the unit the ceiling and the flow line use.
  chars: number;
}

export const NO_GROUNDING_REFERENCE: GroundingReference = {
  docs: [],
  count: 0,
  chars: 0,
};

// Ordered by base id and document id, so the block the reviewer reads is byte-identical from one turn
// to the next while nothing in the bases changes: that identity is what the providers' prefix caches
// match on. A base of another tenant, or one deleted since it was picked, is simply not read.
export async function loadGroundingReference(
  db: ScopedDb,
  knowledgeBaseIds: readonly string[],
): Promise<GroundingReference> {
  if (knowledgeBaseIds.length === 0) return NO_GROUNDING_REFERENCE;
  const ids = knowledgeBaseIds.flatMap((id) => parseDbId(id) ?? []);
  // Measured in the database first: a base past the ceiling is not reviewed, so its bodies, which can
  // run to millions of characters, are never loaded on the turn.
  const [size] = await db.$queryRaw<Array<{ n: number; chars: bigint }>>`
    SELECT count(*)::int AS n, coalesce(sum(char_length(content)), 0)::bigint AS chars
    FROM knowledge_documents
    WHERE knowledge_base_id = ANY(${ids}) AND status = 'READY'`;
  const count = size?.n ?? 0;
  const chars = Number(size?.chars ?? 0);
  if (count === 0 || chars > GROUNDING_REFERENCE_MAX)
    return { docs: [], count, chars };
  const rows = await db.knowledgeDocument.findMany({
    where: { knowledgeBaseId: { in: ids }, status: "READY" },
    select: { title: true, content: true, kb: { select: { name: true } } },
    orderBy: [{ knowledgeBaseId: "asc" }, { id: "asc" }],
  });
  const docs = rows.map((r) => ({
    base: r.kb.name,
    title: r.title,
    content: r.content,
  }));
  // Measured again on what was read: a document indexed between the two statements is in `docs` and
  // not in the count above, and the ceiling is about what would be sent.
  const read = docs.reduce((n, d) => n + d.content.length, 0);
  return read > GROUNDING_REFERENCE_MAX
    ? { docs: [], count: docs.length, chars: read }
    : { docs, count: docs.length, chars: read };
}
