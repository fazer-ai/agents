import { z } from "zod";
import type {
  OutreachAccountStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import { Prisma } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import {
  AppError,
  ConflictError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { auditMutation } from "@/modules/audit/service";
import { LEAD_PLATFORMS } from "@/modules/merchant/leads";
import { readableVaultRef, requireVaultRef } from "@/modules/vault/service";
import {
  assertOutreachEnabled,
  OUTREACH_ACCOUNT_STATUSES,
  OUTREACH_TRANSPORTS,
} from "./shared";

// Outreach accounts: the personal/secondary accounts an operator sends from. `credentialRef`
// holds the stable `vault:<id>` reference to the entry that carries the session/token the
// transport needs (for zca_bridge a JSON object like { "token": "...", "baseUrl"?: "..." });
// the value never leaves the vault boundary except inside the worker's own send path.
//
// The rate controls live on the row: `dailyCap`/`sentToday`(+`sentTodayDate`, the UTC day
// the counter counts)/`cooldownMin`/`lastSentAt`. The worker consumes a slot in ONE guarded
// UPDATE so a concurrent claim cannot overspend the cap; this module only configures them.

export interface OutreachAccountDto {
  id: string;
  platform: string;
  handle: string;
  credentialRef: string | null;
  transport: string;
  dailyCap: number;
  // The counter as the cap gate sees it: 0 once the day it counted rolled over.
  sentToday: number;
  sentTodayDate: string | null;
  cooldownMin: number;
  lastSentAt: Date | null;
  status: OutreachAccountStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  platform: true,
  handle: true,
  credentialRef: true,
  transport: true,
  dailyCap: true,
  sentToday: true,
  sentTodayDate: true,
  cooldownMin: true,
  lastSentAt: true,
  status: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
} as const;

type AccountRow = {
  id: bigint;
  platform: string;
  handle: string;
  credentialRef: string | null;
  transport: string;
  dailyCap: number;
  sentToday: number;
  sentTodayDate: Date | null;
  cooldownMin: number;
  lastSentAt: Date | null;
  status: OutreachAccountStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// A `@db.Date` lands as the UTC midnight Date of that calendar day; the cap
// counts the UTC day, same boundary the worker's SQL uses (CURRENT_DATE).
export function effectiveSentToday(
  row: Pick<AccountRow, "sentToday" | "sentTodayDate">,
  now: Date = new Date(),
): number {
  if (!row.sentTodayDate) return 0;
  const todayUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  return row.sentTodayDate.getTime() === todayUtc ? row.sentToday : 0;
}

function toDto(r: AccountRow): OutreachAccountDto {
  return {
    id: String(r.id),
    platform: r.platform,
    handle: r.handle,
    credentialRef: readableVaultRef(r.credentialRef),
    transport: r.transport,
    dailyCap: r.dailyCap,
    sentToday: effectiveSentToday(r),
    sentTodayDate: r.sentTodayDate?.toISOString().slice(0, 10) ?? null,
    cooldownMin: r.cooldownMin,
    lastSentAt: r.lastSentAt,
    status: r.status,
    notes: r.notes,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const outreachAccountCreateSchema = z
  .object({
    platform: z.enum(LEAD_PLATFORMS),
    handle: z.string().min(1).max(300),
    transport: z.enum(OUTREACH_TRANSPORTS).default("manual"),
    credentialRef: z.string().max(200).optional(),
    dailyCap: z.number().int().min(1).max(500).default(20),
    cooldownMin: z.number().int().min(0).max(1440).default(10),
    notes: z.string().max(2000).optional(),
  })
  .strict();
export type OutreachAccountCreate = z.input<typeof outreachAccountCreateSchema>;

export const outreachAccountUpdateSchema = z
  .object({
    platform: z.enum(LEAD_PLATFORMS).optional(),
    handle: z.string().min(1).max(300).optional(),
    transport: z.enum(OUTREACH_TRANSPORTS).optional(),
    // Nullable so an operator can DETACH the credential; optional so a patch
    // that does not mention it leaves it alone.
    credentialRef: z.string().max(200).nullable().optional(),
    dailyCap: z.number().int().min(1).max(500).optional(),
    cooldownMin: z.number().int().min(0).max(1440).optional(),
    status: z.enum(OUTREACH_ACCOUNT_STATUSES).optional(),
    notes: z.string().max(2000).nullable().optional(),
  })
  .strict();
export type OutreachAccountUpdate = z.input<typeof outreachAccountUpdateSchema>;

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

const duplicateAccount = () =>
  new ConflictError(
    "An outreach account with this platform and handle already exists",
    "errors.outreachAccountDuplicate",
  );

export async function listOutreachAccounts(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<OutreachAccountDto[]> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const rows = await runScopedOn(base, ctx, (db) =>
    db.outreachAccount.findMany({ orderBy: { id: "desc" }, select: SELECT }),
  );
  return rows.map(toDto);
}

export async function getOutreachAccount(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<OutreachAccountDto> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const row = await runScopedOn(base, ctx, (db) =>
    db.outreachAccount.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "outreach account not found",
      "errors.outreachAccountNotFound",
    );
  }
  return toDto(row);
}

export async function createOutreachAccount(
  ctx: TenantContext,
  input: OutreachAccountCreate,
  base: PrismaClient = basePrisma,
): Promise<OutreachAccountDto> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const tenantId = ctx.tenantId;
  const data = parseInput(outreachAccountCreateSchema, input);
  try {
    return await runScopedOn(base, ctx, async (db) => {
      const credentialRef =
        data.credentialRef !== undefined
          ? await requireVaultRef(db, data.credentialRef, "credentialRef")
          : null;
      const row = await db.outreachAccount.create({
        data: {
          tenantId,
          platform: data.platform,
          handle: data.handle,
          transport: data.transport,
          credentialRef,
          dailyCap: data.dailyCap,
          cooldownMin: data.cooldownMin,
          notes: data.notes ?? null,
        },
        select: SELECT,
      });
      const dto = toDto(row);
      await auditMutation(db, ctx, {
        action: "outreach_account.create",
        target: `outreach_account:${dto.id}`,
        after: {
          platform: dto.platform,
          handle: dto.handle,
          transport: dto.transport,
          dailyCap: dto.dailyCap,
          cooldownMin: dto.cooldownMin,
        },
      });
      return dto;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateAccount();
    throw err;
  }
}

export async function updateOutreachAccount(
  ctx: TenantContext,
  id: bigint,
  input: OutreachAccountUpdate,
  base: PrismaClient = basePrisma,
): Promise<OutreachAccountDto> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  const data = parseInput(outreachAccountUpdateSchema, input);
  try {
    return await runScopedOn(base, ctx, async (db) => {
      const before = await db.outreachAccount.findUnique({
        where: { id },
        select: SELECT,
      });
      if (!before) {
        throw new NotFoundError(
          "outreach account not found",
          "errors.outreachAccountNotFound",
        );
      }
      // A credentialRef key with value null DETACHES the secret; a key absent
      // leaves it; a ref is validated against this tenant's vault.
      let credentialRef: string | null | undefined;
      if (data.credentialRef !== undefined) {
        credentialRef =
          data.credentialRef === null
            ? null
            : await requireVaultRef(db, data.credentialRef, "credentialRef");
      }
      const row = await db.outreachAccount.update({
        where: { id },
        data: {
          ...(data.platform !== undefined ? { platform: data.platform } : {}),
          ...(data.handle !== undefined ? { handle: data.handle } : {}),
          ...(data.transport !== undefined
            ? { transport: data.transport }
            : {}),
          ...(credentialRef !== undefined ? { credentialRef } : {}),
          ...(data.dailyCap !== undefined ? { dailyCap: data.dailyCap } : {}),
          ...(data.cooldownMin !== undefined
            ? { cooldownMin: data.cooldownMin }
            : {}),
          ...(data.status !== undefined ? { status: data.status } : {}),
          ...(data.notes !== undefined ? { notes: data.notes } : {}),
        },
        select: SELECT,
      });
      const dto = toDto(row);
      await auditMutation(db, ctx, {
        action: "outreach_account.update",
        target: `outreach_account:${dto.id}`,
        before: {
          platform: before.platform,
          handle: before.handle,
          transport: before.transport,
          dailyCap: before.dailyCap,
          cooldownMin: before.cooldownMin,
          status: before.status,
        },
        after: {
          platform: dto.platform,
          handle: dto.handle,
          transport: dto.transport,
          dailyCap: dto.dailyCap,
          cooldownMin: dto.cooldownMin,
          status: dto.status,
        },
      });
      return dto;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateAccount();
    throw err;
  }
}

export async function deleteOutreachAccount(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  assertOutreachEnabled();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  await runScopedOn(base, ctx, async (db) => {
    const before = await db.outreachAccount.findUnique({
      where: { id },
      select: { id: true, handle: true, platform: true },
    });
    if (!before) {
      throw new NotFoundError(
        "outreach account not found",
        "errors.outreachAccountNotFound",
      );
    }
    await db.outreachAccount.delete({ where: { id } });
    await auditMutation(db, ctx, {
      action: "outreach_account.delete",
      target: `outreach_account:${String(id)}`,
      before: { platform: before.platform, handle: before.handle },
    });
  });
}

// The queue-time account check (jobs.ts): the row exists in this tenant and is
// not BANNED. PAUSED is queueable on purpose - an operator stages a batch while
// the account rests, and the claim's ACTIVE join holds the sends until resume.
export function assertAccountQueueable(account: {
  status: OutreachAccountStatus;
}): void {
  if (account.status === "BANNED") {
    throw new AppError(
      "This outreach account is banned and cannot take new jobs",
      422,
      "errors.outreachAccountBanned",
    );
  }
}
