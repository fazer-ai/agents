import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { requireVaultRef } from "@/modules/vault/service";
import { isOutboundEvent, type OutboundEvent } from "./events";
import { syncTenantHeartbeat } from "./heartbeat";

// CRUD for WebhookSubscription (the OUTBOUND fan-out targets). Transport-agnostic, ctx-based
// (mirrors the vault service): the controller is a thin projection. TENANT_ADMIN-gated at the
// controller. RLS fences every read/write to the active tenant; `secretRef` is a `vault:<id>`
// pointing at a vault entry (never a raw secret in or out). `events` is validated against the closed set.
//
// NOTE: the AppError translationKeys thrown here (errors.unknownWebhookEvent /
// errors.webhookSubscriptionNotFound) are registered for the i18n extractor via translate() magic
// comments in the controller (webhooks.controller.ts), since the API extractor only scans src/api.

export interface WebhookSubscriptionDto {
  id: string;
  url: string;
  secretRef: string | null;
  events: OutboundEvent[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  url: true,
  secretRef: true,
  events: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDto(row: {
  id: bigint;
  url: string;
  secretRef: string | null;
  events: string[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): WebhookSubscriptionDto {
  return {
    id: row.id.toString(),
    url: row.url,
    secretRef: row.secretRef,
    // The stored set is the closed union by construction (validated on write); cast for the DTO.
    events: row.events as OutboundEvent[],
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function assertKnownEvents(events: string[]): OutboundEvent[] {
  const seen = new Set<string>();
  const out: OutboundEvent[] = [];
  for (const e of events) {
    if (!isOutboundEvent(e)) {
      throw new AppError(
        `unknown webhook event: ${e}`,
        400,
        "errors.unknownWebhookEvent",
        { event: e },
      );
    }
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
}

// allowHttp follows the SSRF guard default (https-only). A blocked URL surfaces as a 400 SsrfError.
async function assertUrlSafe(url: string): Promise<void> {
  await assertSafeOutboundUrl(url);
}

export async function listWebhookSubscriptions(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<WebhookSubscriptionDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.webhookSubscription.findMany({ select: SELECT, orderBy: { id: "asc" } }),
  );
  return rows.map(toDto);
}

export const webhookSubscriptionCreateSchema = z
  .object({
    url: z.string().min(1).max(2048),
    events: z.array(z.string()).min(1),
    secretRef: z.string().min(1).max(128).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type WebhookSubscriptionCreate = z.infer<
  typeof webhookSubscriptionCreateSchema
>;

export async function createWebhookSubscription(
  ctx: TenantContext,
  input: WebhookSubscriptionCreate,
  base: PrismaClient = basePrisma,
): Promise<WebhookSubscriptionDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const parsed = parseInput(webhookSubscriptionCreateSchema, input);
  const events = assertKnownEvents(parsed.events);
  await assertUrlSafe(parsed.url);
  const row = await runScopedOn(base, ctx, async (db) => {
    const secretRef = parsed.secretRef
      ? await requireVaultRef(db, parsed.secretRef)
      : null;
    return db.webhookSubscription.create({
      data: {
        tenantId,
        url: parsed.url,
        events,
        secretRef,
        enabled: parsed.enabled ?? true,
      },
      select: SELECT,
    });
  });
  // Reconcile the per-tenant heartbeat emitter against the new subscription state.
  await syncTenantHeartbeat(tenantId, base);
  return toDto(row);
}

export const webhookSubscriptionUpdateSchema = z
  .object({
    url: z.string().min(1).max(2048).optional(),
    events: z.array(z.string()).min(1).optional(),
    secretRef: z.string().min(1).max(128).nullish(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type WebhookSubscriptionUpdate = z.infer<
  typeof webhookSubscriptionUpdateSchema
>;

export async function updateWebhookSubscription(
  ctx: TenantContext,
  id: bigint,
  patch: WebhookSubscriptionUpdate,
  base: PrismaClient = basePrisma,
): Promise<WebhookSubscriptionDto> {
  const parsed = parseInput(webhookSubscriptionUpdateSchema, patch);
  const data: Record<string, unknown> = {};
  if (parsed.url !== undefined) {
    await assertUrlSafe(parsed.url);
    data.url = parsed.url;
  }
  if (parsed.events !== undefined)
    data.events = assertKnownEvents(parsed.events);
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
  // updateMany → count 0 for a foreign/missing id under RLS → NotFound (never a cross-tenant write).
  const row = await runScopedOn(base, ctx, async (db) => {
    // Canonicalized inside the tx, so the entry cannot be deleted between the check and the write.
    if (typeof data.secretRef === "string") {
      data.secretRef = await requireVaultRef(db, data.secretRef);
    }
    const res = await db.webhookSubscription.updateMany({
      where: { id },
      data,
    });
    if (res.count === 0)
      throw new NotFoundError(
        "webhook subscription not found",
        "errors.webhookSubscriptionNotFound",
      );
    return db.webhookSubscription.findFirst({ where: { id }, select: SELECT });
  });
  if (!row)
    throw new NotFoundError(
      "webhook subscription not found",
      "errors.webhookSubscriptionNotFound",
    );
  // An update may add/remove `heartbeat` or flip `enabled` — reconcile the per-tenant emitter.
  if (ctx.tenantId !== null) await syncTenantHeartbeat(ctx.tenantId, base);
  return toDto(row);
}

export async function deleteWebhookSubscription(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  // The delivery FK is ON DELETE CASCADE at the database (20260727000000_init), so what keeps this
  // from silently dropping rows the worker is mid-delivery is THIS function, not the constraint:
  // clear the subscription's deliveries first inside the same scoped tx (RLS-fenced), then remove
  // the subscription. Operator-initiated, so dropping its delivery ledger is acceptable — and it is
  // now a ledger somebody may be reading (issue #305), which is why the order is written down.
  const count = await runScopedOn(base, ctx, async (db) => {
    await db.outboundWebhookDelivery.deleteMany({
      where: { subscriptionId: id },
    });
    const res = await db.webhookSubscription.deleteMany({ where: { id } });
    return res.count;
  });
  if (count === 0)
    throw new NotFoundError(
      "webhook subscription not found",
      "errors.webhookSubscriptionNotFound",
    );
  // Deleting the last `heartbeat` subscription must cancel the per-tenant emitter.
  if (ctx.tenantId !== null) await syncTenantHeartbeat(ctx.tenantId, base);
}
