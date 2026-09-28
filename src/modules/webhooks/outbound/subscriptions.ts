import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { redactEndpoint } from "@/modules/audit/projection";
import { auditMutation, projectionMoved } from "@/modules/audit/service";
import {
  readableVaultRef,
  requireVaultRef,
  type SigningState,
  signingStateFor,
  vaultRefStates,
} from "@/modules/vault/service";
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
  // Whether a signing secret is CONFIGURED, which `secretRef` alone cannot answer: a legacy value
  // may name no vault entry, and `readableVaultRef` hides it. Without this the console cannot tell
  // "unsigned" from "signed with something I may not show you", and its save would clear the second.
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
    // Through the vault's own reader, never verbatim: legacy rows can hold arbitrary text. See
    // `readableVaultRef`.
    secretRef: readableVaultRef(row.secretRef),
    hasSecret: row.secretRef !== null,
    // The stored set is the closed union by construction (validated on write); cast for the DTO.
    events: row.events as OutboundEvent[],
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// What the audit row carries: the subscription as the operator sees it, minus identifiers and
// timestamps. The URL is REDACTED to its origin because the audit row is append-only and webhook
// destinations put the credential in the path (see `redactEndpoint`); `target` still names the row.
// `secretRef` is recorded in the DTO's redacted form, since a signing-secret change is exactly what a
// trail must attribute; `secretRefOpaque` keeps clearing an unshowable ref visible as a change.
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
// Exported because the MCP preview has to reach the same verdict the write does: it answers without
// calling either writer below.
export async function assertUrlSafe(url: string): Promise<void> {
  await assertSafeOutboundUrl(url);
}

// WHY THE LIST HAS ITS OWN TYPE: `signingState` needs the VAULT (a deleted credential must not read
// as signed), and `toDto` also builds `auditProjection` inside the audit transaction, where it must
// stay pure. The list is the one caller that needs the answer, so it pays for the query.
export interface WebhookSubscriptionListItem extends WebhookSubscriptionDto {
  signingState: SigningState;
}

export async function listWebhookSubscriptions(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<WebhookSubscriptionListItem[]> {
  return await runScopedOn(base, ctx, async (db) => {
    const rows = await db.webhookSubscription.findMany({
      select: SELECT,
      orderBy: { id: "asc" },
    });
    // One extra query for the whole page, inside the same scoped transaction as the rows — the vault
    // is tenant-scoped too, so this cannot be hoisted out of the RLS fence.
    const states = await vaultRefStates(
      db,
      rows.map((r) => r.secretRef),
    );
    return rows.map((r) => {
      const dto = toDto(r);
      return {
        ...dto,
        signingState: signingStateFor(r.secretRef, dto.secretRef, states),
      };
    });
  });
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

// EVERYTHING `createWebhookSubscription` decides about its input: the schema (a url at most 2048
// characters, at least one event), the events against the catalog, and where the url points. Split
// out so the MCP preview asks the whole question the apply asks, not part of it.
export async function assertWebhookSubscriptionCreatable(
  input: WebhookSubscriptionCreate,
): Promise<{ parsed: WebhookSubscriptionCreate; events: string[] }> {
  const parsed = parseInput(webhookSubscriptionCreateSchema, input);
  const events = assertKnownEvents(parsed.events);
  await assertUrlSafe(parsed.url);
  return { parsed, events };
}

export async function createWebhookSubscription(
  ctx: TenantContext,
  input: WebhookSubscriptionCreate,
  base: PrismaClient = basePrisma,
): Promise<WebhookSubscriptionDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const { parsed, events } = await assertWebhookSubscriptionCreatable(input);
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

// The update's half of the same split. `events` is optional here but still `.min(1)` when present,
// so an explicit empty array is a refusal the preview owed its caller.
export async function assertWebhookSubscriptionUpdatable(
  patch: WebhookSubscriptionUpdate,
): Promise<{ parsed: WebhookSubscriptionUpdate; events?: string[] }> {
  const parsed = parseInput(webhookSubscriptionUpdateSchema, patch);
  if (parsed.url !== undefined) await assertUrlSafe(parsed.url);
  return {
    parsed,
    events:
      parsed.events !== undefined
        ? assertKnownEvents(parsed.events)
        : undefined,
  };
}

export async function updateWebhookSubscription(
  ctx: TenantContext,
  id: bigint,
  patch: WebhookSubscriptionUpdate,
  base: PrismaClient = basePrisma,
): Promise<WebhookSubscriptionDto> {
  const { parsed, events } = await assertWebhookSubscriptionUpdatable(patch);
  const data: Record<string, unknown> = {};
  if (parsed.url !== undefined) data.url = parsed.url;
  if (events !== undefined) data.events = events;
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
    // NOTE: LOCKED, then read, inside the write's transaction: at READ COMMITTED two concurrent
    // PATCHes would both read A, and the second would file "A became C", misattributing B. Same
    // lock-before-snapshot as the other audited families.
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
  // the subscription. Operator-initiated, so dropping its delivery ledger is acceptable.
  const count = await runScopedOn(base, ctx, async (db) => {
    // Locked, then read before the delete: the row is what the audit records, and after
    // `deleteMany` there is nothing left to name what was removed. The lock is the same one the
    // update takes, and for the same reason: an update committing between this read and the delete
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
