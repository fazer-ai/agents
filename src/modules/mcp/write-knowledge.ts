import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { firstUnstorableField } from "@/lib/text";
import { truncForAudit } from "@/modules/audit/projection";
import {
  createDocument,
  deleteDocument,
  type EmbeddingBlock,
  getDocument,
  reindexKnowledgeBase,
  retryDocument,
} from "@/modules/rag/documents";
import {
  approveApprovalItem,
  createKnowledgeBase,
  deleteKnowledgeBase,
  editApprovalItem,
  getKnowledgeBase,
  listPendingApprovals,
  rejectApprovalItem,
  updateKnowledgeBase,
} from "@/modules/rag/service";
import { vaultFillUrl } from "./console-links";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  parseMcpId,
  recordMcpAudit,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP knowledge write tools: knowledge bases, document ingestion (by TEXT — binary upload
// stays UI-only), and the suggestion-approval queue. Spine: gate (mcp:write + tenant) → dry-run
// preview by default → apply + audit. No secrets here, so no credential resolution.

// The storability rule, asked HERE and not left to the core, because a dry run never reaches the
// core: it answers "this would work" off the arguments alone. A text the column cannot hold would
// preview clean and then fail on apply, which is the one thing a dry run exists to prevent. The
// pure form is used rather than the core's throwing wrapper, because what a refusal looks like is
// the transport's question and here it is a WriteResult, not an exception (issue #247).
function unstorable(
  fields: readonly (readonly [string, string | null | undefined])[],
): WriteResult | null {
  const bad = firstUnstorableField(fields);
  // The sentence, not the parts: an MCP error is a single string an English-speaking client reads,
  // with no place to interpolate and no language to negotiate.
  return bad ? err(bad.message) : null;
}

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

// What an MCP caller is told to do about each embedding block, one entry per reason. A Record rather
// than a chain of comparisons: the key type is the block's own vocabulary, so a reason added to the
// core is a compile error here instead of quietly collapsing into whichever branch came last — which
// is how `credential_empty` came to be announced as "never filled in" (review finding, round 6).
const EMBEDDING_BLOCK_NOTES: Record<EmbeddingBlock["reason"], string> = {
  embedding_not_configured:
    "Embedding is not configured for this tenant. Set tenant embedding settings (provider/model/credential) via tenant_settings_update, then re-run.",
  credential_pending:
    "The embedding credential's secret is not filled yet. Open fillAt in the console to paste it, then re-run.",
  credential_empty:
    "The embedding credential exists and is active, but its secret is blank. Open fillAt in the console and replace it, then re-run.",
};

// ── knowledge bases ──

export async function knowledgeCreate(
  principal: VerifiedToken,
  args: {
    name: string;
    description?: string;
    embedding_model?: string;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const bad = unstorable([
    ["name", args.name],
    ["description", args.description],
    ["embedding_model", args.embedding_model],
  ]);
  if (bad) return bad;
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "knowledge_base",
        preview: {
          name: args.name,
          description: args.description ?? null,
          embeddingModel: args.embedding_model ?? "(tenant default)",
        },
      });
    }
    const created = await createKnowledgeBase({
      ctx,
      name: args.name,
      description: args.description,
      embeddingModel: args.embedding_model,
      base,
    });
    const target = `knowledge_base:${created.id}`;
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "knowledge.create",
      target,
      before: null,
      after: truncForAudit({ id: String(created.id), name: args.name }),
    });
    return ok({ dryRun: false, applied: true, id: String(created.id), target });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeUpdate(
  principal: VerifiedToken,
  args: {
    knowledge_base_id: string;
    name?: string;
    description?: string | null;
    chunk_size?: number;
    chunk_overlap?: number;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof id !== "bigint") return id;
  const patch: {
    name?: string;
    description?: string | null;
    chunkSize?: number;
    chunkOverlap?: number;
  } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.description !== undefined) patch.description = args.description;
  if (args.chunk_size !== undefined) patch.chunkSize = args.chunk_size;
  if (args.chunk_overlap !== undefined) patch.chunkOverlap = args.chunk_overlap;
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (name, description, chunk_size, chunk_overlap)",
    );
  }
  const bad = unstorable([
    ["name", args.name],
    ["description", args.description],
  ]);
  if (bad) return bad;
  try {
    const current = await getKnowledgeBase({ ctx, id, base });
    const target = `knowledge_base:${id}`;
    const beforeProj = {
      name: current.name,
      description: current.description,
    };
    if (args.dry_run !== false) {
      const previewAfter = {
        name: patch.name ?? current.name,
        description:
          patch.description === undefined
            ? current.description
            : patch.description,
      };
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, previewAfter),
      });
    }
    await updateKnowledgeBase({ ctx, id, ...patch, base });
    const after = await getKnowledgeBase({ ctx, id, base });
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "knowledge.update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit({
        name: after.name,
        description: after.description,
      }),
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeDelete(
  principal: VerifiedToken,
  args: { knowledge_base_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getKnowledgeBase({ ctx, id, base });
    const target = `knowledge_base:${id}`;
    const beforeProj = { id: String(current.id), name: current.name };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteKnowledgeBase({ ctx, id, base });
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "knowledge.delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// ── documents (text ingestion; binary upload stays UI-only) ──

export async function knowledgeDocumentCreate(
  principal: VerifiedToken,
  args: {
    knowledge_base_id: string;
    title: string;
    text: string;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const kbId = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof kbId !== "bigint") return kbId;
  const bad = unstorable([
    ["title", args.title],
    ["text", args.text],
  ]);
  if (bad) return bad;
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "knowledge_document",
        preview: {
          knowledgeBaseId: String(kbId),
          title: args.title,
          textChars: args.text.length,
        },
      });
    }
    const created = await createDocument({
      ctx,
      knowledgeBaseId: kbId,
      title: args.title,
      text: args.text,
      sourceType: "text",
      base,
    });
    const target = `knowledge_document:${created.id}`;
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "knowledge_document.create",
      target,
      before: null,
      after: truncForAudit({
        id: String(created.id),
        knowledgeBaseId: String(kbId),
        title: args.title,
      }),
    });
    return ok({
      dryRun: false,
      applied: true,
      id: String(created.id),
      status: created.status,
      note: "Document queued for embedding (async); poll knowledge_documents_list for status.",
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeDocumentDelete(
  principal: VerifiedToken,
  args: { document_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.document_id, "document_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getDocument(ctx, id, base);
    const target = `knowledge_document:${id}`;
    const beforeProj = { id: String(current.id), title: current.title };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteDocument(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "knowledge_document.delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeDocumentRetry(
  principal: VerifiedToken,
  args: { document_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.document_id, "document_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getDocument(ctx, id, base);
    const target = `knowledge_document:${id}`;
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "retry",
        target,
        currentStatus: current.status,
        note: "Re-queues a FAILED document for embedding.",
      });
    }
    await retryDocument(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "knowledge_document.retry",
      target,
      before: truncForAudit({ status: current.status }),
      after: truncForAudit({ status: "PENDING" }),
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// Bulk re-index a whole base in one call (the "index all" for an imported base). If the tenant's
// embedding credential is unconfigured or its secret is not filled yet, nothing is queued and the
// result is `blocked` (with a fillAt deeplink for a pending credential) — a missing prerequisite, not
// an error. include_failed also recovers genuine FAILED docs (a batched per-document retry).
export async function knowledgeReindex(
  principal: VerifiedToken,
  args: {
    knowledge_base_id: string;
    include_failed?: boolean;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const tenantId = ctx.tenantId as bigint;
  const id = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof id !== "bigint") return id;
  const target = `knowledge_base:${id}`;
  try {
    const dryRun = args.dry_run !== false;
    const result = await reindexKnowledgeBase(ctx, id, base, {
      includeFailed: args.include_failed === true,
      dryRun,
    });
    if (result.blocked) {
      const fillAt =
        result.blocked.vaultId != null
          ? vaultFillUrl(tenantId, result.blocked.vaultId)
          : undefined;
      return ok({
        dryRun,
        applied: false,
        target,
        queued: 0,
        blocked: result.blocked.reason,
        credentialRef: result.blocked.credentialRef,
        fillAt,
        note: EMBEDDING_BLOCK_NOTES[result.blocked.reason],
      });
    }
    if (dryRun) {
      return ok({
        dryRun: true,
        target,
        wouldQueue: result.queued,
        note: "Re-queues UNINDEXED documents (add include_failed to also recover FAILED). Acts ONLY when dry_run is false.",
      });
    }
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "knowledge.reindex",
      target,
      before: {},
      after: truncForAudit({
        queued: result.queued,
        includeFailed: args.include_failed === true,
      }),
    });
    return ok({ dryRun: false, applied: true, target, queued: result.queued });
  } catch (e) {
    return failOf(e);
  }
}

// ── suggestion approval queue ──

async function findApproval(
  ctx: TenantContext,
  id: bigint,
  base: Parameters<typeof listPendingApprovals>[1],
) {
  const all = await listPendingApprovals(ctx, base);
  return all.find((a) => a.id === String(id)) ?? null;
}

export async function knowledgeApprove(
  principal: VerifiedToken,
  args: { approval_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.approval_id, "approval_id");
  if (typeof id !== "bigint") return id;
  const target = `approval:${id}`;
  try {
    if (args.dry_run !== false) {
      const item = await findApproval(ctx, id, base);
      if (!item) return err("approval not found or not pending");
      return ok({
        dryRun: true,
        action: "approve",
        target,
        proposedTitle: item.proposedTitle,
        knowledgeBaseId: item.knowledgeBaseId,
      });
    }
    const result = await approveApprovalItem({ ctx, id, base });
    if (result.outcome === "approved") {
      await recordMcpAudit(ctx, base, {
        actorId: principal.userId,
        actorType: "mcp",
        action: "knowledge.approve",
        target,
        before: null,
        after: truncForAudit({
          outcome: result.outcome,
          chunks: result.chunks,
        }),
      });
    }
    return ok({ dryRun: false, applied: true, target, result });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeReject(
  principal: VerifiedToken,
  args: { approval_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.approval_id, "approval_id");
  if (typeof id !== "bigint") return id;
  const target = `approval:${id}`;
  try {
    if (args.dry_run !== false) {
      const item = await findApproval(ctx, id, base);
      if (!item) return err("approval not found or not pending");
      return ok({
        dryRun: true,
        action: "reject",
        target,
        proposedTitle: item.proposedTitle,
      });
    }
    const outcome = await rejectApprovalItem({ ctx, id, base });
    if (outcome === "rejected") {
      await recordMcpAudit(ctx, base, {
        actorId: principal.userId,
        actorType: "mcp",
        action: "knowledge.reject",
        target,
        before: null,
        after: truncForAudit({ outcome }),
      });
    }
    return ok({ dryRun: false, applied: true, target, outcome });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeEdit(
  principal: VerifiedToken,
  args: {
    approval_id: string;
    title?: string;
    content?: string;
    rationale?: string;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.approval_id, "approval_id");
  if (typeof id !== "bigint") return id;
  if (
    args.title === undefined &&
    args.content === undefined &&
    args.rationale === undefined
  ) {
    return err("no updatable fields provided (title, content, rationale)");
  }
  const bad = unstorable([
    ["title", args.title],
    ["content", args.content],
    ["rationale", args.rationale],
  ]);
  if (bad) return bad;
  const target = `approval:${id}`;
  try {
    if (args.dry_run !== false) {
      const item = await findApproval(ctx, id, base);
      if (!item) return err("approval not found or not pending");
      return ok({
        dryRun: true,
        action: "edit",
        target,
        next: {
          title: args.title ?? item.proposedTitle,
          rationale: args.rationale ?? item.rationale,
        },
      });
    }
    const outcome = await editApprovalItem({
      ctx,
      id,
      proposedTitle: args.title,
      proposedContent: args.content,
      rationale: args.rationale,
      base,
    });
    if (outcome === "updated") {
      await recordMcpAudit(ctx, base, {
        actorId: principal.userId,
        actorType: "mcp",
        action: "knowledge.edit",
        target,
        before: null,
        after: truncForAudit({ outcome, title: args.title }),
      });
    }
    return ok({ dryRun: false, applied: true, target, outcome });
  } catch (e) {
    return failOf(e);
  }
}
