import { z } from "zod";
import type {
  PrismaClient,
  ReplyDraftKind,
  ReplyDraftStatus,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  AppError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { fetchBounded } from "@/lib/outbound";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import {
  TAGGING_GATEWAY_URL,
  TAGGING_MODEL,
  TAGGING_TIMEOUT_MS,
} from "@/modules/merchant/tagging";

// Reply drafts (per-tenant): the human-in-the-loop outreach rail. The local LLM
// gateway proposes Vietnamese sales copy for one lead; the operator edits,
// approves and then copies the text to the platform by hand. NOTHING here posts
// anywhere - SENT is a bookkeeping mark, not a send.
//
// The gateway call sits OUTSIDE any runScoped transaction for the same reason
// as merchant/tagging.ts: a scoped tx pins a pooled connection and a 15-40s
// LLM round-trip inside one would drain the pool. Flow: read (scoped) -> fetch
// (no tx) -> write (scoped). The tagging gateway constants are reused verbatim:
// same loopback endpoint, same model, same timeout headroom.

export const REPLY_DRAFT_KINDS = ["PUBLIC_REPLY", "DM_OPENER"] as const;

// A draft reply is prose, not JSON: a fence or wrapped quotes get stripped, and
// an empty/over-long answer is the generator not having answered usefully.
const DRAFT_BODY_MAX = 4000;

export interface ReplyDraftDto {
  id: string;
  leadId: string;
  kind: ReplyDraftKind;
  body: string;
  status: ReplyDraftStatus;
  error: string | null;
  sentAt: Date | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const DRAFT_SELECT = {
  id: true,
  leadId: true,
  kind: true,
  body: true,
  status: true,
  error: true,
  sentAt: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

type DraftRow = {
  id: bigint;
  leadId: bigint;
  kind: ReplyDraftKind;
  body: string;
  status: ReplyDraftStatus;
  error: string | null;
  sentAt: Date | null;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: DraftRow): ReplyDraftDto {
  return {
    id: String(r.id),
    leadId: String(r.leadId),
    kind: r.kind,
    body: r.body,
    status: r.status,
    error: r.error,
    sentAt: r.sentAt,
    createdBy: r.createdBy === null ? null : String(r.createdBy),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const draftCreateSchema = z
  .object({
    kind: z.enum(REPLY_DRAFT_KINDS),
    // An explicit body skips the gateway entirely (operator-pasted copy).
    body: z.string().min(1).max(DRAFT_BODY_MAX).optional(),
    // Free-form steer for the model ("mention the freeship offer"), never a
    // second body: it is folded into the prompt, not stored.
    note: z.string().max(1000).optional(),
  })
  .strict();
export type ReplyDraftCreate = z.infer<typeof draftCreateSchema>;

export const draftUpdateSchema = z
  .object({
    body: z.string().min(1).max(DRAFT_BODY_MAX),
  })
  .strict();
export type ReplyDraftUpdate = z.infer<typeof draftUpdateSchema>;

// The lead context the generator writes from. Matched products carry the
// catalog price so the model can quote it instead of inventing one.
interface DraftLeadContext {
  platform: string;
  authorName: string;
  authorHandle: string | null;
  text: string;
  groupName: string | null;
  matches: { name: string; price: string }[];
}

function buildDraftMessages(
  kind: ReplyDraftKind,
  lead: DraftLeadContext,
  note?: string,
): { role: "system" | "user"; content: string }[] {
  const task =
    kind === "PUBLIC_REPLY"
      ? [
          "Đây là BÌNH LUẬN CÔNG KHAI trả lời ngay dưới bài đăng của khách.",
          "Ngắn gọn (1-2 câu), lịch sự, xác nhận shop có hàng phù hợp, mời khách inbox để tư vấn.",
          "Không để lộ số điện thoại hay link trong comment.",
        ]
      : [
          "Đây là TIN NHẮN RIÊNG (inbox/DM) ĐẦU TIÊN gửi cho khách sau khi thấy bài đăng của họ.",
          "Nhắc lại đúng nhu cầu khách đã viết, gợi ý sản phẩm phù hợp kèm giá,",
          "hỏi thêm thông tin cần thiết (size, màu, địa chỉ) và mời khách trả lời.",
        ];
  const system = [
    "Bạn là nhân viên bán hàng của một shop online ở Việt Nam.",
    "Viết tin nhắn tiếng Việt theo giọng bán hàng quen thuộc: xưng hô em - anh/chị, thân thiện, không sáo rỗng.",
    ...task,
    "Chỉ nhắc sản phẩm và giá có trong danh sách cung cấp, không bịa.",
    "Trả lời DUY NHẤT nội dung tin nhắn: không tiêu đề, không markdown, không giải thích.",
  ].join("\n");
  const user = [
    `Nền tảng: ${lead.platform}`,
    `Khách: ${lead.authorName}${lead.authorHandle ? ` (${lead.authorHandle})` : ""}`,
    lead.groupName ? `Nhóm/nơi đăng: ${lead.groupName}` : null,
    `Bài đăng của khách: """${lead.text}"""`,
    lead.matches.length > 0
      ? `Sản phẩm phù hợp trong catalog:\n${lead.matches
          .map((m) => `- ${m.name} - ${m.price} VND`)
          .join("\n")}`
      : "Catalog không có sản phẩm nào khớp rõ ràng; viết một lời mời chung.",
    note ? `Yêu cầu thêm của người duyệt: ${note}` : null,
  ]
    .filter(Boolean)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

// The generator's answer is raw prose: strip a markdown fence or one pair of
// wrapping quotes, trim, and refuse empty/over-long text. Unlike the tagger's
// parseTaggingResponse there is no JSON to validate - the caller's contract is
// "a message a person can still edit", so the bar is deliberately shallow.
export function parseDraftBody(content: string): string | null {
  const fenced = content.match(/```(?:\w+)?\s*([\s\S]*?)```/);
  let text = (fenced?.[1] ?? content).trim();
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("“") && text.endsWith("”")))
  ) {
    text = text.slice(1, -1).trim();
  }
  if (text === "" || text.length > DRAFT_BODY_MAX) return null;
  return text;
}

async function getDraftRowOn(db: ScopedDb, id: bigint): Promise<DraftRow> {
  const row = await db.replyDraft.findUnique({
    where: { id },
    select: DRAFT_SELECT,
  });
  if (!row) {
    throw new NotFoundError("draft not found", "errors.merchantDraftNotFound");
  }
  return row;
}

export async function listReplyDrafts(
  ctx: TenantContext,
  leadId: bigint,
  base: PrismaClient = basePrisma,
): Promise<ReplyDraftDto[]> {
  return runScopedOn(base, ctx, async (db) => {
    const lead = await db.lead.findUnique({
      where: { id: leadId },
      select: { id: true },
    });
    if (!lead) {
      throw new NotFoundError("lead not found", "errors.merchantLeadNotFound");
    }
    const rows = await db.replyDraft.findMany({
      where: { leadId },
      orderBy: { id: "desc" },
      select: DRAFT_SELECT,
    });
    return rows.map(toDto);
  });
}

export interface DraftingDeps {
  base?: PrismaClient;
  fetchImpl?: typeof fetch;
  gatewayUrl?: string;
  timeoutMs?: number;
}

export type DraftOutcome =
  | { ok: true; draft: ReplyDraftDto }
  | { ok: false; reason: "gateway" | "unparseable"; detail?: string };

// Create one draft for a lead. `body` given -> store it as-is (the gateway is a
// drafting aid, not a gate); absent -> ask the model, persist only a usable
// answer so an empty DRAFT row never reads as ready-to-send copy.
export async function createReplyDraft(
  ctx: TenantContext,
  leadId: bigint,
  input: ReplyDraftCreate,
  deps: DraftingDeps = {},
): Promise<DraftOutcome> {
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const base = deps.base ?? basePrisma;
  const data = parseInput(draftCreateSchema, input);

  const lead = await runScopedOn(base, ctx, async (db) => {
    const row = await db.lead.findUnique({
      where: { id: leadId },
      select: {
        id: true,
        platform: true,
        authorName: true,
        authorHandle: true,
        text: true,
        groupName: true,
        matches: {
          orderBy: { score: "desc" as const },
          take: 3,
          select: {
            product: { select: { name: true, price: true } },
          },
        },
      },
    });
    if (!row) {
      throw new NotFoundError(
        "lead not found",
        "errors.merchantLeadNotFound",
      );
    }
    return row;
  });

  let body = data.body;
  if (body === undefined) {
    const { res, body: raw } = await fetchBounded(
      deps.gatewayUrl ?? TAGGING_GATEWAY_URL,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: TAGGING_MODEL,
          messages: buildDraftMessages(
            data.kind,
            {
              platform: lead.platform,
              authorName: lead.authorName,
              authorHandle: lead.authorHandle,
              text: lead.text,
              groupName: lead.groupName,
              matches: lead.matches.map((m) => ({
                name: m.product.name,
                price: m.product.price.toString(),
              })),
            },
            data.note,
          ),
          temperature: 0.4,
          stream: false,
        }),
      },
      {
        timeoutMs: deps.timeoutMs ?? TAGGING_TIMEOUT_MS,
        cap: 256_000,
        fetchImpl: deps.fetchImpl,
      },
    );
    if (!res.ok) {
      return { ok: false, reason: "gateway", detail: `HTTP ${res.status}` };
    }
    let completion: unknown;
    try {
      completion = JSON.parse(raw.text);
    } catch {
      return { ok: false, reason: "gateway", detail: "non-JSON gateway reply" };
    }
    const content = (
      completion as { choices?: { message?: { content?: unknown } }[] }
    ).choices?.[0]?.message?.content;
    const parsed =
      typeof content === "string" ? parseDraftBody(content) : null;
    if (!parsed) {
      return { ok: false, reason: "unparseable" };
    }
    body = parsed;
  }

  const draft = await runScopedOn(base, ctx, async (db) => {
    const row = await db.replyDraft.create({
      data: {
        tenantId,
        leadId,
        kind: data.kind,
        body,
        createdBy: ctx.userId,
      },
      select: DRAFT_SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_reply_draft.create",
      target: `reply_draft:${dto.id}`,
      after: {
        leadId: dto.leadId,
        kind: dto.kind,
        generated: data.body === undefined,
      },
    });
    return dto;
  });
  return { ok: true, draft };
}

// The state machine: every transition is a status-guarded updateMany inside the
// scoped tx, so a concurrent edit cannot move a row twice, and a wrong-state
// refusal names the from/to it rejected.
const TRANSITIONS: Record<string, ReplyDraftStatus[]> = {
  // edit keeps the row DRAFT; approve/reject/mark-sent are the verbs.
  edit: ["DRAFT"],
  approve: ["DRAFT"],
  reject: ["DRAFT", "APPROVED"],
  markSent: ["APPROVED"],
};

function badTransition(
  action: string,
  from: ReplyDraftStatus,
): AppError {
  const allowed = TRANSITIONS[action] ?? [];
  const to =
    action === "approve"
      ? "APPROVED"
      : action === "reject"
        ? "REJECTED"
        : action === "markSent"
          ? "SENT"
          : from;
  return new AppError(
    `cannot ${action} a draft in status ${from} (allowed from: ${allowed.join(", ")})`,
    409,
    "errors.merchantDraftBadTransition",
    { from, to },
  );
}

export async function updateReplyDraft(
  ctx: TenantContext,
  id: bigint,
  input: ReplyDraftUpdate,
  base: PrismaClient = basePrisma,
): Promise<ReplyDraftDto> {
  const data = parseInput(draftUpdateSchema, input);
  return runScopedOn(base, ctx, async (db) => {
    const current = await getDraftRowOn(db, id);
    if (current.status !== "DRAFT") {
      throw badTransition("edit", current.status);
    }
    const row = await db.replyDraft.update({
      where: { id },
      data: { body: data.body },
      select: DRAFT_SELECT,
    });
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: "merchant_reply_draft.update",
      target: `reply_draft:${id}`,
      before: { body: current.body },
      after: { body: dto.body },
    });
    return dto;
  });
}

// Approving or sending a DM_OPENER is outreach on the lead: a NEW lead becomes
// CONTACTED in the same transaction, so the funnel column never lags the rail.
async function touchLeadOnSend(
  db: ScopedDb,
  leadId: bigint,
): Promise<boolean> {
  const res = await db.lead.updateMany({
    where: { id: leadId, status: "NEW" },
    data: { status: "CONTACTED" },
  });
  return res.count > 0;
}

async function transition(
  ctx: TenantContext,
  id: bigint,
  action: "approve" | "reject" | "markSent",
  base: PrismaClient,
): Promise<ReplyDraftDto> {
  const allowed = TRANSITIONS[action] ?? [];
  const next: ReplyDraftStatus =
    action === "approve"
      ? "APPROVED"
      : action === "reject"
        ? "REJECTED"
        : "SENT";
  return runScopedOn(base, ctx, async (db) => {
    const current = await getDraftRowOn(db, id);
    if (!allowed.includes(current.status)) {
      throw badTransition(action, current.status);
    }
    const row = await db.replyDraft.update({
      where: { id },
      data: {
        status: next,
        ...(action === "markSent" ? { sentAt: new Date() } : {}),
      },
      select: DRAFT_SELECT,
    });
    const contacted =
      row.kind === "DM_OPENER" && action !== "reject"
        ? await touchLeadOnSend(db, row.leadId)
        : false;
    const dto = toDto(row);
    await auditMutation(db, ctx, {
      action: `merchant_reply_draft.${action === "markSent" ? "mark_sent" : action}`,
      target: `reply_draft:${id}`,
      before: { status: current.status },
      after: {
        status: dto.status,
        ...(contacted ? { leadStatus: "CONTACTED" } : {}),
      },
    });
    return dto;
  });
}

export function approveReplyDraft(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ReplyDraftDto> {
  return transition(ctx, id, "approve", base);
}

export function rejectReplyDraft(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ReplyDraftDto> {
  return transition(ctx, id, "reject", base);
}

// "Sent" here is the operator's mark that they copied the approved text to the
// platform themselves - this codebase never posts outward on its own.
export function markReplyDraftSent(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ReplyDraftDto> {
  return transition(ctx, id, "markSent", base);
}
