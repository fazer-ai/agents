import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { firstUnstorableField } from "@/lib/text";
import {
  assertChunkingUpdatable,
  assertDocumentNotSynced,
  assertDocumentRetryable,
  createDocument,
  deleteDocument,
  type EmbeddingBlock,
  getDocument,
  reindexKnowledgeBase,
  retryDocument,
  updateDocument,
} from "@/modules/rag/documents";
import {
  approveApprovalItem,
  assertKnowledgeBaseNameUsable,
  createKnowledgeBase,
  deleteKnowledgeBase,
  editApprovalItem,
  getKnowledgeBase,
  listPendingApprovals,
  rejectApprovalItem,
  updateKnowledgeBase,
} from "@/modules/rag/service";
import {
  deleteSource,
  getSource,
  parseSourceInput,
  requestSync,
  setSource,
} from "@/modules/rag/source";
import { vaultFillUrl } from "./console-links";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  parseMcpId,
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
    strip_contact_footers?: boolean;
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
      // NOTE: the core's own question, asked before the preview answers it, and INSIDE the branch
      // because the apply reaches the core, which asks it again (#490). Pure: it reads no row.
      assertKnowledgeBaseNameUsable(args.name);
      return ok({
        dryRun: true,
        action: "create",
        resource: "knowledge_base",
        preview: {
          name: args.name,
          description: args.description ?? null,
          embeddingModel: args.embedding_model ?? "(tenant default)",
          stripContactFooters: args.strip_contact_footers ?? false,
        },
      });
    }
    const created = await createKnowledgeBase({
      ctx,
      name: args.name,
      description: args.description,
      embeddingModel: args.embedding_model,
      stripContactFooters: args.strip_contact_footers,
      base,
    });
    const target = `knowledge_base:${created.id}`;
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
    strip_contact_footers?: boolean;
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
    stripContactFooters?: boolean;
  } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.description !== undefined) patch.description = args.description;
  if (args.chunk_size !== undefined) patch.chunkSize = args.chunk_size;
  if (args.chunk_overlap !== undefined) patch.chunkOverlap = args.chunk_overlap;
  if (args.strip_contact_footers !== undefined)
    patch.stripContactFooters = args.strip_contact_footers;
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (name, description, chunk_size, chunk_overlap, strip_contact_footers)",
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
      chunkSize: current.chunkSize,
      chunkOverlap: current.chunkOverlap,
      stripContactFooters: current.stripContactFooters,
    };
    if (args.dry_run !== false) {
      assertKnowledgeBaseNameUsable(patch.name);
      // NOTE: ADVISORY, and deliberately so: the bound is a fact about the row, and this read is outside
      // the transaction the apply validates in, so a concurrent update can move the pair between the
      // two halves. What it buys is that the ordinary case — an operator sending one of the two
      // numbers — gets the same answer here as it will get there, instead of an approved preview of
      // a write that cannot happen (#490, #524).
      assertChunkingUpdatable(current, patch);
      const previewAfter = {
        name: patch.name ?? current.name,
        description:
          patch.description === undefined
            ? current.description
            : patch.description,
        chunkSize: patch.chunkSize ?? current.chunkSize,
        chunkOverlap: patch.chunkOverlap ?? current.chunkOverlap,
        stripContactFooters:
          patch.stripContactFooters ?? current.stripContactFooters,
      };
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, previewAfter),
      });
    }
    await updateKnowledgeBase({ ctx, id, ...patch, base });
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
      // NOTE: the core's own question, asked before the preview answers it. It sits INSIDE the
      // branch rather than above it because the apply reaches the core, which asks it again —
      // and several of these read a row or resolve DNS, so above the branch is a second lookup
      // that can even disagree with the first (#490).
      await getKnowledgeBase({ ctx, id: kbId, base });
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
    return ok({
      dryRun: false,
      applied: true,
      target: `knowledge_document:${created.id}`,
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
      await assertDocumentNotSynced(ctx, id, base);
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteDocument(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// Edit a document in place (issue #708), the twin of `PATCH /v1/knowledge/documents/:id`. Without it
// an MCP client concluded that editing meant delete and recreate, which loses the id (and with it any
// sync that reconciles by id) and leaves the document out of search while it re-embeds. A changed
// text re-ingests; a title alone does not.
export async function knowledgeDocumentUpdate(
  principal: VerifiedToken,
  args: {
    document_id: string;
    title?: string;
    text?: string;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.document_id, "document_id");
  if (typeof id !== "bigint") return id;
  if (args.title === undefined && args.text === undefined) {
    return err("nothing to update: pass title and/or text");
  }
  // The REST twin's `minLength: 1` on both fields, asked here because the service does not: an empty
  // text would replace the content and the next ingest would drop every chunk (review round 3).
  if (args.title === "" || args.text === "") {
    return err("title and text, when given, must not be empty");
  }
  const bad = unstorable([
    ["title", args.title],
    ["text", args.text],
  ]);
  if (bad) return bad;
  try {
    const current = await getDocument(ctx, id, base);
    const target = `knowledge_document:${id}`;
    if (args.dry_run !== false) {
      await assertDocumentNotSynced(ctx, id, base);
      return ok({
        dryRun: true,
        action: "update",
        target,
        current: {
          title: current.title,
          contentChars: current.content.length,
        },
        after: {
          title: args.title ?? current.title,
          contentChars: (args.text ?? current.content).length,
        },
        // The same question the service asks, on the text it already has: an unchanged body is not
        // re-embedded, so the preview does not promise a re-index the apply will not do.
        reindexes: args.text !== undefined && args.text !== current.content,
      });
    }
    const doc = await updateDocument(
      ctx,
      id,
      { title: args.title, text: args.text },
      base,
    );
    return ok({
      dryRun: false,
      applied: true,
      target,
      status: doc.status,
    });
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
      // NOTE: the core's own question, on the status this preview already had in hand. Reporting it
      // in the note below is not asking it: a document that is INDEXED read back "would re-queue"
      // and the apply answered 409 (#510).
      assertDocumentRetryable(current.status);
      return ok({
        dryRun: true,
        action: "retry",
        target,
        currentStatus: current.status,
        note: "Re-queues a FAILED document for embedding.",
      });
    }
    await retryDocument(ctx, id, base);
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
    return ok({ dryRun: false, applied: true, target, outcome });
  } catch (e) {
    return failOf(e);
  }
}

// The base's help center source (issue #794): the twins of PUT/DELETE /v1/knowledge/bases/:id/source
// and POST .../source/sync. Same spine: the preview asks the questions the apply asks (the input is
// parsed, the SSRF check included, and the base must exist) and changes nothing.
export async function knowledgeSourceSet(
  principal: VerifiedToken,
  args: {
    knowledge_base_id: string;
    kind: string;
    base_url: string;
    slug: string;
    locale: string;
    exclude_ids?: number[];
    interval_minutes?: number;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof id !== "bigint") return id;
  const target = `knowledge_base:${id}`;
  const input = {
    kind: args.kind,
    baseUrl: args.base_url,
    slug: args.slug,
    locale: args.locale,
    excludeIds: args.exclude_ids,
    intervalMinutes: args.interval_minutes,
  };
  try {
    if (args.dry_run !== false) {
      await getKnowledgeBase({ ctx, id, base });
      const parsed = await parseSourceInput(input);
      const current = await getSource(ctx, id, base);
      return ok({
        dryRun: true,
        action: current ? "replace_source" : "set_source",
        target,
        current,
        after: {
          kind: parsed.kind,
          ...parsed.config,
          intervalMinutes: parsed.intervalMinutes,
        },
        note: "Arms a sync right away. Documents without an external id are never touched.",
      });
    }
    const source = await setSource(ctx, id, input, base);
    return ok({ dryRun: false, applied: true, target, source });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeSourceSync(
  principal: VerifiedToken,
  args: { knowledge_base_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof id !== "bigint") return id;
  const target = `knowledge_base:${id}`;
  try {
    if (args.dry_run !== false) {
      await getKnowledgeBase({ ctx, id, base });
      const current = await getSource(ctx, id, base);
      if (!current) return err("knowledge base has no source to sync");
      return ok({ dryRun: true, action: "sync_source", target, current });
    }
    await requestSync(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function knowledgeSourceRemove(
  principal: VerifiedToken,
  args: { knowledge_base_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseMcpId(args.knowledge_base_id, "knowledge_base_id");
  if (typeof id !== "bigint") return id;
  const target = `knowledge_base:${id}`;
  try {
    if (args.dry_run !== false) {
      await getKnowledgeBase({ ctx, id, base });
      const current = await getSource(ctx, id, base);
      if (!current) return err("knowledge base has no source");
      return ok({
        dryRun: true,
        action: "remove_source",
        target,
        current,
        note: "Stops the sync. The synced documents stay, with their external ids.",
      });
    }
    await deleteSource(ctx, id, base);
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}
