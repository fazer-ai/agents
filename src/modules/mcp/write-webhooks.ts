import type { InboundAuthStrategy } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import {
  createAlertChannel,
  deleteAlertChannel,
  listAlertChannels,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import { isKnownCatalogType } from "@/modules/integrations/catalog";
import {
  createIntegrationInstance,
  deleteIntegrationInstance,
  getIntegrationInstance,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import { isOutboundEvent } from "@/modules/webhooks/outbound/events";
import {
  createWebhookSubscription,
  deleteWebhookSubscription,
  listWebhookSubscriptions,
  updateWebhookSubscription,
} from "@/modules/webhooks/outbound/subscriptions";
import { sendWebhookTest } from "@/modules/webhooks/outbound/test";
import { integrationsUrl } from "./console-links";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  recordMcpAudit,
  resolveSecretRef,
  resolveSecretValue,
  truncForAudit,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP webhook + alert + integration write tools. These register EXTERNAL destinations (the
// outbound worker has SSRF/HMAC; the alert/integration URLs are operator-supplied). Secrets travel by
// reference: webhook/integration signing secrets are vault NAMES (resolveSecretRef → vault:<id>), the
// token-bearing alert URL is a vault NAME (resolveSecretValue → plaintext, server-side only), and a
// generated integration route token is NOT returned raw — the tool returns a console URL to reveal it.

function failOf(e: unknown): WriteResult {
  if (e instanceof AppError) return err(e.message);
  throw e;
}

function parseId(raw: string, label: string): bigint | WriteResult {
  try {
    return BigInt(raw);
  } catch {
    return err(`invalid ${label}`);
  }
}

// ── outbound webhooks ──

export interface WebhookCreateArgs {
  url: string;
  events: string[];
  secret_ref?: string | null;
  enabled?: boolean;
  dry_run?: boolean;
}

export async function webhookCreate(
  principal: VerifiedToken,
  args: WebhookCreateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const bad = args.events.filter((e) => !isOutboundEvent(e));
  if (bad.length) return err(`unknown event(s): ${bad.join(", ")}`);
  let secretRef: string | null | undefined;
  if (args.secret_ref) {
    const resolved = await resolveSecretRef(ctx, args.secret_ref, base);
    if ("fail" in resolved) return resolved.fail;
    secretRef = resolved.ref;
  }
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "webhook",
        preview: {
          url: args.url,
          events: args.events,
          secretRef: args.secret_ref ?? null,
          enabled: args.enabled ?? true,
        },
      });
    }
    const created = await createWebhookSubscription(
      ctx,
      {
        url: args.url,
        events: args.events,
        secretRef,
        enabled: args.enabled,
      },
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.webhook_create",
      target: `webhook:${created.id}`,
      before: null,
      after: truncForAudit({
        id: created.id,
        url: created.url,
        events: created.events,
      }),
    });
    return ok({ dryRun: false, applied: true, webhook: created });
  } catch (e) {
    return failOf(e);
  }
}

export interface WebhookUpdateArgs {
  webhook_id: string;
  url?: string;
  events?: string[];
  secret_ref?: string | null;
  enabled?: boolean;
  dry_run?: boolean;
}

export async function webhookUpdate(
  principal: VerifiedToken,
  args: WebhookUpdateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.webhook_id, "webhook_id");
  if (typeof id !== "bigint") return id;
  if (args.events) {
    const bad = args.events.filter((e) => !isOutboundEvent(e));
    if (bad.length) return err(`unknown event(s): ${bad.join(", ")}`);
  }
  const patch: {
    url?: string;
    events?: string[];
    secretRef?: string | null;
    enabled?: boolean;
  } = {};
  if (args.url !== undefined) patch.url = args.url;
  if (args.events !== undefined) patch.events = args.events;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.secret_ref !== undefined) {
    if (args.secret_ref === null || args.secret_ref === "") {
      patch.secretRef = null;
    } else {
      const resolved = await resolveSecretRef(ctx, args.secret_ref, base);
      if ("fail" in resolved) return resolved.fail;
      patch.secretRef = resolved.ref;
    }
  }
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (url, events, secret_ref, enabled)",
    );
  }
  try {
    const all = await listWebhookSubscriptions(ctx, base);
    const current = all.find((w) => w.id === String(id));
    if (!current) return err("webhook not found");
    const target = `webhook:${id}`;
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of Object.keys(patch) as (keyof typeof patch)[]) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = patch[k];
    }
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, afterProj),
      });
    }
    const updated = await updateWebhookSubscription(ctx, id, patch, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.webhook_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit({
        url: updated.url,
        events: updated.events,
        enabled: updated.enabled,
      }),
    });
    return ok({ dryRun: false, applied: true, target, webhook: updated });
  } catch (e) {
    return failOf(e);
  }
}

export async function webhookDelete(
  principal: VerifiedToken,
  args: { webhook_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.webhook_id, "webhook_id");
  if (typeof id !== "bigint") return id;
  try {
    const all = await listWebhookSubscriptions(ctx, base);
    const current = all.find((w) => w.id === String(id));
    if (!current) return err("webhook not found");
    const target = `webhook:${id}`;
    const beforeProj = {
      id: current.id,
      url: current.url,
      events: current.events,
    };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteWebhookSubscription(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.webhook_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// Send a signed test event to a registered webhook's destination. External request; runs immediately
// (the per-call approval of the MCP client is the gate). Returns delivery status, never state change.
export async function webhookTest(
  principal: VerifiedToken,
  args: { webhook_id: string },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.webhook_id, "webhook_id");
  if (typeof id !== "bigint") return id;
  try {
    return ok({ result: await sendWebhookTest(ctx, id, base) });
  } catch (e) {
    return failOf(e);
  }
}

// ── alert channels ──

export interface AlertChannelCreateArgs {
  name: string;
  type: "discord" | "webhook";
  url_ref: string;
  min_level?: "info" | "warn" | "error";
  stages?: string[];
  secret_ref?: string | null;
  enabled?: boolean;
  dry_run?: boolean;
}

export async function alertChannelCreate(
  principal: VerifiedToken,
  args: AlertChannelCreateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  // Validate the URL credential exists (the token-bearing URL is stored as a vault secret).
  const urlRefCheck = await resolveSecretRef(ctx, args.url_ref, base);
  if ("fail" in urlRefCheck) return urlRefCheck.fail;
  let secretRef: string | null | undefined;
  if (args.secret_ref) {
    const resolved = await resolveSecretRef(ctx, args.secret_ref, base);
    if ("fail" in resolved) return resolved.fail;
    secretRef = resolved.ref;
  }
  if (args.dry_run !== false) {
    return ok({
      dryRun: true,
      action: "create",
      resource: "alert_channel",
      preview: {
        name: args.name,
        type: args.type,
        urlRef: args.url_ref,
        minLevel: args.min_level ?? "error",
        stages: args.stages ?? [],
        secretRef: args.secret_ref ?? null,
        enabled: args.enabled ?? true,
      },
    });
  }
  const url = await resolveSecretValue(ctx, args.url_ref, base);
  if ("fail" in url) return url.fail;
  try {
    const created = await createAlertChannel(
      ctx,
      {
        name: args.name,
        type: args.type,
        url: url.value,
        minLevel: args.min_level,
        stages: args.stages,
        secretRef,
        enabled: args.enabled,
      },
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.alert_channel_create",
      target: `alert_channel:${created.id}`,
      before: null,
      after: truncForAudit({
        id: created.id,
        name: created.name,
        type: created.type,
        urlMasked: created.urlMasked,
      }),
    });
    return ok({ dryRun: false, applied: true, channel: created });
  } catch (e) {
    return failOf(e);
  }
}

export interface AlertChannelUpdateArgs {
  channel_id: string;
  name?: string;
  type?: "discord" | "webhook";
  url_ref?: string;
  min_level?: "info" | "warn" | "error";
  stages?: string[];
  secret_ref?: string | null;
  enabled?: boolean;
  dry_run?: boolean;
}

interface AlertChannelPatch {
  name?: string;
  type?: "discord" | "webhook";
  url?: string;
  minLevel?: "info" | "warn" | "error";
  stages?: string[];
  secretRef?: string | null;
  enabled?: boolean;
}

export async function alertChannelUpdate(
  principal: VerifiedToken,
  args: AlertChannelUpdateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.channel_id, "channel_id");
  if (typeof id !== "bigint") return id;
  if (args.url_ref !== undefined) {
    const refCheck = await resolveSecretRef(ctx, args.url_ref, base);
    if ("fail" in refCheck) return refCheck.fail;
  }
  let secretRef: string | null | undefined;
  if (args.secret_ref !== undefined) {
    if (args.secret_ref === null || args.secret_ref === "") {
      secretRef = null;
    } else {
      const resolved = await resolveSecretRef(ctx, args.secret_ref, base);
      if ("fail" in resolved) return resolved.fail;
      secretRef = resolved.ref;
    }
  }
  // Non-secret fields only (used for the diff preview); url/secretRef are handled separately.
  const nonSecret: AlertChannelPatch = {};
  if (args.name !== undefined) nonSecret.name = args.name;
  if (args.type !== undefined) nonSecret.type = args.type;
  if (args.min_level !== undefined) nonSecret.minLevel = args.min_level;
  if (args.stages !== undefined) nonSecret.stages = args.stages;
  if (args.enabled !== undefined) nonSecret.enabled = args.enabled;
  const urlRotated = args.url_ref !== undefined;
  const secretRotated = args.secret_ref !== undefined;
  if (Object.keys(nonSecret).length === 0 && !urlRotated && !secretRotated) {
    return err("no updatable fields provided");
  }
  try {
    const all = await listAlertChannels(ctx, base);
    const current = all.find((c) => c.id === String(id));
    if (!current) return err("alert channel not found");
    const target = `alert_channel:${id}`;
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of Object.keys(nonSecret) as (keyof AlertChannelPatch)[]) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = nonSecret[k];
    }
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, afterProj),
        urlRotated,
        secretRotated,
      });
    }
    const patch: AlertChannelPatch = { ...nonSecret };
    if (urlRotated && args.url_ref !== undefined) {
      const url = await resolveSecretValue(ctx, args.url_ref, base);
      if ("fail" in url) return url.fail;
      patch.url = url.value;
    }
    if (secretRotated) patch.secretRef = secretRef;
    const updated = await updateAlertChannel(ctx, id, patch, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.alert_channel_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit({
        urlMasked: updated.urlMasked,
        urlRotated,
        secretRotated,
      }),
    });
    return ok({ dryRun: false, applied: true, target, channel: updated });
  } catch (e) {
    return failOf(e);
  }
}

export async function alertChannelDelete(
  principal: VerifiedToken,
  args: { channel_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.channel_id, "channel_id");
  if (typeof id !== "bigint") return id;
  try {
    const all = await listAlertChannels(ctx, base);
    const current = all.find((c) => c.id === String(id));
    if (!current) return err("alert channel not found");
    const target = `alert_channel:${id}`;
    const beforeProj = {
      id: current.id,
      name: current.name,
      type: current.type,
    };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteAlertChannel(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.alert_channel_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// ── integration instances ──

export interface IntegrationCreateArgs {
  catalog_type: string;
  name: string;
  config?: Record<string, unknown>;
  credential_ref?: string | null;
  inbound_auth_strategy?: "NONE" | "STATIC_HEADER" | "HMAC_SHA256";
  inbound_secret_ref?: string | null;
  enabled?: boolean;
  dry_run?: boolean;
}

export async function integrationCreate(
  principal: VerifiedToken,
  args: IntegrationCreateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  if (!isKnownCatalogType(args.catalog_type)) {
    return err(`unknown catalog_type: ${args.catalog_type}`);
  }
  let credentialRef: string | null | undefined;
  if (args.credential_ref) {
    const resolved = await resolveSecretRef(ctx, args.credential_ref, base);
    if ("fail" in resolved) return resolved.fail;
    credentialRef = resolved.ref;
  }
  let inboundSecretRef: string | null | undefined;
  if (args.inbound_secret_ref) {
    const resolved = await resolveSecretRef(ctx, args.inbound_secret_ref, base);
    if ("fail" in resolved) return resolved.fail;
    inboundSecretRef = resolved.ref;
  }
  const tenantId = ctx.tenantId as bigint;
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "integration",
        preview: {
          catalogType: args.catalog_type,
          name: args.name,
          config: args.config ?? {},
          credentialRef: args.credential_ref ?? null,
          inboundAuthStrategy: args.inbound_auth_strategy ?? null,
          inboundSecretRef: args.inbound_secret_ref ?? null,
          enabled: args.enabled ?? true,
        },
      });
    }
    const created = await createIntegrationInstance(
      tenantId,
      {
        catalogType: args.catalog_type,
        name: args.name,
        config: args.config,
        credentialRef,
        inboundAuthStrategy: args.inbound_auth_strategy as
          | InboundAuthStrategy
          | undefined,
        inboundSecretRef,
        enabled: args.enabled,
      },
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.integration_create",
      target: `integration:${created.id}`,
      before: null,
      after: truncForAudit({
        id: String(created.id),
        catalogType: args.catalog_type,
        name: args.name,
      }),
    });
    // The route token is a generated secret: surface it via the console, never raw to the model.
    return ok({
      dryRun: false,
      applied: true,
      id: String(created.id),
      message:
        "Integration created. The inbound route token is shown once in the console; it is not returned here.",
      configureAt: integrationsUrl(ctx.tenantId),
    });
  } catch (e) {
    return failOf(e);
  }
}

export interface IntegrationUpdateArgs {
  integration_id: string;
  name?: string;
  config?: Record<string, unknown>;
  credential_ref?: string | null;
  inbound_auth_strategy?: "NONE" | "STATIC_HEADER" | "HMAC_SHA256";
  inbound_secret_ref?: string | null;
  enabled?: boolean;
  dry_run?: boolean;
}

export async function integrationUpdate(
  principal: VerifiedToken,
  args: IntegrationUpdateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.integration_id, "integration_id");
  if (typeof id !== "bigint") return id;
  const patch: {
    name?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    credentialRef?: string | null;
    inboundAuthStrategy?: InboundAuthStrategy;
    inboundSecretRef?: string | null;
  } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.config !== undefined) patch.config = args.config;
  if (args.inbound_auth_strategy !== undefined)
    patch.inboundAuthStrategy =
      args.inbound_auth_strategy as InboundAuthStrategy;
  if (args.credential_ref !== undefined) {
    if (args.credential_ref === null || args.credential_ref === "") {
      patch.credentialRef = null;
    } else {
      const resolved = await resolveSecretRef(ctx, args.credential_ref, base);
      if ("fail" in resolved) return resolved.fail;
      patch.credentialRef = resolved.ref;
    }
  }
  if (args.inbound_secret_ref !== undefined) {
    if (args.inbound_secret_ref === null || args.inbound_secret_ref === "") {
      patch.inboundSecretRef = null;
    } else {
      const resolved = await resolveSecretRef(
        ctx,
        args.inbound_secret_ref,
        base,
      );
      if ("fail" in resolved) return resolved.fail;
      patch.inboundSecretRef = resolved.ref;
    }
  }
  if (Object.keys(patch).length === 0) {
    return err("no updatable fields provided");
  }
  try {
    const current = await getIntegrationInstance(ctx, id, base);
    const keys = Object.keys(patch) as (keyof typeof patch)[];
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const k of keys) {
      beforeProj[k] = (current as unknown as Record<string, unknown>)[k];
      afterProj[k] = patch[k];
    }
    const target = `integration:${id}`;
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, afterProj),
      });
    }
    const updated = await updateIntegrationInstance(ctx, id, patch, base);
    const appliedProj: Record<string, unknown> = {};
    for (const k of keys)
      appliedProj[k] = (updated as unknown as Record<string, unknown>)[k];
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.integration_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit(appliedProj),
    });
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, appliedProj),
    });
  } catch (e) {
    return failOf(e);
  }
}

export async function integrationDelete(
  principal: VerifiedToken,
  args: { integration_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.integration_id, "integration_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getIntegrationInstance(ctx, id, base);
    const target = `integration:${id}`;
    const beforeProj = {
      id: current.id,
      catalogType: current.catalogType,
      name: current.name,
    };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteIntegrationInstance(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.integration_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}
