import { parseDbId } from "@/lib/db-id";
import type { ScopedDb } from "@/lib/tenancy";

// The reference bases of the factual-grounding check (docs/factual-grounding.md): the READY documents
// of the knowledge bases the operator picked, read whole on every reviewed turn as sources the agent
// did not have to search. Read once per turn, so an edited document counts from the next turn on.

export interface GroundingReferenceDoc {
  base: string;
  title: string;
  content: string;
}

export interface GroundingReference {
  docs: GroundingReferenceDoc[];
  // Characters of document content, the unit the ceiling and the flow line use.
  chars: number;
}

export const NO_GROUNDING_REFERENCE: GroundingReference = {
  docs: [],
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
  const rows = await db.knowledgeDocument.findMany({
    where: {
      knowledgeBaseId: {
        in: knowledgeBaseIds.flatMap((id) => parseDbId(id) ?? []),
      },
      status: "READY",
    },
    select: { title: true, content: true, kb: { select: { name: true } } },
    orderBy: [{ knowledgeBaseId: "asc" }, { id: "asc" }],
  });
  const docs = rows.map((r) => ({
    base: r.kb.name,
    title: r.title,
    content: r.content,
  }));
  return { docs, chars: docs.reduce((n, d) => n + d.content.length, 0) };
}
