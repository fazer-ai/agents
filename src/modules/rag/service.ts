import { createHash } from "node:crypto";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import { upsertJobRow } from "@/modules/scheduler/service";
import { readEmbeddingSettings } from "@/modules/tenant-settings/service";
import { passageOf } from "./contact-footer";
import {
  assertChunkingUpdatable,
  cancelPendingJob,
  createDocument,
  refuseUnstorable,
  resolveEmbeddingConfig,
  updateDocument,
} from "./documents";
import { embedQuery } from "./embeddings";
import { type ChunkHit, searchChunks, toVectorLiteral } from "./sql";
import {
  type EmbedSuggestionText,
  suggestionEmbedder,
} from "./suggestion-embedding";

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
  // Told each time the query embedding is asked again, so a slow search can say why.
  onEmbeddingRetry?: () => void;
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
  const onRetry = params.onEmbeddingRetry;
  const queryEmbedding = await embedQuery(
    params.query,
    prep.cfg,
    onRetry ? { onRetry: () => onRetry() } : {},
  );

  // Phase 3 (scoped tx): KNN search (raw SQL, RLS-fenced).
  const rows = await runScopedOn(base, ctx, (db) =>
    searchChunks(db, {
      knowledgeBaseIds: prep.ids,
      queryEmbedding,
      limit: params.limit ?? 5,
      efSearch: params.efSearch,
    }),
  );
  // Here and not in one consumer, so the agent's tool, the console's test search and the MCP search
  // all return the passage the agent is actually given.
  return rows.map(passageOf);
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
        stripContactFooters: true,
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
// Identity and the indexing policy: the name, the description, the embedding model, the two chunk
// parameters and the contact-footer switch, all of which an operator sets and any of which changes
// what a search returns. Nothing
// here is content: the documents are the payload, and they have their own action and their own rule
// (`documents.ts`).
type KbAuditRow = {
  id: bigint;
  name: string;
  description: string | null;
  embeddingModel: string;
  chunkSize: number;
  chunkOverlap: number;
  stripContactFooters: boolean;
};

function auditProjection(r: KbAuditRow) {
  return {
    id: String(r.id),
    name: r.name,
    description: r.description,
    embeddingModel: r.embeddingModel,
    chunkSize: r.chunkSize,
    chunkOverlap: r.chunkOverlap,
    stripContactFooters: r.stripContactFooters,
  };
}

const KB_AUDIT_SELECT = {
  id: true,
  name: true,
  description: true,
  embeddingModel: true,
  chunkSize: true,
  chunkOverlap: true,
  stripContactFooters: true,
} as const;

export const KB_NAME_MAX = 200;

// A knowledge base's name is not decoration: `buildRagTools` drops bases with a blank name from the
// `knowledge_base` enum, and the name goes whole into the search tool's description, whose 1000
// character budget a long name would spend. Asserted here, where REST, the MCP tools and their
// previews all reach it; undefined is not judged, since a patch that omits the name says nothing
// about it. The agent import asks the boolean form: an unusable name is a component to leave out.
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

// Every text this module stores is held to what its column can hold, at the core, because REST, the
// MCP write tools and the agent's suggestion tool all reach these writes. Refused rather than
// repaired: the writer reads the answer and can resend without the character (see rag/documents.ts).
export async function createKnowledgeBase(params: {
  ctx: TenantContext;
  name: string;
  description?: string;
  embeddingModel?: string;
  stripContactFooters?: boolean;
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
        ...(params.stripContactFooters !== undefined
          ? { stripContactFooters: params.stripContactFooters }
          : {}),
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
  // The agent whose tool proposed it. Present, the proposal waits for the reviewer (SCREENING);
  // absent (the REST route), it goes straight to the pending list.
  agentId?: bigint;
  base?: PrismaClient;
}

// The proposal as the key compares it: case, whitespace and ordinary punctuation carry no claim, so
// "Prazo: 7 dias." and "prazo 7 dias" are one entry. What can change a number stays: a sign before a
// digit, a separator between digits, a percent after one, and every symbol (°, $, ±, <), so "-10 °C"
// and "+10 °C" are two entries. Letters keep their accents.
export function normalizedSuggestionHash(content: string): string {
  // Code points, not UTF-16 units: an emoji is a symbol only as a whole, and its surrogate halves
  // match no category, so "🟢" and "🔴" would fold to the same blank.
  const chars = Array.from(content.normalize("NFC").toLowerCase());
  const isDigit = (ch: string | undefined) =>
    ch !== undefined && /\p{N}/u.test(ch);
  let folded = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    const prev = chars[i - 1];
    const next = chars[i + 1];
    const keep =
      /[\p{L}\p{N}\p{S}]/u.test(ch) ||
      (/[-\u2212]/u.test(ch) && isDigit(next)) ||
      (/[.,]/.test(ch) && isDigit(prev) && isDigit(next)) ||
      (/[%\u2030]/u.test(ch) && isDigit(prev));
    folded += keep ? ch : " ";
  }
  folded = folded.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(folded, "utf8").digest("hex");
}

// The same storable-text rule as the document write. Here the writer is the agent's suggestion tool,
// a model, which reads a tool failure and can write the fact again, so the answer is still a refusal.
export async function createSuggestion(
  params: SuggestParams,
): Promise<{ id: bigint; created: boolean }> {
  const base = params.base ?? basePrisma;
  // NOTE: Labelled by the names the CALLER sends (`title` / `content` / `rationale` on both the REST
  // body and the suggestion tool), not by the columns they land in.
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
    const tenantId = params.ctx.tenantId as bigint;
    const normalizedHash = normalizedSuggestionHash(params.proposedContent);
    const reviewed = params.agentId !== undefined;
    // The same entry for the same base is the row already there, whatever became of it: a
    // person has it, or decided it. `skipDuplicates` rather than a lookup first, so two proposals
    // racing cannot both insert, and rather than catching P2002, which would abort this transaction.
    const [item] = await db.approvalQueueItem.createManyAndReturn({
      data: {
        tenantId,
        knowledgeBaseId: params.knowledgeBaseId,
        proposedContent: params.proposedContent,
        proposedTitle: params.proposedTitle,
        rationale: params.rationale,
        threadId: params.threadId,
        interruptKey: params.interruptKey,
        normalizedHash,
        agentId: params.agentId,
        status: reviewed ? "SCREENING" : "PENDING",
      },
      skipDuplicates: true,
      select: { id: true },
    });
    if (!item) {
      const existing = await db.approvalQueueItem.findUniqueOrThrow({
        where: {
          tenantId_knowledgeBaseId_normalizedHash: {
            tenantId,
            knowledgeBaseId: params.knowledgeBaseId,
            normalizedHash,
          },
        },
        select: { id: true },
      });
      return { id: existing.id, created: false };
    }
    // NOTE: Armed in the same transaction as the row, so a SCREENING item always has the job that
    // takes it out of SCREENING.
    if (reviewed) {
      await upsertJobRow(db, {
        tenantId,
        kind: "SUGGESTION_REVIEW",
        dedupeKey: String(item.id),
        runAt: new Date(),
        rearm: "once",
        payload: { itemId: String(item.id) },
      });
    }
    return { id: item.id, created: true };
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
  // NOTE: `parseDbId`, not `BigInt` in a `try`: this id came from a request body, and an id past
  // 2^63-1 converts fine yet breaks every later read of the pending list. A thread id with no usable
  // id has no origin.
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

export function listPendingApprovals(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
) {
  return listApprovals(ctx, "pending", base);
}

// What the suggestion reviewer left on an item, resolved for display: the document it would
// replace (pending) or what it matched (discarded). A target deleted since reads as null.
export interface ReviewedDocumentRef {
  id: string;
  title: string;
  content: string;
  // Owned by a source sync, which a replacement would be undone by: only "approve as new" applies.
  synced: boolean;
}
export type ReviewerMatch =
  | { kind: "document"; document: ReviewedDocumentRef }
  | {
      kind: "suggestion";
      id: string;
      status: string;
      title: string | null;
      content: string;
    }
  | null;

// "pending" is what a person decides on (PENDING, EDITED); "discarded" is what the reviewer held back.
export async function listApprovals(
  ctx: TenantContext,
  view: "pending" | "discarded",
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, ctx, async (db) => {
    const items = await db.approvalQueueItem.findMany({
      where: {
        status:
          view === "pending" ? { in: ["PENDING", "EDITED"] } : "DISCARDED",
      },
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
        reviewerComment: true,
        replacesDocumentId: true,
        matchedItemId: true,
        matchedDocumentId: true,
      },
    });
    const docIds = [
      ...new Set(
        items.flatMap((i) =>
          [i.replacesDocumentId, i.matchedDocumentId].filter(
            (d): d is bigint => d !== null,
          ),
        ),
      ),
    ];
    const matchedIds = [
      ...new Set(
        items.flatMap((i) =>
          i.matchedItemId === null ? [] : [i.matchedItemId],
        ),
      ),
    ];
    const [docs, matchedItems] = await Promise.all([
      docIds.length
        ? db.knowledgeDocument.findMany({
            where: { id: { in: docIds } },
            select: {
              id: true,
              title: true,
              content: true,
              externalId: true,
              knowledgeBaseId: true,
            },
          })
        : [],
      matchedIds.length
        ? db.approvalQueueItem.findMany({
            where: { id: { in: matchedIds } },
            select: {
              id: true,
              status: true,
              proposedTitle: true,
              proposedContent: true,
            },
          })
        : [],
    ]);
    const docRef = (id: bigint | null): ReviewedDocumentRef | null => {
      const d = id === null ? undefined : docs.find((x) => x.id === id);
      return d
        ? {
            id: String(d.id),
            title: d.title,
            content: d.content,
            synced: d.externalId !== null,
          }
        : null;
    };
    // The reviewer named a document that approval can no longer replace (deleted, moved to another
    // base, or taken over by a source sync): the same check `approveApprovalItem` makes before
    // claiming, so the only approval left to offer is "as new".
    const replaceUnavailable = (i: (typeof items)[number]): boolean => {
      if (i.replacesDocumentId === null) return false;
      const d = docs.find((x) => x.id === i.replacesDocumentId);
      return (
        !d || d.externalId !== null || d.knowledgeBaseId !== i.knowledgeBaseId
      );
    };
    const matchOf = (i: (typeof items)[number]): ReviewerMatch => {
      const doc = docRef(i.matchedDocumentId);
      if (doc) return { kind: "document", document: doc };
      const m = matchedItems.find((x) => x.id === i.matchedItemId);
      return m
        ? {
            kind: "suggestion",
            id: String(m.id),
            status: m.status,
            title: m.proposedTitle,
            content: m.proposedContent,
          }
        : null;
    };

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
      reviewerComment: i.reviewerComment,
      replacesDocument: docRef(i.replacesDocumentId),
      replaceUnavailable: replaceUnavailable(i),
      match: view === "discarded" ? matchOf(i) : null,
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
  embedText?: EmbedSuggestionText;
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
  const edited = await runScopedOn(base, params.ctx, async (db) => {
    // NOTE: LOCKED and read before the write, because WHICH fields moved is what the row carries and
    // two reviewers editing the same proposal would otherwise each report the other's change as
    // their own.
    await db.$queryRaw`SELECT id FROM approval_queue_items WHERE id = ${params.id} FOR UPDATE`;
    const current = await db.approvalQueueItem.findFirst({
      where: { id: params.id, status: { in: ["PENDING", "EDITED"] } },
      select: {
        status: true,
        knowledgeBaseId: true,
        proposedTitle: true,
        proposedContent: true,
        rationale: true,
      },
    });
    if (!current) return { result: "not-pending" as const, reembed: null };
    const before = current as unknown as Record<string, unknown>;
    const fields = Object.keys(patch)
      .filter((k) => patch[k] !== before[k])
      .sort();
    // A form re-submitted unchanged reaches here with every field equal, and the status is not a
    // change of its own: an item marked EDITED because somebody opened it and saved it back says a
    // human rewrote a proposal they did not touch.
    if (fields.length === 0)
      return { result: "updated" as const, reembed: null };
    const res = await db.approvalQueueItem.updateMany({
      where: { id: params.id, status: { in: ["PENDING", "EDITED"] } },
      data: { ...patch, status: "EDITED" },
    });
    const contentMoved = res.count > 0 && fields.includes("proposedContent");
    // NOTE: The vector of the old text goes with it, so until the new one is stored the item is
    // simply not a candidate, never one ranked by text the reviewer will not read.
    if (contentMoved) {
      await db.$executeRaw`
        UPDATE approval_queue_items SET embedding = NULL WHERE id = ${params.id}`;
    }
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
    return {
      result: res.count > 0 ? ("updated" as const) : ("not-pending" as const),
      reembed: contentMoved
        ? {
            knowledgeBaseId: current.knowledgeBaseId,
            content: params.proposedContent as string,
          }
        : null,
    };
  });
  if (edited.reembed) {
    await reembedEditedSuggestion(
      params,
      base,
      edited.reembed.knowledgeBaseId,
      edited.reembed.content,
    );
  }
  return edited.result;
}

// Best effort and outside the edit's transaction: a provider call must not hold the row lock, and a
// failure leaves the item without a vector (not a candidate) rather than failing the person's edit.
// Guarded on the text, so an edit that landed meanwhile is not given this one's vector.
async function reembedEditedSuggestion(
  params: EditApprovalParams,
  base: PrismaClient,
  knowledgeBaseId: bigint,
  content: string,
): Promise<void> {
  const tenantId = params.ctx.tenantId as bigint;
  try {
    const embed = params.embedText ?? suggestionEmbedder(base, tenantId);
    const vector = toVectorLiteral(await embed(knowledgeBaseId, content));
    await runScopedOn(
      base,
      params.ctx,
      (db) =>
        db.$executeRaw`
        UPDATE approval_queue_items SET embedding = ${vector}::vector
         WHERE id = ${params.id} AND proposed_content = ${content}`,
    );
  } catch (err) {
    logger.warn(
      { err },
      "approval %s: the edited text could not be embedded; it is not a review candidate",
      String(params.id),
    );
  }
}

export type ApproveResult =
  | { outcome: "approved"; chunks: number; replacedDocumentId?: string }
  // The reviewer named a document to replace and it can no longer be replaced (deleted, or owned by
  // a source sync); nothing was claimed, so the person can approve it as a new document instead.
  | { outcome: "replace-unavailable" }
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
  replacesDocumentId: bigint | null;
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
        replaces_document_id: bigint | null;
      }[]
    >`
      UPDATE approval_queue_items
         SET status = 'APPROVED', updated_at = now()
       WHERE id = ${id}
         AND status IN ('PENDING', 'EDITED')
      RETURNING knowledge_base_id, proposed_title, proposed_content, replaces_document_id
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
    replacesDocumentId: row.replaces_document_id,
  };
}

export async function approveApprovalItem(params: {
  ctx: TenantContext;
  id: bigint;
  demoMode?: boolean;
  // Ignore the reviewer's replacement and store the proposal as a document of its own.
  asNew?: boolean;
  base?: PrismaClient;
}): Promise<ApproveResult> {
  const base = params.base ?? basePrisma;
  const { ctx } = params;

  // Phase 1 (scoped read): does this item exist, is it still claimable, and does its base still
  // exist — the checks that decide WHETHER to claim.
  //
  // NOTE: The text is deliberately NOT selected here. If phase 3 stored a copy read now, it would be
  // a lost update the moment a second reviewer can edit: the revision lands between this
  // read and the claim, the claim accepts it (EDITED is claimable) and the stale copy is what gets
  // embedded. Not reading it here is what makes that impossible to reintroduce — the only text in
  // scope is the one the claim itself returns.
  const loaded = await runScopedOn(base, ctx, async (db) => {
    const item = await db.approvalQueueItem.findUnique({
      where: { id: params.id },
      select: {
        id: true,
        status: true,
        knowledgeBaseId: true,
        replacesDocumentId: true,
      },
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
    if (item.replacesDocumentId !== null && !params.asNew) {
      const target = await db.knowledgeDocument.findFirst({
        where: {
          id: item.replacesDocumentId,
          knowledgeBaseId: item.knowledgeBaseId,
          externalId: null,
        },
        select: { id: true },
      });
      if (!target) return { kind: "replace-unavailable" as const };
    }
    return { kind: "ok" as const, item };
  });
  if (loaded.kind === "not-found") return { outcome: "not-found" };
  if (loaded.kind === "not-pending") return { outcome: "not-pending" };
  if (loaded.kind === "replace-unavailable") {
    return { outcome: "replace-unavailable" };
  }

  // Phase 2: CAS-claim the approval (exactly-once) AND read the text in the same statement.
  //
  // NOTE: The content used to come from the phase-1 snapshot, which is a lost update as soon as a
  // second reviewer can edit: A starts approving and reads the hedged text, B saves a revision (the
  // row becomes EDITED, which the claim still accepts), A claims and stores its stale snapshot. Both
  // are told it worked and the un-revised text is what got embedded — precisely the outcome the
  // review exists to prevent. `RETURNING` makes the claim and the read one operation, so whatever the row
  // holds at claim time is what is approved.
  const claimed = await claimApprovalForStorage(ctx, params.id, base);
  if (!claimed) return { outcome: "not-pending" };

  // Phase 3: replace the document the reviewer named, or create one; either enqueues RAG_INGEST
  // (or skips it in demo mode). A replacement target that vanished between the check above and here
  // falls back to a new document: the claim already won, and the text must land somewhere.
  const replaceId = params.asNew ? null : claimed.replacesDocumentId;
  let doc: { id: bigint } | null = null;
  if (replaceId !== null) {
    try {
      doc = await updateDocument(
        ctx,
        replaceId,
        {
          ...(claimed.proposedTitle ? { title: claimed.proposedTitle } : {}),
          text: claimed.proposedContent,
        },
        base,
      );
    } catch (err) {
      if (!replacementTargetGone(err)) throw err;
      logger.warn(
        { err },
        "approval %s: the document to replace is gone, storing it as a new one",
        String(params.id),
      );
    }
  }
  const replaced = doc !== null;
  doc ??= await createDocument({
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

  return replaced
    ? { outcome: "approved", chunks: 0, replacedDocumentId: String(doc.id) }
    : { outcome: "approved", chunks: 0 };
}

// Whether an `updateDocument` failure means the document can no longer be replaced: deleted
// (NotFound) or taken over by a source sync (Conflict), both refused before anything is written.
// Any other failure may come after the update committed (the reindex enqueue), and falling back to
// a new document then would store the same text twice.
export function replacementTargetGone(err: unknown): boolean {
  return err instanceof NotFoundError || err instanceof ConflictError;
}

export const REJECTION_REASON_MAX = 1_000;

// The reason as it will be stored, or a refusal: trimmed, empty as none, storable, and within the
// cap. Shared with the MCP preview, which must refuse what the apply would.
export function checkedRejectionReason(raw: string | undefined): string | null {
  const reason = raw?.trim() || null;
  refuseUnstorable([["reason", reason ?? undefined]]);
  if (reason !== null && reason.length > REJECTION_REASON_MAX) {
    throw new AppError(
      `reason is longer than ${REJECTION_REASON_MAX} characters`,
      422,
    );
  }
  return reason;
}

export async function rejectApprovalItem(params: {
  ctx: TenantContext;
  id: bigint;
  // Why, in the person's words. Optional; the suggestion reviewer reads it beside the rejected text
  // so a corrected claim is not held back by the refusal of a wrong one.
  reason?: string;
  base?: PrismaClient;
}): Promise<"rejected" | "not-pending"> {
  const base = params.base ?? basePrisma;
  const reason = checkedRejectionReason(params.reason);
  return runScopedOn(base, params.ctx, async (db) => {
    const res = await db.approvalQueueItem.updateMany({
      where: { id: params.id, status: { in: ["PENDING", "EDITED"] } },
      data: { status: "REJECTED", rejectionReason: reason },
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

// A proposal the reviewer discarded, sent to the pending list by a person who disagrees. No audit
// line, like the proposal itself: nothing in the base changed, and the decision on it is still
// ahead. The status in the WHERE makes a second click, or a stale screen, a no-op.
export async function requeueDiscardedItem(params: {
  ctx: TenantContext;
  id: bigint;
  base?: PrismaClient;
}): Promise<"requeued" | "not-discarded"> {
  const base = params.base ?? basePrisma;
  return runScopedOn(base, params.ctx, async (db) => {
    const res = await db.approvalQueueItem.updateMany({
      where: { id: params.id, status: "DISCARDED" },
      data: { status: "PENDING" },
    });
    return res.count > 0 ? "requeued" : "not-discarded";
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
  stripContactFooters: boolean;
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
        // NOTE: the pair `listKnowledgeBases` returns; the MCP preview measures a chunking patch
        // against it.
        chunkSize: true,
        chunkOverlap: true,
        stripContactFooters: true,
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
  stripContactFooters?: boolean;
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
        ...(params.stripContactFooters !== undefined
          ? { stripContactFooters: params.stripContactFooters }
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
