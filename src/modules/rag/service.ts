import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import { readEmbeddingSettings } from "@/modules/tenant-settings/service";
import {
  assertChunkingUpdatable,
  cancelPendingJob,
  createDocument,
  refuseUnstorable,
  resolveEmbeddingConfig,
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

// What a knowledge base's audit row carries.
//
// Identity and the indexing policy: the name, the description, the embedding model and the two chunk
// parameters, all of which an operator sets and any of which changes what a search returns. Nothing
// here is content: the documents are the payload, and they have their own action and their own rule
// (`documents.ts`).
type KbAuditRow = {
  id: bigint;
  name: string;
  description: string | null;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
};

function auditProjection(r: KbAuditRow) {
  return {
    id: String(r.id),
    name: r.name,
    description: r.description,
    embeddingModel: r.embeddingModel,
    chunkSize: r.chunkSize,
    chunkOverlap: r.chunkOverlap,
  };
}

const KB_AUDIT_SELECT = {
  id: true,
  name: true,
  description: true,
  embeddingModel: true,
  chunkSize: true,
  chunkOverlap: true,
} as const;

export const KB_NAME_MAX = 200;

// A knowledge base's name is not decoration: `buildRagTools` filters the tenant's bases on
// `name.trim()` and builds the `knowledge_base` enum from what survives, so a blank name is a base
// the agent cannot scope a search to — and, with only one other base left named, the parameter
// disappears for THAT base too. At the other end the name goes whole into the search tool's
// description, which keeps a 1000-character budget so "a verbose KB never bloats the prompt": the
// description is clipped to 140 characters and the name was never bounded at all, so one long name
// spends the budget and the remaining bases are dropped to `<more count="N"/>`.
//
// The rule lived on the REST body (`minLength: 1`) and nowhere else, so the MCP road walked past it.
// Here instead, where all of REST, the MCP tools and their previews reach it. Undefined is NOT
// judged: a patch that never names the name is not a statement about it, the same way an absent body
// is not judged in tool-definitions (issue #501).
// The rule, without the throw, because the agent import needs the answer rather than the refusal: a
// bundle carrying an unusable name is one component to leave out and name, not a bundle to reject.
export function knowledgeBaseNameUsable(name: string): boolean {
  return name.trim().length > 0 && name.length <= KB_NAME_MAX;
}

export function assertKnowledgeBaseNameUsable(name: string | undefined): void {
  if (name === undefined) return;
  if (!knowledgeBaseNameUsable(name)) {
    throw new AppError(
      `name must be 1 to ${KB_NAME_MAX} characters and cannot be blank`,
      400,
      "errors.invalidKnowledgeBaseName",
      { max: KB_NAME_MAX },
      "name",
    );
  }
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
  assertKnowledgeBaseNameUsable(params.name);
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
      select: KB_AUDIT_SELECT,
    });
    await auditMutation(db, params.ctx, {
      action: "knowledge.create",
      target: `knowledge_base:${kb.id}`,
      after: auditProjection(kb),
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

// Exported for its decision table (tests/modules/rag-thread-origin.test.ts). What it decides is
// which id a stored thread key carries, and the key was written from a request body, so every
// answer here is about a value a caller chose.
export function parseThreadOrigin(
  threadId: string | null,
):
  | { kind: "conversation"; instanceId: bigint; displayId: number }
  | { kind: "playground"; agentId: bigint }
  | null {
  if (!threadId) return null;
  const parts = threadId.split(":");
  // NOTE: `parseDbId`, and the `try` it replaces is why. This thread id was written from a REQUEST
  // BODY and read back out of the approval row, so an id past 2^63-1 was stored once and then made
  // every later read of the pending list answer 500 — a `catch` around `BigInt` never saw it,
  // because that value converts. A thread id that carries no usable id has no origin. Issue #407.
  if (parts.length === 4 && parts[1] === "playground") {
    const agentId = parseDbId(parts[2]);
    return agentId === null ? null : { kind: "playground", agentId };
  }
  if (parts.length === 3 && parts[1] !== "playground") {
    const displayId = Number(parts[2]);
    if (!Number.isInteger(displayId)) return null;
    const instanceId = parseDbId(parts[1]);
    return instanceId === null
      ? null
      : { kind: "conversation", instanceId, displayId };
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
  const patch: Record<string, unknown> = {};
  if (params.proposedTitle !== undefined)
    patch.proposedTitle = params.proposedTitle;
  if (params.proposedContent !== undefined)
    patch.proposedContent = params.proposedContent;
  if (params.rationale !== undefined) patch.rationale = params.rationale;
  // The same refusal `updateDocument` gives: a patch that names no field is a request the caller
  // can only have made by mistake, and the route's body makes all three optional.
  if (Object.keys(patch).length === 0) {
    throw new AppError("nothing to update", 400);
  }
  return runScopedOn(base, params.ctx, async (db) => {
    // NOTE: LOCKED and read before the write, because WHICH fields moved is what the row carries and
    // two reviewers editing the same proposal would otherwise each report the other's change as
    // their own.
    await db.$queryRaw`SELECT id FROM approval_queue_items WHERE id = ${params.id} FOR UPDATE`;
    const current = await db.approvalQueueItem.findFirst({
      where: { id: params.id, status: { in: ["PENDING", "EDITED"] } },
      select: {
        status: true,
        proposedTitle: true,
        proposedContent: true,
        rationale: true,
      },
    });
    if (!current) return "not-pending";
    const before = current as unknown as Record<string, unknown>;
    const fields = Object.keys(patch)
      .filter((k) => patch[k] !== before[k])
      .sort();
    // A form re-submitted unchanged reaches here with every field equal, and the status is not a
    // change of its own: an item marked EDITED because somebody opened it and saved it back says a
    // human rewrote a proposal they did not touch.
    if (fields.length === 0) return "updated";
    const res = await db.approvalQueueItem.updateMany({
      where: { id: params.id, status: { in: ["PENDING", "EDITED"] } },
      data: { ...patch, status: "EDITED" },
    });
    // NOTE: WHICH fields the operator rewrote, never what they wrote. An edit before approval is the
    // operator putting their words into what the agent proposed, and the trail's business is that it
    // happened; the text lands in the knowledge base, which is where it is read.
    if (res.count > 0) {
      await auditMutation(db, params.ctx, {
        action: "knowledge.edit",
        target: `approval:${params.id}`,
        after: { id: String(params.id), status: "EDITED", fields },
      });
    }
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
  const rows = await runScopedOn(base, ctx, async (db) => {
    const claimed = await db.$queryRaw<
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
    `;
    // NOTE: In the claim's own transaction, and only when the claim WON: the statement above is what
    // makes an approval exclusive, so a second operator racing it gets no row and records nothing.
    // The document this approval becomes records itself separately (`knowledge_document.create`),
    // which is where the text goes; this row is the decision.
    if (claimed[0]) {
      await auditMutation(db, ctx, {
        action: "knowledge.approve",
        target: `approval:${id}`,
        after: {
          id: String(id),
          knowledgeBaseId: String(claimed[0].knowledge_base_id),
          status: "APPROVED",
        },
      });
    }
    return claimed;
  });
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
    // NOTE: The condition IS the test, so a retry on an item somebody else already decided records
    // nothing. What the row carries is the DECISION and never the proposal's text: the body is what
    // the agent suggested about a customer, and this row outlives the queue item.
    if (res.count > 0) {
      await auditMutation(db, params.ctx, {
        action: "knowledge.reject",
        target: `approval:${params.id}`,
        after: { id: String(params.id), status: "REJECTED" },
      });
    }
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
  chunkSize: number;
  chunkOverlap: number;
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
        // NOTE: the pair `listKnowledgeBases` has always returned. Reading one base was the only
        // knowledge read that omitted it, which is why the MCP preview had nothing to measure a chunking patch
        // against (#524).
        chunkSize: true,
        chunkOverlap: true,
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
  assertKnowledgeBaseNameUsable(params.name);

  await runScopedOn(base, params.ctx, async (db) => {
    // NOTE: LOCKED and read before the write, because this snapshot is the row's `before`. Two
    // overlapping saves would otherwise both read the same base and the second would report a
    // transition its actor never made.
    await db.$queryRaw`SELECT id FROM knowledge_bases WHERE id = ${params.id} FOR UPDATE`;
    const before = await db.knowledgeBase.findUnique({
      where: { id: params.id },
      select: KB_AUDIT_SELECT,
    });
    if (!before) {
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    }
    // NOTE: inside the transaction, and after the row is locked, because the bound is a fact about
    // the row: a patch naming one of the two numbers is measured against the other as it will stand.
    assertChunkingUpdatable(before, params);
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
    const after = await db.knowledgeBase.findUniqueOrThrow({
      where: { id: params.id },
      select: KB_AUDIT_SELECT,
    });
    const beforeProj = auditProjection(before);
    const afterProj = auditProjection(after);
    // NOTE: A row only when something moved. The console PATCHes the whole form on every save, and
    // the chunk parameters are the half an operator re-submits without touching.
    if (projectionMoved(beforeProj, afterProj)) {
      await auditMutation(db, params.ctx, {
        action: "knowledge.update",
        target: `knowledge_base:${params.id}`,
        before: beforeProj,
        after: afterProj,
      });
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
    // NOTE: Read with the row LOCKED before the delete, so the row describes the base actually
    // removed and counts what went with it: the chunks and the documents cascade, and afterwards
    // there is nothing left to count.
    await db.$queryRaw`SELECT id FROM knowledge_bases WHERE id = ${params.id} FOR UPDATE`;
    const before = await db.knowledgeBase.findUnique({
      where: { id: params.id },
      select: KB_AUDIT_SELECT,
    });
    const documents = before
      ? await db.knowledgeDocument.count({
          where: { knowledgeBaseId: params.id },
        })
      : 0;
    // KnowledgeChunk cascades via its FK to KnowledgeBase.
    const res = await db.knowledgeBase.deleteMany({ where: { id: params.id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "knowledge base not found",
        "errors.knowledgeBaseNotFound",
      );
    }
    if (before) {
      await auditMutation(db, params.ctx, {
        action: "knowledge.delete",
        target: `knowledge_base:${params.id}`,
        before: { ...auditProjection(before), documents },
      });
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
