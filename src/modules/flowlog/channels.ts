import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { requireVaultRef } from "@/modules/vault/service";
import { FLOW_LEVELS, FLOW_STAGES } from "./stages";

// CRUD for AlertChannel (external alert sinks for execution-flow warnings/errors). Mirrors the
// webhook-subscription service: ctx-based, RLS-fenced, the controller is a thin projection. The
// `url` is stored as an encryptJson blob (a Discord URL embeds a bot token) and NEVER returned in
// the clear — the DTO exposes only a masked preview (scheme://host/…). To change it the operator
// re-enters the full URL, exactly like the vault. `secretRef` (HMAC, webhook type) is a vault ref.
//
// NOTE: the AppError translationKeys thrown here are registered for the i18n extractor via
// translate() magic comments in alert-channels.controller.ts (the API extractor only scans src/api).

const CHANNEL_TYPES = ["discord", "webhook"] as const;

export interface AlertChannelDto {
  id: string;
  name: string;
  type: string;
  // Masked preview only — the token-bearing URL is never returned.
  urlMasked: string;
  enabled: boolean;
  minLevel: string;
  stages: string[];
  // Whether an HMAC signing secret is configured (the value never leaves the vault).
  hasSecret: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  type: true,
  url: true,
  enabled: true,
  minLevel: true,
  stages: true,
  secretRef: true,
  createdAt: true,
  updatedAt: true,
} as const;

// scheme://host/… — reveals enough to identify the channel, hides the token. Falls back to "…" if
// the blob can't be decrypted/parsed (never throws into a list response).
function maskUrl(encrypted: string): string {
  try {
    const url = decryptJson<string>(encrypted);
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "…";
  }
}

function toDto(row: {
  id: bigint;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  minLevel: string;
  stages: string[];
  secretRef: string | null;
  createdAt: Date;
  updatedAt: Date;
}): AlertChannelDto {
  return {
    id: row.id.toString(),
    name: row.name,
    type: row.type,
    urlMasked: maskUrl(row.url),
    enabled: row.enabled,
    minLevel: row.minLevel,
    stages: row.stages,
    hasSecret: row.secretRef !== null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertStages(stages: string[]): string[] {
  const allowed = new Set<string>(FLOW_STAGES);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of stages) {
    if (!allowed.has(s)) {
      throw new AppError(
        `unknown stage: ${s}`,
        400,
        "errors.unknownFlowStage",
        {
          stage: s,
        },
      );
    }
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

export async function listAlertChannels(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<AlertChannelDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.alertChannel.findMany({ select: SELECT, orderBy: { id: "asc" } }),
  );
  return rows.map(toDto);
}

export const alertChannelCreateSchema = z
  .object({
    name: z.string().min(1).max(120),
    type: z.enum(CHANNEL_TYPES),
    url: z.string().min(1).max(2048),
    minLevel: z.enum(FLOW_LEVELS).optional(),
    stages: z.array(z.string()).optional(),
    secretRef: z.string().min(1).max(128).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type AlertChannelCreate = z.infer<typeof alertChannelCreateSchema>;

export async function createAlertChannel(
  ctx: TenantContext,
  input: AlertChannelCreate,
  base: PrismaClient = basePrisma,
): Promise<AlertChannelDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const parsed = parseInput(alertChannelCreateSchema, input);
  await assertSafeOutboundUrl(parsed.url);
  const stages = assertStages(parsed.stages ?? []);
  const row = await runScopedOn(base, ctx, async (db) => {
    const secretRef = parsed.secretRef
      ? await requireVaultRef(db, parsed.secretRef)
      : null;
    return db.alertChannel.create({
      data: {
        tenantId,
        name: parsed.name,
        type: parsed.type,
        url: encryptJson(parsed.url),
        minLevel: parsed.minLevel ?? "error",
        stages,
        secretRef,
        enabled: parsed.enabled ?? true,
      },
      select: SELECT,
    });
  });
  return toDto(row);
}

export const alertChannelUpdateSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    type: z.enum(CHANNEL_TYPES).optional(),
    url: z.string().min(1).max(2048).optional(),
    minLevel: z.enum(FLOW_LEVELS).optional(),
    stages: z.array(z.string()).optional(),
    secretRef: z.string().min(1).max(128).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type AlertChannelUpdate = z.infer<typeof alertChannelUpdateSchema>;

export async function updateAlertChannel(
  ctx: TenantContext,
  id: bigint,
  patch: AlertChannelUpdate,
  base: PrismaClient = basePrisma,
): Promise<AlertChannelDto> {
  const parsed = parseInput(alertChannelUpdateSchema, patch);
  const data: Record<string, unknown> = {};
  if (parsed.name !== undefined) data.name = parsed.name;
  if (parsed.type !== undefined) data.type = parsed.type;
  if (parsed.url !== undefined) {
    await assertSafeOutboundUrl(parsed.url);
    data.url = encryptJson(parsed.url);
  }
  if (parsed.minLevel !== undefined) data.minLevel = parsed.minLevel;
  if (parsed.stages !== undefined) data.stages = assertStages(parsed.stages);
  // secretRef: undefined = leave; null = clear; string = set.
  if (parsed.secretRef !== undefined) data.secretRef = parsed.secretRef;
  if (parsed.enabled !== undefined) data.enabled = parsed.enabled;
  if (Object.keys(data).length === 0) {
    throw new AppError(
      "no updatable fields provided",
      400,
      "errors.noUpdatableFields",
    );
  }
  const row = await runScopedOn(base, ctx, async (db) => {
    // Canonicalized inside the tx, so the entry cannot be deleted between the check and the write.
    if (typeof data.secretRef === "string") {
      data.secretRef = await requireVaultRef(db, data.secretRef);
    }
    // updateMany → count 0 for a foreign/missing id under RLS → NotFound (never a cross-tenant write).
    const res = await db.alertChannel.updateMany({ where: { id }, data });
    if (res.count === 0)
      throw new NotFoundError(
        "alert channel not found",
        "errors.alertChannelNotFound",
      );
    return db.alertChannel.findFirst({ where: { id }, select: SELECT });
  });
  if (!row)
    throw new NotFoundError(
      "alert channel not found",
      "errors.alertChannelNotFound",
    );
  return toDto(row);
}

export async function deleteAlertChannel(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  // alert_deliveries.channel_id is ON DELETE CASCADE, so removing the channel drops its (PII-free)
  // delivery ledger with it.
  const count = await runScopedOn(base, ctx, async (db) => {
    const res = await db.alertChannel.deleteMany({ where: { id } });
    return res.count;
  });
  if (count === 0)
    throw new NotFoundError(
      "alert channel not found",
      "errors.alertChannelNotFound",
    );
}
