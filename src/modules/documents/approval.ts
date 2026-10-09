import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { clipText, makeStorable } from "@/lib/text";
import { auditMutation } from "@/modules/audit/service";
import { upsertJobRow } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { type DocumentStyle, parseDocumentStyle } from "./blocks";
import { formatDate } from "./format";
import {
  APPROVAL_KEY_PREFIX,
  type DocumentSnapshot,
  documentFileName,
  type FrozenDocument,
  freezeDocumentSnapshot,
  type IssuedDocumentResult,
  issueDocument,
  issueFrozenDocument,
  printedDate,
  sysCtx,
} from "./issue";
import { renderDocumentPdf } from "./render";
import { readRenderContext } from "./templates";

// A document a person approves before the customer gets it (docs/documents.md, Approval). The
// request freezes the document with its date when the agent asks; approval issues that snapshot and
// only then takes a number, so a rejected or expired request burns none.

export type ApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED";

// Printed where the number goes on a preview. Text, not a fake number: a reviewer who saw ORC-0042
// would expect that number on the document approval issues, and the counter may have moved by then.
const NUMBER_PLACEHOLDER: Record<DocumentStyle["locale"], string> = {
  "pt-BR": "(numerado na aprovação)",
  "en-US": "(numbered on approval)",
};

export interface ApprovalRequestDto {
  id: string;
  templateId: string | null;
  title: string;
  status: ApprovalStatus;
  threadId: string | null;
  conversationId: string | null;
  expiresAt: Date;
  reviewerUserId: string | null;
  note: string | null;
  decidedAt: Date | null;
  issuedDocumentId: string | null;
  createdAt: Date;
}

const SELECT = {
  id: true,
  templateId: true,
  title: true,
  numberPrefix: true,
  status: true,
  threadId: true,
  idempotencyKey: true,
  chatwootInstanceId: true,
  conversationId: true,
  expiresAt: true,
  reviewerUserId: true,
  note: true,
  decidedAt: true,
  issuedDocumentId: true,
  createdAt: true,
} as const;

type Row = Prisma.DocumentApprovalRequestGetPayload<{
  select: typeof SELECT;
}>;

// The frozen snapshot can run to megabytes, so only preview and issuance read it.
const WITH_SNAPSHOT = { ...SELECT, snapshot: true } as const;

function toDto(r: Row): ApprovalRequestDto {
  return {
    id: String(r.id),
    templateId: r.templateId === null ? null : String(r.templateId),
    title: r.title,
    status: r.status as ApprovalStatus,
    threadId: r.threadId,
    conversationId: r.conversationId === null ? null : String(r.conversationId),
    expiresAt: r.expiresAt,
    reviewerUserId: r.reviewerUserId === null ? null : String(r.reviewerUserId),
    note: r.note,
    decidedAt: r.decidedAt,
    issuedDocumentId:
      r.issuedDocumentId === null ? null : String(r.issuedDocumentId),
    createdAt: r.createdAt,
  };
}

// What a decided or expired request says in its conversation is a job armed by the transition
// itself, one per request: only the call that moved the status (or linked the approved document)
// arms it, so a repeated decision answers nothing twice.
export function outcomeJobKey(requestId: bigint): string {
  return `doc-approval-outcome:${requestId}`;
}

async function armApprovalOutcome(
  db: ScopedDb,
  tenantId: bigint,
  requestId: bigint,
  now: Date,
): Promise<void> {
  await upsertJobRow(db, {
    tenantId,
    kind: "DOCUMENT_APPROVAL_OUTCOME",
    dedupeKey: outcomeJobKey(requestId),
    runAt: now,
    rearm: "new-work",
    payload: { requestId: String(requestId) },
  });
}

function notFound(): NotFoundError {
  return new NotFoundError(
    "document approval request not found",
    "errors.documentApprovalNotFound",
  );
}

// One tool key ends in ONE outcome, a document or a request, and each lives in its own table with
// its own unique index. Both writers take this lock and re-ask the other table before inserting, so
// two calls racing a switch of `requiresApproval` cannot leave one of each.
async function claimKey(
  db: ScopedDb,
  tenantId: bigint,
  idempotencyKey: string,
): Promise<void> {
  await withEntityLock(
    db,
    `document-key:${tenantId}:${idempotencyKey}`,
    async () => {},
  );
}

// The key was answered by the other outcome while this call was deciding.
export class KeyAnswered extends Error {
  constructor(readonly by: "document" | "request") {
    super(`this key is already answered by a ${by}`);
  }
}

export function expiryJobKey(requestId: bigint): string {
  return `doc-approval:${requestId}`;
}

// The request for a frozen document. The key is the tool's, so a retried turn lands on the request it
// already made: a second insert loses on the unique and the first one is returned.
export async function createApprovalRequest(params: {
  ctx: TenantContext;
  base?: PrismaClient;
  frozen: FrozenDocument;
  idempotencyKey: string;
  threadId?: string | null;
  chatwootInstanceId?: bigint | null;
  conversationId?: bigint | null;
  now: Date;
}): Promise<ApprovalRequestDto> {
  const base = params.base ?? basePrisma;
  const { ctx, frozen } = params;
  const tenantId = ctx.tenantId as bigint;
  const expiresAt = new Date(
    params.now.getTime() + frozen.template.approvalTtlHours * 3_600_000,
  );
  // One transaction for the request and its expiry job: a request committed without the job would
  // stay PENDING past its time, and a retried turn returns the request before it could re-arm.
  const created = await runScopedOn(base, ctx, async (db) => {
    await claimKey(db, tenantId, params.idempotencyKey);
    const issued = await db.issuedDocument.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId,
          idempotencyKey: params.idempotencyKey,
        },
      },
      select: { id: true },
    });
    if (issued) throw new KeyAnswered("document");
    const row = await db.documentApprovalRequest.create({
      data: {
        tenantId,
        templateId: frozen.template.id,
        title: frozen.template.name,
        numberPrefix: frozen.template.numberPrefix,
        threadId: params.threadId ?? null,
        chatwootInstanceId: params.chatwootInstanceId ?? null,
        conversationId: params.conversationId ?? null,
        idempotencyKey: params.idempotencyKey,
        status: "PENDING",
        snapshot: frozen.snapshot as unknown as Prisma.InputJsonValue,
        expiresAt,
      },
      select: SELECT,
    });
    await upsertJobRow(db, {
      tenantId,
      kind: "DOCUMENT_APPROVAL_EXPIRY",
      dedupeKey: expiryJobKey(row.id),
      runAt: expiresAt,
      rearm: "new-work",
    });
    return row;
  }).catch((err: unknown) => {
    if (err instanceof KeyAnswered) throw err;
    // NOTE: a P2002 aborts the transaction it was raised in, so the winner is read in a new one.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return null;
    }
    // NOTE: the template deleted after it was read: the same event as "no such template", and the
    // same terminal answer issuance gives it.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2003"
    ) {
      throw new NotFoundError(
        "document template not found",
        "errors.documentTemplateNotFound",
      );
    }
    throw err;
  });
  if (created) return toDto(created);
  const existing = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId,
          idempotencyKey: params.idempotencyKey,
        },
      },
      select: SELECT,
    }),
  );
  if (!existing) {
    throw new AppError("failed to persist the approval request", 500);
  }
  return toDto(existing);
}

export async function listApprovalRequests(
  ctx: TenantContext,
  opts: { status?: ApprovalStatus; limit?: number } = {},
  base: PrismaClient = basePrisma,
): Promise<ApprovalRequestDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.findMany({
      where: opts.status ? { status: opts.status } : {},
      orderBy: { id: "desc" },
      take: Math.min(Math.max(opts.limit ?? 50, 1), 200),
      select: SELECT,
    }),
  );
  return rows.map(toDto);
}

async function loadRequest(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient,
): Promise<Row> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) throw notFound();
  return row;
}

async function loadRequestWithSnapshot(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient,
) {
  const row = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.findUnique({
      where: { id },
      select: WITH_SNAPSHOT,
    }),
  );
  if (!row) throw notFound();
  return row;
}

export async function getApprovalRequest(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ApprovalRequestDto> {
  return toDto(await loadRequest(ctx, id, base));
}

// The frozen document as the reviewer sees it, with a placeholder where the number goes. Rendered on
// demand and never stored: it is not a document, and the counter is not touched.
export async function renderApprovalPreview(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = await loadRequestWithSnapshot(ctx, id, base);
  const stored = row.snapshot as unknown as DocumentSnapshot;
  const style = parseDocumentStyle(stored.style);
  const { logo } = await readRenderContext(ctx, base);
  const bytes = await renderDocumentPdf({
    blocks: stored.blocks,
    fields: stored.fields,
    style,
    values: stored.values,
    company: stored.company,
    logo,
    meta: {
      number: NUMBER_PLACEHOLDER[style.locale],
      date: formatDate(printedDate(stored), style.locale),
      title: row.title,
    },
  });
  return { bytes, fileName: documentFileName(row.title, null) };
}

// The key the approved document is issued under. It names the request by its id AND by a digest of
// what only this request holds, so no row written before the request existed can carry it: an
// upgraded install may have documents issued under any key the REST route ever accepted.
function approvalDocumentKey(row: {
  id: bigint;
  idempotencyKey: string;
  createdAt: Date;
}): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${row.idempotencyKey}|${row.createdAt.toISOString()}`);
  return `${APPROVAL_KEY_PREFIX}${row.id}:${hasher.digest("hex")}`;
}

// A decision in the tenant's trail, written in the transaction that made it. The status only: the
// document's values and the reviewer's note are customer and team text, which the trail does not keep.
async function auditDecision(
  db: ScopedDb,
  ctx: TenantContext,
  requestId: bigint,
  status: "APPROVED" | "REJECTED",
): Promise<void> {
  await auditMutation(db, ctx, {
    action:
      status === "APPROVED"
        ? "document_approval.approve"
        : "document_approval.reject",
    target: `document_approval:${requestId}`,
    before: { status: "PENDING" },
    after: { status },
  });
}

function notPending(status: string): AppError {
  return new AppError(
    `this approval request is ${status.toLowerCase()}, not pending`,
    409,
    "errors.documentApprovalNotPending",
    { status },
  );
}

function expired(): AppError {
  return new AppError(
    "this approval request expired",
    409,
    "errors.documentApprovalExpired",
  );
}

// Approval issues the frozen snapshot under a key named for the request, not for the calendar day,
// so an approval landing tomorrow keeps the date the reviewer saw. The status is CLAIMED first
// (PENDING → APPROVED, only while unexpired): a rejection or the expiry racing it cannot both win,
// and a second approval, in parallel or later, finds APPROVED and lands on the same issued row
// through the key. A failure after the claim leaves an APPROVED request with no document, which
// approving again completes; once the document exists, approving again returns it even with the
// template deleted.
export async function approveDocumentRequest(params: {
  ctx: TenantContext;
  requestId: bigint;
  reviewerUserId?: bigint | null;
  base?: PrismaClient;
  storageDir?: string;
  now?: Date;
}): Promise<{ request: ApprovalRequestDto; document: IssuedDocumentResult }> {
  const base = params.base ?? basePrisma;
  const { ctx, requestId } = params;
  const now = params.now ?? new Date();
  const claimed = await runScopedOn(base, ctx, async (db) => {
    const r = await db.documentApprovalRequest.updateMany({
      where: { id: requestId, status: "PENDING", expiresAt: { gt: now } },
      data: {
        status: "APPROVED",
        reviewerUserId: params.reviewerUserId ?? null,
        decidedAt: now,
      },
    });
    if (r.count === 1) await auditDecision(db, ctx, requestId, "APPROVED");
    return r;
  });
  const row = await loadRequestWithSnapshot(ctx, requestId, base);
  if (claimed.count === 0 && row.status !== "APPROVED") {
    if (row.status === "PENDING") {
      await expireDueApprovalRequests(ctx.tenantId as bigint, now, base);
      throw expired();
    }
    throw notPending(row.status);
  }
  const idempotencyKey = approvalDocumentKey(row);
  const document = await issueFrozenDocument({
    ctx,
    base,
    storageDir: params.storageDir,
    templateId: row.templateId,
    title: row.title,
    numberPrefix: row.numberPrefix,
    snapshot: row.snapshot as unknown as DocumentSnapshot,
    idempotencyKey,
    threadId: row.threadId,
    chatwootInstanceId: row.chatwootInstanceId,
    conversationId: row.conversationId,
  });
  // The call that LINKS the document is the one that arms its delivery, in the same
  // transaction: approving again, in parallel or later, finds it linked and delivers nothing twice.
  const linked = await runScopedOn(base, ctx, async (db) => {
    const issued = await db.issuedDocument.findUniqueOrThrow({
      where: {
        tenantId_idempotencyKey: {
          tenantId: ctx.tenantId as bigint,
          idempotencyKey,
        },
      },
      select: { id: true },
    });
    const link = await db.documentApprovalRequest.updateMany({
      where: { id: requestId, issuedDocumentId: null },
      data: { issuedDocumentId: issued.id },
    });
    if (link.count === 1) {
      await armApprovalOutcome(db, ctx.tenantId as bigint, requestId, now);
    }
    return db.documentApprovalRequest.findUniqueOrThrow({
      where: { id: requestId },
      select: SELECT,
    });
  });
  return { request: toDto(linked), document };
}

export async function rejectDocumentRequest(params: {
  ctx: TenantContext;
  requestId: bigint;
  reviewerUserId?: bigint | null;
  note?: string | null;
  base?: PrismaClient;
  now?: Date;
}): Promise<ApprovalRequestDto> {
  const base = params.base ?? basePrisma;
  const { ctx, requestId } = params;
  const now = params.now ?? new Date();
  const note = params.note?.trim()
    ? clipText(makeStorable(params.note.trim()), 2_000)
    : null;
  const claimed = await runScopedOn(base, ctx, async (db) => {
    const r = await db.documentApprovalRequest.updateMany({
      where: { id: requestId, status: "PENDING", expiresAt: { gt: now } },
      data: {
        status: "REJECTED",
        reviewerUserId: params.reviewerUserId ?? null,
        note,
        decidedAt: now,
      },
    });
    if (r.count === 1) {
      await auditDecision(db, ctx, requestId, "REJECTED");
      await armApprovalOutcome(db, ctx.tenantId as bigint, requestId, now);
    }
    return r;
  });
  const row = await loadRequest(ctx, requestId, base);
  if (claimed.count === 0) {
    if (row.status === "PENDING") {
      await expireDueApprovalRequests(ctx.tenantId as bigint, now, base);
      throw expired();
    }
    throw notPending(row.status);
  }
  return toDto(row);
}

// Moves the tenant's overdue PENDING requests to EXPIRED and returns their ids. Idempotent: a second
// run finds nothing PENDING past its time.
export async function expireDueApprovalRequests(
  tenantId: bigint,
  now: Date = new Date(),
  base: PrismaClient = basePrisma,
): Promise<bigint[]> {
  const rows = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const expired = await db.$queryRaw<{ id: bigint }[]>`
      UPDATE "document_approval_requests"
         SET "status" = 'EXPIRED', "decided_at" = ${now}, "updated_at" = ${now}
       WHERE "tenant_id" = ${tenantId}
         AND "status" = 'PENDING'
         AND "expires_at" <= ${now}
      RETURNING "id"
    `;
    for (const r of expired) {
      await armApprovalOutcome(db, tenantId, r.id, now);
    }
    return expired;
  });
  return rows.map((r) => r.id);
}

// The line every turn of a conversation carries while one of its documents waits on the team. The
// tool result says it once, and it scrolls out of the history window, so this is what keeps the agent
// from offering the document again or promising it. It names the documents and never a time: the
// validity is how long the TEAM may take, not when the customer will receive anything.
const PENDING_NOTICE_LIMIT = 5;

export async function pendingApprovalNotice(
  tenantId: bigint,
  conversation: { conversationId: bigint | null; threadId: string },
  base: PrismaClient = basePrisma,
  now: Date = new Date(),
): Promise<string | null> {
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.documentApprovalRequest.groupBy({
      by: ["title"],
      where: {
        status: "PENDING",
        expiresAt: { gt: now },
        ...(conversation.conversationId === null
          ? { threadId: conversation.threadId }
          : { conversationId: conversation.conversationId }),
      },
      _min: { id: true },
      orderBy: { _min: { id: "asc" } },
      take: PENDING_NOTICE_LIMIT,
    }),
  );
  const titles = [
    ...new Set(
      rows.map((r) => clipText(r.title.replace(/\s+/g, " ").trim(), 80)),
    ),
  ].filter(Boolean);
  if (titles.length === 0) return null;
  const which =
    titles.length === 1
      ? `um documento aguardando a aprovação da equipe: ${titles[0]}`
      : `documentos aguardando a aprovação da equipe: ${titles.join("; ")}`;
  return `[Sistema] Nesta conversa há ${which}. Ainda não foi enviado ao cliente. Só fale disso se o cliente perguntar por esse documento: nesse caso, diga que a equipe está preparando, sem dizer quando fica pronto ou chega (nada de prazo, data, "hoje", "em breve", "logo" ou "em instantes"), e não diga que já foi enviado. Não chame a ferramenta do documento de novo para isso.`;
}

// What a turn hands the graph. A failed read costs the line, never the turn: the customer is still
// answered, and the tool's own answer still refuses to issue twice.
export async function approvalNoticesForTurn(
  tenantId: bigint,
  conversation: { conversationId: bigint | null; threadId: string },
  base: PrismaClient = basePrisma,
): Promise<string[]> {
  try {
    const line = await pendingApprovalNotice(tenantId, conversation, base);
    return line ? [line] : [];
  } catch (err) {
    logger.warn(
      { err, tenantId: String(tenantId), threadId: conversation.threadId },
      "document approval: pending notice unreadable, turn runs without it",
    );
    return [];
  }
}

async function runExpiry(
  tenantId: bigint,
  base: PrismaClient,
): Promise<JobResult> {
  await expireDueApprovalRequests(tenantId, new Date(), base);
  return { outcome: "done" };
}

let registered = false;
export function registerDocumentApprovalExpiryHandler(): void {
  if (registered) return;
  registerJobHandler("DOCUMENT_APPROVAL_EXPIRY", (job, base) =>
    runExpiry(job.tenantId, base),
  );
  registered = true;
}

export type IssueOrRequest =
  | { kind: "issued"; document: IssuedDocumentResult }
  | { kind: "approval"; request: ApprovalRequestDto };

// The agent's tool path. Whether the template asks for approval is read when the tool is CALLED, so
// switching it on takes effect on the next call, not the next deploy. A key that already names a
// request or a document is answered with it before the template is read, the retry rule
// `issueDocument` follows: the snapshot was frozen then, and today's template must not refuse it.
export async function issueOrRequestApproval(params: {
  ctx: TenantContext;
  base?: PrismaClient;
  storageDir?: string;
  templateId: bigint;
  idempotencyKey: string;
  values: unknown;
  threadId?: string | null;
  chatwootInstanceId?: bigint | null;
  conversationId?: bigint | null;
  withBytes?: boolean;
  timezone?: string;
  now: Date;
}): Promise<IssueOrRequest> {
  const base = params.base ?? basePrisma;
  const { ctx } = params;
  const tenantId = ctx.tenantId as bigint;
  const [request, issued] = await runScopedOn(base, ctx, (db) =>
    Promise.all([
      db.documentApprovalRequest.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId,
            idempotencyKey: params.idempotencyKey,
          },
        },
        select: SELECT,
      }),
      db.issuedDocument.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId,
            idempotencyKey: params.idempotencyKey,
          },
        },
        select: { id: true },
      }),
    ]),
  );
  if (request) return { kind: "approval", request: toDto(request) };
  const issue = (frozen?: FrozenDocument) =>
    frozen
      ? issueFrozenDocument({
          ctx,
          base,
          storageDir: params.storageDir,
          templateId: frozen.template.id,
          title: frozen.template.name,
          numberPrefix: frozen.template.numberPrefix,
          snapshot: frozen.snapshot,
          idempotencyKey: params.idempotencyKey,
          threadId: params.threadId,
          chatwootInstanceId: params.chatwootInstanceId,
          conversationId: params.conversationId,
          withBytes: params.withBytes,
          guard: async (db) => {
            await claimKey(db, tenantId, params.idempotencyKey);
            const requested = await db.documentApprovalRequest.findUnique({
              where: {
                tenantId_idempotencyKey: {
                  tenantId,
                  idempotencyKey: params.idempotencyKey,
                },
              },
              select: { id: true },
            });
            if (requested) throw new KeyAnswered("request");
          },
        })
      : issueDocument({ ...params, base });
  if (issued) return { kind: "issued", document: await issue() };
  const frozen = await freezeDocumentSnapshot({
    ctx,
    base,
    templateId: params.templateId,
    values: params.values,
    now: params.now,
    timezone: params.timezone,
  });
  try {
    if (!frozen.template.requiresApproval) {
      return { kind: "issued", document: await issue(frozen) };
    }
    return {
      kind: "approval",
      request: await createApprovalRequest({
        ctx,
        base,
        frozen,
        idempotencyKey: params.idempotencyKey,
        threadId: params.threadId,
        chatwootInstanceId: params.chatwootInstanceId,
        conversationId: params.conversationId,
        now: params.now,
      }),
    };
  } catch (e) {
    if (!(e instanceof KeyAnswered)) throw e;
    if (e.by === "document") return { kind: "issued", document: await issue() };
    const winner = await runScopedOn(base, ctx, (db) =>
      db.documentApprovalRequest.findUniqueOrThrow({
        where: {
          tenantId_idempotencyKey: {
            tenantId,
            idempotencyKey: params.idempotencyKey,
          },
        },
        select: SELECT,
      }),
    );
    return { kind: "approval", request: toDto(winner) };
  }
}
