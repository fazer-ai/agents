import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readEmbeddingSettings } from "@/modules/tenant-settings/service";
import {
  cancelPendingJob,
  createDocument,
  refuseUnstorable,
  resolveEmbeddingConfig,
  validateChunkParams,
} from "./documents";
import { embedQuery } from "./embeddings";
import { type ChunkHit, searchChunks } from "./sql";

// RAG service (transport-agnostic): knowledge base CRUD, search, and the human-approval queue.
// Document ingest (chunk → embed → pgvector) is handled by src/modules/rag/documents.ts via the
// async RAG_INGEST scheduler job. INVARIANTS:
//   - embedding is network I/O → strictly OUTSIDE any tx (enforced in documents.ts);
//   - KB ownership is enforced by RLS (a foreign-tenant id reads back null → NotFound);
//   - nothing enters a KB without human approval — the agent only proposes (ApprovalQueueItem);
//   - approve uses CAS so a document is created exactly once.

export interface SearchParams {
  ctx: TenantContext;
  query: string;
  knowledgeBaseIds?: bigint[];
  limit?: number;
  efSearch?: number;
  base?: PrismaClient;
}

export async function searchKnowledge(
  params: SearchParams,
): Promise<ChunkHit[]> {
  const base = params.base ?? basePrisma;
  const { ctx } = params;

  // Phase 1 (scoped read): resolve the target KBs (RLS filters to tenant-owned) + embedding cfg.
  // All targeted KBs must share an embedding model (one vector space per search).
  const prep = await runScopedOn(base, ctx, async (db) => {
    const kbs = await db.knowledgeBase.findMany({
      where: params.knowledgeBaseIds
        ? { id: { in: params.knowledgeBaseIds } }
        : {},
      select: { id: true, embeddingModel: true },
    });
    if (kbs.length === 0) return null;
    const models = new Set(kbs.map((k) => k.embeddingModel));
    if (models.size > 1) {
      throw new AppError(
        "cannot search across knowledge bases with different embedding models",
        400,
      );
    }
    const cfg = await resolveEmbeddingConfig(
      db,
      ctx.tenantId as bigint,
      kbs[0]?.embeddingModel as string,
    );
    return { ids: kbs.map((k) => k.id), cfg };
  });
  if (!prep) return [];

  // Phase 2 (NO tx): embed the query (network).
  const queryEmbedding = await embedQuery(params.query, prep.cfg);

  // Phase 3 (scoped tx): KNN search (raw SQL, RLS-fenced).
  return runScopedOn(base, ctx, (db) =>
    searchChunks(db, {
      knowledgeBaseIds: prep.ids,
      queryEmbedding,
      limit: params.limit ?? 5,
      efSearch: params.efSearch,
    }),
  );
}

// ── knowledge base CRUD ──

export async function listKnowledgeBases(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, ctx, async (db) => {
    const rows = await db.knowledgeBase.findMany({
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        description: true,
        embeddingModel: true,
        chunkSize: true,
        chunkOverlap: true,
        createdAt: true,
        _count: { select: { documents: true } },
      },
    });
    return rows.map(({ _count, ...rest }) => ({
      ...rest,
      documentCount: _count.documents,
    }));
  });
}

// Every text this module stores is held to what its column can hold, at the core rather than at a
// transport, because three roads reach these writes: REST, the MCP write tools, and the agent's own
// suggestion tool. Refused rather than repaired: the writer here reads the answer and can send the
// value again without the character. See rag/documents.ts for the full reasoning (issue #247).
export async function createKnowledgeBase(params: {
  ctx: TenantContext;
  name: string;
  description?: string;
  embeddingModel?: string;
  base?: PrismaClient;
}): Promise<{ id: bigint }> {
  const base = params.base ?? basePrisma;
  refuseUnstorable([
    ["name", params.name],
    ["description", params.description],
    ["embeddingModel", params.embeddingModel],
  ]);
  return runScopedOn(base, params.ctx, async (db) => {
    // New bases inherit the tenant's default embedding model (so the tenant's one embedding config
    // applies uniformly) unless the caller pins one explicitly.
    const embeddingModel =
      params.embeddingModel ??
      (await readEmbeddingSettings(db, params.ctx.tenantId as bigint)).model;
    const kb = await db.knowledgeBase.create({
      data: {
        tenantId: params.ctx.tenantId as bigint,
        name: params.name,
        description: params.description,
        embeddingModel,
      },
      select: { id: true },
    });
    return { id: kb.id };
  });
}

// ── human approval queue ──

export interface SuggestParams {
  ctx: TenantContext;
  knowledgeBaseId: bigint;
  proposedContent: string;
  proposedTitle?: string;
  rationale?: string;
  threadId?: string;
  interruptKey?: string;
  base?: PrismaClient;
}

// The same rule the document write applies (issue #247), asked one table earlier and of a different
// writer: `proposedContent` and its siblings are `text` columns, and the agent's own suggestion tool
// is what fills them, so the characters are a model's rather than a person's. A model reads a tool
// failure and can write the fact again without them, so the answer is still a refusal.
export async function createSuggestion(
  params: SuggestParams,
): Promise<{ id: bigint }> {
  const base = params.base ?? basePrisma;
  // Labelled by the names the CALLER sends, not by the columns they land in: both roads here (the
  // REST body and the agent's suggestion tool) spell these `title` / `content` / `rationale`, so a
  // refusal naming `proposedContent` would tell a caller to fix a field they never sent (review
  // round 3).
  refuseUnstorable([
    ["title", params.proposedTitle],
    ["content", params.proposedContent],
    ["rationale", params.rationale],
  ]);
  return runScopedOn(base, params.ctx, async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: params.knowledgeBaseId },
      select: { id: true },
    });
    if (!kb) throw new NotFoundError("knowledge base not found");
    const item = await db.approvalQueueItem.create({
      data: {
        tenantId: params.ctx.tenantId as bigint,
        knowledgeBaseId: params.knowledgeBaseId,
        proposedContent: params.proposedContent,
        proposedTitle: params.proposedTitle,
        rationale: params.rationale,
        threadId: params.threadId,
        interruptKey: params.interruptKey,
        status: "PENDING",
      },
      select: { id: true },
    });
    return { id: item.id };
  });
}

// Where a suggestion came from, resolved from its thread id so the reviewer can jump straight to the
// conversation that produced it. Real conversations carry tenantId:instanceId:displayId and link to
// the conversation detail; playground threads carry tenantId:playground:agentId:uuid and link to the
// agent's playground tab. A deleted conversation/agent ⇒ null (the target is gone; show no link).
export type ApprovalSource =
  | { kind: "conversation"; conversationId: string; label: string }
  | { kind: "playground"; agentId: string; agentName: string | null }
  | null;

function parseThreadOrigin(
  threadId: string | null,
):
  | { kind: "conversation"; instanceId: bigint; displayId: number }
  | { kind: "playground"; agentId: bigint }
  | null {
  if (!threadId) return null;
  const parts = threadId.split(":");
  try {
    if (parts.length === 4 && parts[1] === "playground") {
      return { kind: "playground", agentId: BigInt(parts[2] as string) };
    }
    if (parts.length === 3 && parts[1] !== "playground") {
      const displayId = Number(parts[2]);
      if (!Number.isInteger(displayId)) return null;
      return {
        kind: "conversation",
        instanceId: BigInt(parts[1] as string),
        displayId,
      };
    }
  } catch {
    return null;
  }
  return null;
}

export async function listPendingApprovals(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, ctx, async (db) => {
    const items = await db.approvalQueueItem.findMany({
      where: { status: { in: ["PENDING", "EDITED"] } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        knowledgeBaseId: true,
        threadId: true,
        proposedTitle: true,
        proposedContent: true,
        rationale: true,
        status: true,
        createdAt: true,
      },
    });

    // Batch-resolve display data (the queue is small): the target base name, and the originating
    // conversation/agent for the "go to source" link. RLS scopes every read to this tenant.
    const origins = items.map((i) => parseThreadOrigin(i.threadId));
    const kbIds = [...new Set(items.map((i) => i.knowledgeBaseId))];
    const agentIds = [
      ...new Set(
        origins.flatMap((o) => (o?.kind === "playground" ? [o.agentId] : [])),
      ),
    ];
    const displayIds = [
      ...new Set(
        origins.flatMap((o) =>
          o?.kind === "conversation" ? [o.displayId] : [],
        ),
      ),
    ];

    const [kbs, agents, convs] = await Promise.all([
      kbIds.length
        ? db.knowledgeBase.findMany({
            where: { id: { in: kbIds } },
            select: { id: true, name: true },
          })
        : [],
      agentIds.length
        ? db.agent.findMany({
            where: { id: { in: agentIds } },
            select: { id: true, name: true },
          })
        : [],
      displayIds.length
        ? db.conversation.findMany({
            where: { chatwootConversationId: { in: displayIds } },
            select: {
              id: true,
              chatwootInstanceId: true,
              chatwootConversationId: true,
              contact: { select: { name: true } },
            },
          })
        : [],
    ]);

    const kbName = new Map(kbs.map((k) => [k.id, k.name]));
    const agentName = new Map(agents.map((a) => [a.id, a.name]));

    const resolveSource = (
      origin: (typeof origins)[number],
    ): ApprovalSource => {
      if (!origin) return null;
      if (origin.kind === "playground") {
        return {
          kind: "playground",
          agentId: String(origin.agentId),
          agentName: agentName.get(origin.agentId) ?? null,
        };
      }
      const conv = convs.find(
        (c) =>
          c.chatwootInstanceId === origin.instanceId &&
          c.chatwootConversationId === origin.displayId,
      );
      if (!conv) return null;
      return {
        kind: "conversation",
        conversationId: String(conv.id),
        label: conv.contact?.name?.trim() || `#${origin.displayId}`,
      };
    };

    return items.map((i, idx) => ({
      id: String(i.id),
      knowledgeBaseId: String(i.knowledgeBaseId),
      knowledgeBaseName: kbName.get(i.knowledgeBaseId) ?? null,
      proposedTitle: i.proposedTitle,
      proposedContent: i.proposedContent,
      rationale: i.rationale,
      status: i.status,
      createdAt: i.createdAt,
      source: resolveSource(origins[idx] ?? null),
    }));
  });
}

export interface EditApprovalParams {
  ctx: TenantContext;
  id: bigint;
  proposedTitle?: string;
  proposedContent?: string;
  rationale?: string;
  base?: PrismaClient;
}

// Allowlisted fields only — never threadId/interruptKey/knowledgeBaseId/tenantId. CAS keeps it to
// items still awaiting review.
export async function editApprovalItem(
  params: EditApprovalParams,
): Promise<"updated" | "not-pending"> {
  const base = params.base ?? basePrisma;
  // The caller's names, as in createSuggestion above.
  refuseUnstorable([
    ["title", params.proposedTitle],
    ["content", params.proposedContent],
    ["rationale", params.rationale],
  ]);
  const data: Record<string, unknown> = { status: "EDITED" };
  if (params.proposedTitle !== undefined)
    data.proposedTitle = params.proposedTitle;
  if (params.proposedContent !== undefined)
    data.proposedContent = params.proposedContent;
  if (params.rationale !== undefined) data.rationale = params.rationale;
  return runScopedOn(base, params.ctx, async (db) => {
    const res = await db.approvalQueueItem.updateMany({
      where: { id: params.id, status: { in: ["PENDING", "EDITED"] } },
      data,
    });
    return res.count > 0 ? "updated" : "not-pending";
  });
}

export type ApproveResult =
  | { outcome: "approved"; chunks: number }
  | { outcome: "not-pending" }
  | { outcome: "not-found" };

// Approve = CAS-claim PENDING/EDITED→APPROVED, then create a KnowledgeDocument and enqueue
// RAG_INGEST (async embed+chunk). Concurrent approvers both attempt the CAS; only one wins and
// creates the document. The ingest happens asynchronously via the scheduler worker.
// Claims an approval and returns the text it held AT THE MOMENT OF THE CLAIM. One statement, so no
// edit can slip between reading the content and taking ownership of the row. Returns null when the
// item was already approved or rejected by someone else.
export interface ClaimedApproval {
  knowledgeBaseId: bigint;
  proposedTitle: string | null;
  proposedContent: string;
}

export async function claimApprovalForStorage(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ClaimedApproval | null> {
  const rows = await runScopedOn(
    base,
    ctx,
    (db) =>
      db.$queryRaw<
        {
          knowledge_base_id: bigint;
          proposed_title: string | null;
          proposed_content: string;
        }[]
      >`
      UPDATE approval_queue_items
         SET status = 'APPROVED', updated_at = now()
       WHERE id = ${id}
         AND status IN ('PENDING', 'EDITED')
      RETURNING knowledge_base_id, proposed_title, proposed_content
    `,
  );
  const row = rows[0];
  if (!row) return null;
  return {
    knowledgeBaseId: row.knowledge_base_id,
    proposedTitle: row.proposed_title,
    proposedContent: row.proposed_content,
  };
}

export async function approveApprovalItem(params: {
  ctx: TenantContext;
  id: bigint;
  demoMode?: boolean;
  base?: PrismaClient;
}): Promise<ApproveResult> {
  const base = params.base ?? basePrisma;
  const { ctx } = params;

  // Phase 1 (scoped read): does this item exist, is it still claimable, and does its base still
  // exist — the checks that decide WHETHER to claim.
  //
  // NOTE: The text is deliberately NOT selected here. It used to be, and phase 3 stored that copy,
  // which is a lost update the moment a second reviewer can edit: the revision lands between this
  // read and the claim, the claim accepts it (EDITED is claimable) and the stale copy is what gets
  // embedded. Not reading it here is what makes that impossible to reintroduce — the only text in
  // scope is the one the claim itself returns.
  const loaded = await runScopedOn(base, ctx, async (db) => {
    const item = await db.approvalQueueItem.findUnique({
      where: { id: params.id },
      select: { id: true, status: true, knowledgeBaseId: true },
    });
    if (!item) return { kind: "not-found" as const };
    if (item.status !== "PENDING" && item.status !== "EDITED") {
      return { kind: "not-pending" as const };
    }
    const kb = await db.knowledgeBase.findUnique({
      where: { id: item.knowledgeBaseId },
      select: { id: true },
    });
    if (!kb) return { kind: "not-found" as const };
    return { kind: "ok" as const, item };
  });
  if (loaded.kind === "not-found") return { outcome: "not-found" };
  if (loaded.kind === "not-pending") return { outcome: "not-pending" };

  // Phase 2: CAS-claim the approval (exactly-once) AND read the text in the same statement.
  //
  // NOTE: The content used to come from the phase-1 snapshot, which is a lost update as soon as a
  // second reviewer can edit: A starts approving and reads the hedged text, B saves a revision (the
  // row becomes EDITED, which the claim still accepts), A claims and stores its stale snapshot. Both
  // are told it worked and the un-revised text is what got embedded — precisely the outcome this
  // issue is about. `RETURNING` makes the claim and the read one operation, so whatever the row
  // holds at claim time is what is approved.
  const claimed = await claimApprovalForStorage(ctx, params.id, base);
  if (!claimed) return { outcome: "not-pending" };

  // Phase 3: Create a KnowledgeDocument and enqueue RAG_INGEST (or skip in demo mode).
  const doc = await createDocument({
    ctx,
    knowledgeBaseId: claimed.knowledgeBaseId,
    title: claimed.proposedTitle ?? "Conteúdo aprovado",
    text: claimed.proposedContent,
    sourceType: "approval",
    base,
  });

  if (params.demoMode) {
    // NOTE: demo mode skips real embedding; document goes to READY with 0 chunks.
    await runScopedOn(base, ctx, (db) =>
      db.knowledgeDocument.updateMany({
        where: { id: doc.id, status: "PENDING" },
        data: { status: "READY", chunkCount: 0 },
      }),
    );
    await cancelPendingJob(
      ctx.tenantId as bigint,
      "RAG_INGEST",
      `doc:${doc.id}`,
      base,
    );
  }

  return { outcome: "approved", chunks: 0 };
}

export async function rejectApprovalItem(params: {
  ctx: TenantContext;
  id: bigint;
  base?: PrismaClient;
}): Promise<"rejected" | "not-pending"> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, params.ctx, async (db) => {
    const res = await db.approvalQueueItem.updateMany({
      where: { id: params.id, status: { in: ["PENDING", "EDITED"] } },
      data: { status: "REJECTED" },
    });
    return res.count > 0 ? "rejected" : "not-pending";
  });
}

// ── knowledge base management ──

export async function getKnowledgeBase(params: {
  ctx: TenantContext;
  id: bigint;
  base?: PrismaClient;
}): Promise<{
  id: bigint;
  name: string;
  description: string | null;
  embeddingModel: string;
  chunkCount: number;
  createdAt: Date;
  updatedAt: Date;
}> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, params.ctx, async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        name: true,
        description: true,
        embeddingModel: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!kb) {
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    }
    const chunkCount = await db.knowledgeChunk.count({
      where: { knowledgeBaseId: params.id },
    });
    return { ...kb, chunkCount };
  });
}

export async function updateKnowledgeBase(params: {
  ctx: TenantContext;
  id: bigint;
  name?: string;
  description?: string | null;
  chunkSize?: number;
  chunkOverlap?: number;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  refuseUnstorable([
    ["name", params.name],
    ["description", params.description],
  ]);

  if (params.chunkSize !== undefined && params.chunkOverlap !== undefined) {
    validateChunkParams(params.chunkSize, params.chunkOverlap);
  } else if (params.chunkSize !== undefined) {
    if (params.chunkSize < 100 || params.chunkSize > 8000) {
      throw new AppError("chunkSize must be between 100 and 8000", 400);
    }
  } else if (params.chunkOverlap !== undefined) {
    if (params.chunkOverlap < 0 || params.chunkOverlap > 4000) {
      throw new AppError(
        "chunkOverlap must be between 0 and floor(chunkSize/2)",
        400,
      );
    }
  }

  await runScopedOn(base, params.ctx, async (db) => {
    const res = await db.knowledgeBase.updateMany({
      where: { id: params.id },
      data: {
        ...(params.name !== undefined ? { name: params.name } : {}),
        ...(params.description !== undefined
          ? { description: params.description }
          : {}),
        ...(params.chunkSize !== undefined
          ? { chunkSize: params.chunkSize }
          : {}),
        ...(params.chunkOverlap !== undefined
          ? { chunkOverlap: params.chunkOverlap }
          : {}),
      },
    });
    if (res.count === 0) {
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    }
  });
}

export async function deleteKnowledgeBase(params: {
  ctx: TenantContext;
  id: bigint;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  await runScopedOn(base, params.ctx, async (db) => {
    // KnowledgeChunk cascades via its FK to KnowledgeBase.
    const res = await db.knowledgeBase.deleteMany({ where: { id: params.id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    }
  });
}

export async function listChunks(params: {
  ctx: TenantContext;
  knowledgeBaseId: bigint;
  limit?: number;
  base?: PrismaClient;
}): Promise<
  { id: bigint; content: string; metadata: unknown; createdAt: Date }[]
> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, params.ctx, async (db) => {
    const kb = await db.knowledgeBase.findUnique({
      where: { id: params.knowledgeBaseId },
      select: { id: true },
    });
    if (!kb) {
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    }
    // NOTE: never select `embedding` (the vector) — large and useless on the wire.
    return db.knowledgeChunk.findMany({
      where: { knowledgeBaseId: params.knowledgeBaseId },
      select: { id: true, content: true, metadata: true, createdAt: true },
      orderBy: { id: "asc" },
      take: params.limit ?? 100,
    });
  });
}
