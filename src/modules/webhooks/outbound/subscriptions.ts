import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { redactEndpoint } from "@/modules/audit/projection";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import { readableVaultRef, requireVaultRef } from "@/modules/vault/service";
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
  // Whether a signing secret is CONFIGURED, which `secretRef` alone can no longer answer: a value
  // this column held before #126 may name no vault entry, and `readableVaultRef` hides those rather
  // than publish whatever text is in there. Without this the console cannot tell "unsigned" from
  // "signed with something I may not show you", and its save would clear the second one.
  hasSecret: boolean;
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
    // Through the vault's own reader, never verbatim: this column predates #126 and can hold
    // arbitrary text. See `readableVaultRef`.
    secretRef: readableVaultRef(row.secretRef),
    hasSecret: row.secretRef !== null,
    // The stored set is the closed union by construction (validated on write); cast for the DTO.
    events: row.events as OutboundEvent[],
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// What the audit row carries: the subscription as the operator sees it, minus the identifiers and
// timestamps the row already holds in its own columns.
//
// The URL is REDACTED to its origin even though the column holds it in the clear and every read
// surface returns it whole, because those are deletable and this row is not: an operator who pastes
// a Discord webhook here and corrects it a minute later would otherwise have left its token in an
// append-only row. Where the value is STORED says nothing about whether it is a secret, and the
// destinations these are pointed at put the credential in the path — `redactEndpoint` says the rest.
// Identity is not lost: the row's `target` names this subscription exactly.
//
// `secretRef` is on it, and what reaches the row is the DTO's redacted form: this service canonicalizes
// every value it writes, but the column predates that guard (#126) and holds whatever came in before,
// and this row is append-only. Recording it is the point — rotating or clearing a signing secret
// changes what a receiver verifying HMAC sees, and that is exactly the class of change a trail exists
// to attribute.
//
// `secretRefOpaque` is what keeps that true once the redaction exists. Without it a value the read
// cannot show reads as null on BOTH sides of a clear, `projectionMoved` sees nothing, and the one save
// that removed a signing secret writes no row at all.
function auditProjection(dto: WebhookSubscriptionDto) {
  return {
    urlMasked: redactEndpoint(dto.url),
    events: dto.events,
    enabled: dto.enabled,
    secretRef: dto.secretRef,
    secretRefOpaque: dto.hasSecret && dto.secretRef === null,
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
      ? await requireVaultRef(db, parsed.secretRef, "secretRef")
      : null;
    const created = await db.webhookSubscription.create({
      data: {
        tenantId,
        url: parsed.url,
        events,
        secretRef,
        enabled: parsed.enabled ?? true,
      },
      select: SELECT,
    });
    await auditMutation(db, ctx, {
      action: "webhook.create",
      target: `webhook:${created.id}`,
      after: auditProjection(toDto(created)),
    });
    return created;
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
      data.secretRef = await requireVaultRef(db, data.secretRef, "secretRef");
    }
    // LOCKED, then read, and both inside the transaction the write happens in. The MCP tool read
    // this one layer up and outside any transaction, which is the half of the seam that could not be
    // fixed from up there — and an unlocked read in here is only better by a margin: at READ
    // COMMITTED two concurrent PATCHes both read state A, the first commits B, and the second's
    // `updateMany` then blocks, wakes, writes C and files a row saying A became C. B's change is
    // attributed to whoever wrote C. Six of the audited families already take this lock before their
    // snapshot (`agents`, `tenants`, `tenant_settings`, branding by advisory lock, and the delivery
    // requeue two files away); this is the same statement at a seventh site.
    await db.$queryRaw`SELECT 1 FROM "webhook_subscriptions" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.webhookSubscription.findFirst({
      where: { id },
      select: SELECT,
    });
    const res = await db.webhookSubscription.updateMany({
      where: { id },
      data,
    });
    if (res.count === 0 || !current)
      throw new NotFoundError(
        "webhook subscription not found",
        "errors.webhookSubscriptionNotFound",
      );
    const updated = await db.webhookSubscription.findFirst({
      where: { id },
      select: SELECT,
    });
    if (updated) {
      const before = auditProjection(toDto(current));
      const shown = auditProjection(toDto(updated));
      // A destination that moved where the projection cannot show it: two URLs on the same host
      // redact to the same string, and rotating the token of a Discord-shaped endpoint is exactly
      // that shape. The boolean is what the row carries instead — that it changed, never what it
      // changed to.
      const hidden =
        current.url !== updated.url && before.urlMasked === shown.urlMasked;
      const after = hidden ? { ...shown, urlReplaced: true } : shown;
      // The trail records changes: a caller is free to PATCH a field to the value it already holds.
      if (hidden || projectionMoved(before, after)) {
        await auditMutation(db, ctx, {
          action: "webhook.update",
          target: `webhook:${id}`,
          before,
          after,
        });
      }
    }
    return updated;
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
    // Locked, then read before the delete: the row is what the audit records, and after
    // `deleteMany` there is nothing left to name what was removed. The lock is the same one the
    // update takes, and for the same reason — an update committing between this read and the delete
    // would leave the row describing a subscription that no longer looked like that.
    await db.$queryRaw`SELECT 1 FROM "webhook_subscriptions" WHERE "id" = ${id} FOR UPDATE`;
    const current = await db.webhookSubscription.findFirst({
      where: { id },
      select: SELECT,
    });
    await db.outboundWebhookDelivery.deleteMany({
      where: { subscriptionId: id },
    });
    const res = await db.webhookSubscription.deleteMany({ where: { id } });
    if (res.count > 0 && current) {
      await auditMutation(db, ctx, {
        action: "webhook.delete",
        target: `webhook:${id}`,
        before: auditProjection(toDto(current)),
      });
    }
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
