// The vector a queued suggestion is compared by, in the embedding model of the base it targets. The
// reviewer embeds a proposal when it reviews it, and an edit embeds the rewritten text, so the
// candidate ranking and the text the reviewer reads are always the same revision.

import type { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { resolveEmbeddingConfig } from "./documents";
import { embedQuery } from "./embeddings";

export type EmbedSuggestionText = (
  knowledgeBaseId: bigint,
  text: string,
) => Promise<number[]>;

export function suggestionEmbedder(
  base: PrismaClient,
  tenantId: bigint,
): EmbedSuggestionText {
  const ctx: TenantContext = { tenantId, userId: null, role: "TENANT_ADMIN" };
  return async (knowledgeBaseId, text) => {
    const embCfg = await runScopedOn(base, ctx, async (db) => {
      const kb = await db.knowledgeBase.findUnique({
        where: { id: knowledgeBaseId },
        select: { embeddingModel: true },
      });
      if (!kb) throw new Error("knowledge base gone");
      return resolveEmbeddingConfig(db, tenantId, kb.embeddingModel);
    });
    return embedQuery(text, embCfg);
  };
}
