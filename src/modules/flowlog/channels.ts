import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { redactEndpoint } from "@/modules/audit/projection";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
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
// the blob can't be decrypted/parsed (never throws into a list response). The redaction itself is
// `redactEndpoint`, shared with the audit projection, so the DTO and the trail cannot disagree about
// what a safe form of one of these URLs is.
function maskUrl(encrypted: string): string {
  try {
    return redactEndpoint(decryptJson<string>(encrypted));
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

// What the audit row carries. Built from the ROW rather than the DTO, because two of the three
// things worth recording here are not on the DTO at all.
//
// The URL is NOT on it, and `urlMasked` is. The column is an `encryptJson` blob because a Discord
// URL embeds a bot token, and an audit row is readable by every tenant admin — the one place a
// projection built by hand would put it back in the clear.
//
// `secretRef` IS on it, in full, and it is a reference rather than a secret by construction: this
// service is the only writer of the column (measured) and it canonicalizes every value through
// `requireVaultRef`. The DTO's `hasSecret` would not do: it is the same boolean before and after a
// ROTATION, so the one change a signing secret can undergo would leave no row.
function auditProjection(row: {
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  minLevel: string;
  stages: string[];
  secretRef: string | null;
}) {
  return {
    name: row.name,
    type: row.type,
    urlMasked: maskUrl(row.url),
    minLevel: row.minLevel,
    stages: row.stages,
    enabled: row.enabled,
    secretRef: row.secretRef,
  };
}

// Whether the stored destination actually moved, which the projection cannot say on its own: the
// mask is `scheme://host/…`, so replacing a Discord webhook with a DIFFERENT one on the same host
// leaves both sides identical while everything the channel posts to has changed. Compared on the
// plaintext, inside the service; what reaches the row is the boolean. Comparing the ciphertext would
// answer "moved" every time, since `encryptJson` is randomised.
function urlMoved(before: string, after: string): boolean {
  try {
    return decryptJson<string>(before) !== decryptJson<string>(after);
  } catch {
    // A blob that will not decrypt cannot be shown to be the same one.
    return true;
  }
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
      ? await requireVaultRef(db, parsed.secretRef, "secretRef")
      : null;
    const created = await db.alertChannel.create({
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
    await auditMutation(db, ctx, {
      action: "alert_channel.create",
      target: `alert_channel:${created.id}`,
      after: auditProjection(created),
    });
    return created;
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
      data.secretRef = await requireVaultRef(db, data.secretRef, "secretRef");
    }
    // LOCKED, then read, and both inside the transaction the write happens in. The MCP tool read
    // this one layer up and outside any transaction, which is the half of the seam that could not be
    // fixed from up there — and an unlocked read in here is only better by a margin: at READ
    // COMMITTED two concurrent PATCHes both read state A, the first commits B, and the second's
    // `updateMany` then blocks, wakes, writes C and files a row saying A became C. B's change is
    // attributed to whoever wrote C. Six of the audited families already take this lock before their
    // snapshot; this is the same statement at a seventh site.
    await db.$queryRaw`SELECT 1 FROM "alert_channels" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.alertChannel.findFirst({
      where: { id },
      select: SELECT,
    });
    // updateMany → count 0 for a foreign/missing id under RLS → NotFound (never a cross-tenant write).
    const res = await db.alertChannel.updateMany({ where: { id }, data });
    if (res.count === 0 || !current)
      throw new NotFoundError(
        "alert channel not found",
        "errors.alertChannelNotFound",
      );
    const updated = await db.alertChannel.findFirst({
      where: { id },
      select: SELECT,
    });
    if (updated) {
      const before = auditProjection(current);
      const shown = auditProjection(updated);
      const hidden =
        urlMoved(current.url, updated.url) &&
        before.urlMasked === shown.urlMasked;
      const after = hidden ? { ...shown, urlReplaced: true } : shown;
      if (hidden || projectionMoved(before, after)) {
        await auditMutation(db, ctx, {
          action: "alert_channel.update",
          target: `alert_channel:${id}`,
          before,
          after,
        });
      }
    }
    return updated;
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
    // Locked, then read before the delete: the row is what the audit records, and after
    // `deleteMany` there is nothing left to name what was removed. The lock is the same one the
    // update takes, and for the same reason — an update committing between this read and the delete
    // would leave the row describing a channel that no longer looked like that.
    await db.$queryRaw`SELECT 1 FROM "alert_channels" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.alertChannel.findFirst({
      where: { id },
      select: SELECT,
    });
    const res = await db.alertChannel.deleteMany({ where: { id } });
    if (res.count > 0 && current) {
      await auditMutation(db, ctx, {
        action: "alert_channel.delete",
        target: `alert_channel:${id}`,
        before: auditProjection(current),
      });
    }
    return res.count;
  });
  if (count === 0)
    throw new NotFoundError(
      "alert channel not found",
      "errors.alertChannelNotFound",
    );
}
