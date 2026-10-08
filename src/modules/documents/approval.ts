import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText, makeStorable } from "@/lib/text";
import { enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { type DocumentStyle, parseDocumentStyle } from "./blocks";
import { formatDate } from "./format";
import {
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
  chatwootInstanceId: true,
  conversationId: true,
  snapshot: true,
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

function notFound(): NotFoundError {
  return new NotFoundError(
    "document approval request not found",
    "errors.documentApprovalNotFound",
  );
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
  const created = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.create({
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
    }),
  ).catch((err: unknown) => {
    // NOTE: a P2002 aborts the transaction it was raised in, so the winner is read in a new one.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return null;
    }
    throw err;
  });
  if (created) {
    await enqueueJob({
      tenantId,
      kind: "DOCUMENT_APPROVAL_EXPIRY",
      dedupeKey: expiryJobKey(created.id),
      runAt: expiresAt,
      rearm: "new-work",
      base,
    });
    return toDto(created);
  }
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
  const row = await loadRequest(ctx, id, base);
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
// approving again completes.
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
  const claimed = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.updateMany({
      where: { id: requestId, status: "PENDING", expiresAt: { gt: now } },
      data: {
        status: "APPROVED",
        reviewerUserId: params.reviewerUserId ?? null,
        decidedAt: now,
      },
    }),
  );
  const row = await loadRequest(ctx, requestId, base);
  if (claimed.count === 0 && row.status !== "APPROVED") {
    if (row.status === "PENDING") {
      await expireDueApprovalRequests(ctx.tenantId as bigint, now, base);
      throw expired();
    }
    throw notPending(row.status);
  }
  if (row.templateId === null) {
    throw new AppError(
      "this document could not be numbered",
      409,
      "errors.documentNotNumbered",
    );
  }
  const idempotencyKey = `approval:${row.id}`;
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
  const linked = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.update({
      where: { id: requestId },
      data: {
        issuedDocument: {
          connect: {
            tenantId_idempotencyKey: {
              tenantId: ctx.tenantId as bigint,
              idempotencyKey,
            },
          },
        },
      },
      select: SELECT,
    }),
  );
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
  const claimed = await runScopedOn(base, ctx, (db) =>
    db.documentApprovalRequest.updateMany({
      where: { id: requestId, status: "PENDING", expiresAt: { gt: now } },
      data: {
        status: "REJECTED",
        reviewerUserId: params.reviewerUserId ?? null,
        note,
        decidedAt: now,
      },
    }),
  );
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
  const rows = await runScopedOn(
    base,
    sysCtx(tenantId),
    (db) =>
      db.$queryRaw<{ id: bigint }[]>`
      UPDATE "document_approval_requests"
         SET "status" = 'EXPIRED', "decided_at" = ${now}, "updated_at" = ${now}
       WHERE "tenant_id" = ${tenantId}
         AND "status" = 'PENDING'
         AND "expires_at" <= ${now}
      RETURNING "id"
    `,
  );
  return rows.map((r) => r.id);
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
}
