import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { buildRagTools } from "@/graph/tools/rag";
import * as documents from "@/modules/rag/documents";
import * as embeddings from "@/modules/rag/embeddings";
import { EMBEDDING_DIM } from "@/modules/rag/embeddings";
import * as ragService from "@/modules/rag/service";

// Issue #844: a search whose query embedding had to be asked again says so, so the slow turn it
// held up is attributed to the provider on its own tool line instead of guessed at. Through the real
// tool and the real search, with only the provider's side replaced: the count has to travel from the
// embedding's retry loop, through `searchKnowledge`, into the tool's artifact.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}

describe.skipIf(!dbUp)(
  "search_knowledge reports its retries (issue #844)",
  () => {
    let tenantId = 0n;
    let kbId = 0n;
    const spies: { mockRestore(): void }[] = [];

    beforeAll(async () => {
      tenantId = (
        await (su as PrismaClient).tenant.create({
          data: { name: "RSR", slug: `rsr-844-${process.pid}` },
        })
      ).id;
      kbId = (
        await (su as PrismaClient).knowledgeBase.create({
          data: { tenantId, name: "FAQ" },
        })
      ).id;
      spies.push(
        spyOn(documents, "resolveEmbeddingConfig").mockResolvedValue({
          model: "text-embedding-3-small",
          apiKey: "sk-probe",
        }),
      );
    });

    afterAll(async () => {
      for (const s of spies) s.mockRestore();
      if (su && tenantId) await su.tenant.delete({ where: { id: tenantId } });
      await su?.$disconnect();
      await app?.$disconnect();
    });

    async function search(retries: number) {
      const embed = spyOn(embeddings, "embedQuery").mockImplementation(
        async (_text, _cfg, deps) => {
          for (let i = 0; i < retries; i++) deps?.onRetry?.(new Error("stall"));
          return Array.from({ length: EMBEDDING_DIM }, () => 0.01);
        },
      );
      try {
        const [tool] = buildRagTools(
          {
            tenantId,
            base: app as PrismaClient,
            knowledgeBaseIds: [kbId],
            threadId: "t:playground:1:x",
          },
          ["search_knowledge"],
        );
        return (await tool?.invoke({
          name: "search_knowledge",
          args: { query: "horário" },
          id: "call-1",
          type: "tool_call",
        })) as ToolMessage;
      } finally {
        embed.mockRestore();
      }
    }

    test("a search that asked twice carries the count", async () => {
      const msg = await search(2);
      expect((msg.artifact as { retries?: number }).retries).toBe(2);
    });

    test("a search that found passages carries the count too", async () => {
      const found = spyOn(ragService, "searchKnowledge").mockImplementation(
        async (params) => {
          params.onEmbeddingRetry?.();
          return [
            {
              id: 1n,
              knowledgeBaseId: kbId,
              knowledgeBaseName: "FAQ",
              documentId: 2n,
              documentTitle: "Horários",
              documentUrl: null,
              content: "Abrimos às 9h.",
              metadata: {},
              distance: 0.1,
            },
          ];
        },
      );
      try {
        const [tool] = buildRagTools(
          {
            tenantId,
            base: app as PrismaClient,
            knowledgeBaseIds: [kbId],
            threadId: "t:playground:1:x",
          },
          ["search_knowledge"],
        );
        const msg = (await tool?.invoke({
          name: "search_knowledge",
          args: { query: "horário" },
          id: "call-2",
          type: "tool_call",
        })) as ToolMessage;
        const artifact = msg.artifact as {
          sources: unknown[];
          retries?: number;
        };
        expect(artifact.sources).toHaveLength(1);
        expect(artifact.retries).toBe(1);
      } finally {
        found.mockRestore();
      }
    });

    test("a search that asked once carries no count at all", async () => {
      const msg = await search(0);
      expect(msg.artifact).toEqual({ sources: [] });
    });
  },
);
