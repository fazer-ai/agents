import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { revokeApiKey } from "@/modules/api-keys/service";
import {
  createBusinessHours,
  deleteBusinessHours,
  getBusinessHours,
  updateBusinessHours,
} from "@/modules/business-hours/service";
import {
  createExperiment,
  deleteExperiment,
  getExperiment,
  updateExperiment,
} from "@/modules/experiments/service";
import {
  getTenantSettings,
  updateEmbeddingSettings,
  updateLangfuse,
} from "@/modules/tenant-settings/service";
import {
  createVaultEntry,
  resolveVaultRefByName,
  updateVaultEntry,
  vaultNameByRef,
  vaultRefWhere,
} from "@/modules/vault/service";
import type { VerifiedToken } from "./oauth/tokens";
import {
  diffFields,
  err,
  gate,
  ok,
  recordMcpAudit,
  resolveSecretRef,
  truncForAudit,
  type WriteDeps,
  type WriteResult,
} from "./write";

// MCP settings write tools: A/B experiments, business hours, tenant settings (embedding +
// Langfuse) and API-key revocation. Spine: gate → dry-run preview → apply + audit. credentialRef
// values travel by vault NAME (resolveSecretRef → vault:<id>); never a raw secret. API-key CREATION
// stays out of MCP (its plaintext token would have to cross the model) — only revoke is exposed.

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

// ── A/B prompt experiments ──

interface VariantArg {
  key: string;
  weight?: number;
  system_prompt?: string;
}

function mapVariants(variants: VariantArg[]) {
  return variants.map((v) => ({
    key: v.key,
    weight: v.weight,
    systemPrompt: v.system_prompt,
  }));
}

export async function experimentCreate(
  principal: VerifiedToken,
  args: {
    name: string;
    agent_id?: string | null;
    variants: VariantArg[];
    enabled?: boolean;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const tenantId = ctx.tenantId as bigint;
  let agentId: bigint | undefined;
  if (args.agent_id) {
    const parsed = parseId(args.agent_id, "agent_id");
    if (typeof parsed !== "bigint") return parsed;
    agentId = parsed;
  }
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "experiment",
        preview: {
          name: args.name,
          agentId: agentId ? String(agentId) : null,
          variants: mapVariants(args.variants),
          enabled: args.enabled ?? true,
        },
      });
    }
    const created = await createExperiment({
      tenantId,
      name: args.name,
      agentId,
      variants: mapVariants(args.variants),
      enabled: args.enabled,
      base,
    });
    const target = `experiment:${created.id}`;
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.experiment_create",
      target,
      before: null,
      after: truncForAudit({ id: String(created.id), name: args.name }),
    });
    return ok({ dryRun: false, applied: true, id: String(created.id), target });
  } catch (e) {
    return failOf(e);
  }
}

export async function experimentUpdate(
  principal: VerifiedToken,
  args: {
    experiment_id: string;
    name?: string;
    agent_id?: string | null;
    variants?: VariantArg[];
    enabled?: boolean;
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const tenantId = ctx.tenantId as bigint;
  const id = parseId(args.experiment_id, "experiment_id");
  if (typeof id !== "bigint") return id;
  const patch: {
    name?: string;
    agentId?: bigint | null;
    variants?: ReturnType<typeof mapVariants>;
    enabled?: boolean;
  } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.enabled !== undefined) patch.enabled = args.enabled;
  if (args.variants !== undefined) patch.variants = mapVariants(args.variants);
  if (args.agent_id !== undefined) {
    if (args.agent_id === null) patch.agentId = null;
    else {
      const parsed = parseId(args.agent_id, "agent_id");
      if (typeof parsed !== "bigint") return parsed;
      patch.agentId = parsed;
    }
  }
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (name, agent_id, variants, enabled)",
    );
  }
  try {
    const current = await getExperiment(tenantId, id, base);
    const target = `experiment:${id}`;
    const beforeProj = {
      name: current.name,
      enabled: current.enabled,
      agentId: current.agentId ? String(current.agentId) : null,
    };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        target,
        proposed: {
          name: patch.name ?? current.name,
          enabled: patch.enabled ?? current.enabled,
        },
      });
    }
    const updated = await updateExperiment({ tenantId, id, ...patch, base });
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.experiment_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit({
        name: updated.name,
        enabled: updated.enabled,
        agentId: updated.agentId ? String(updated.agentId) : null,
      }),
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

export async function experimentDelete(
  principal: VerifiedToken,
  args: { experiment_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const tenantId = ctx.tenantId as bigint;
  const id = parseId(args.experiment_id, "experiment_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getExperiment(tenantId, id, base);
    const target = `experiment:${id}`;
    const beforeProj = { id: String(current.id), name: current.name };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteExperiment(tenantId, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.experiment_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// ── business hours ──

interface WindowArg {
  day: number;
  start: string;
  end: string;
}

interface ExceptionArg {
  date: string;
  dateEnd?: string;
  recurring?: boolean;
  label?: string;
  ranges: Array<{ start: string; end: string }>;
}

export async function businessHoursCreate(
  principal: VerifiedToken,
  args: {
    name: string;
    timezone?: string;
    windows?: WindowArg[];
    exceptions?: ExceptionArg[];
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "create",
        resource: "business_hours",
        preview: {
          name: args.name,
          timezone: args.timezone ?? null,
          windows: args.windows ?? [],
          exceptions: args.exceptions ?? [],
        },
      });
    }
    const created = await createBusinessHours(
      ctx,
      {
        name: args.name,
        timezone: args.timezone,
        windows: args.windows,
        exceptions: args.exceptions,
      },
      base,
    );
    const target = `business_hours:${created.id}`;
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.business_hours_create",
      target,
      before: null,
      after: truncForAudit({ id: created.id, name: created.name }),
    });
    return ok({ dryRun: false, applied: true, target, businessHours: created });
  } catch (e) {
    return failOf(e);
  }
}

export async function businessHoursUpdate(
  principal: VerifiedToken,
  args: {
    business_hours_id: string;
    name?: string;
    timezone?: string;
    windows?: WindowArg[];
    exceptions?: ExceptionArg[];
    dry_run?: boolean;
  },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.business_hours_id, "business_hours_id");
  if (typeof id !== "bigint") return id;
  const patch: {
    name?: string;
    timezone?: string;
    windows?: WindowArg[];
    exceptions?: ExceptionArg[];
  } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (args.timezone !== undefined) patch.timezone = args.timezone;
  if (args.windows !== undefined) patch.windows = args.windows;
  if (args.exceptions !== undefined) patch.exceptions = args.exceptions;
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (name, timezone, windows, exceptions)",
    );
  }
  try {
    const current = await getBusinessHours(ctx, id, base);
    const target = `business_hours:${id}`;
    const beforeProj = {
      name: current.name,
      timezone: current.timezone,
      windows: current.windows,
      exceptions: current.exceptions,
    };
    if (args.dry_run !== false) {
      const previewAfter = {
        name: patch.name ?? current.name,
        timezone: patch.timezone ?? current.timezone,
        windows: patch.windows ?? current.windows,
        exceptions: patch.exceptions ?? current.exceptions,
      };
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, previewAfter),
      });
    }
    const updated = await updateBusinessHours(ctx, id, patch, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.business_hours_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit({
        name: updated.name,
        timezone: updated.timezone,
        windows: updated.windows,
        exceptions: updated.exceptions,
      }),
    });
    return ok({ dryRun: false, applied: true, target, businessHours: updated });
  } catch (e) {
    return failOf(e);
  }
}

export async function businessHoursDelete(
  principal: VerifiedToken,
  args: { business_hours_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.business_hours_id, "business_hours_id");
  if (typeof id !== "bigint") return id;
  try {
    const current = await getBusinessHours(ctx, id, base);
    const target = `business_hours:${id}`;
    const beforeProj = { id: current.id, name: current.name };
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "delete",
        target,
        current: beforeProj,
      });
    }
    await deleteBusinessHours(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.business_hours_delete",
      target,
      before: truncForAudit(beforeProj),
      after: null,
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}

// ── tenant settings (embedding / langfuse) ──

export interface TenantSettingsUpdateArgs {
  embedding?: { credential_ref?: string | null };
  langfuse?: {
    enabled?: boolean;
    credential_ref?: string | null;
    send_content?: boolean;
    debug?: boolean;
  };
  dry_run?: boolean;
}

export async function tenantSettingsUpdate(
  principal: VerifiedToken,
  args: TenantSettingsUpdateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  if (args.embedding === undefined && args.langfuse === undefined) {
    return err("no updatable blocks provided (embedding, langfuse)");
  }

  // Resolve credential NAMES → vault:<id> (null clears; undefined leaves untouched).
  let embeddingRef: string | null | undefined;
  if (args.embedding?.credential_ref !== undefined) {
    if (
      args.embedding.credential_ref === null ||
      args.embedding.credential_ref === ""
    ) {
      embeddingRef = null;
    } else {
      const resolved = await resolveSecretRef(
        ctx,
        args.embedding.credential_ref,
        base,
      );
      if ("fail" in resolved) return resolved.fail;
      embeddingRef = resolved.ref;
    }
  }
  let langfuseRef: string | null | undefined;
  if (args.langfuse?.credential_ref !== undefined) {
    if (
      args.langfuse.credential_ref === null ||
      args.langfuse.credential_ref === ""
    ) {
      langfuseRef = null;
    } else {
      const resolved = await resolveSecretRef(
        ctx,
        args.langfuse.credential_ref,
        base,
        "langfuse",
      );
      if ("fail" in resolved) return resolved.fail;
      langfuseRef = resolved.ref;
    }
  }

  const target = "tenant_settings";
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        target,
        proposed: {
          embedding:
            args.embedding === undefined
              ? undefined
              : { credentialRef: args.embedding.credential_ref ?? null },
          langfuse:
            args.langfuse === undefined
              ? undefined
              : {
                  enabled: args.langfuse.enabled,
                  credentialRef: args.langfuse.credential_ref ?? null,
                  sendContent: args.langfuse.send_content,
                  debug: args.langfuse.debug,
                },
        },
      });
    }
    const before = await getTenantSettings(ctx, base);
    if (args.embedding !== undefined) {
      await updateEmbeddingSettings(ctx, { credentialRef: embeddingRef }, base);
    }
    if (args.langfuse !== undefined) {
      await updateLangfuse(
        ctx,
        {
          enabled: args.langfuse.enabled,
          credentialRef: langfuseRef,
          sendContent: args.langfuse.send_content,
          debug: args.langfuse.debug,
        },
        base,
      );
    }
    const after = await getTenantSettings(ctx, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.tenant_settings_update",
      target,
      before: truncForAudit({
        embedding: {
          credentialRef: before.embedding.credentialRef,
          model: before.embedding.model,
        },
        langfuse: {
          enabled: before.langfuse.enabled,
          sendContent: before.langfuse.sendContent,
          debug: before.langfuse.debug,
          credentialRef: before.langfuse.credentialRef,
        },
      }),
      after: truncForAudit({
        embedding: {
          credentialRef: after.embedding.credentialRef,
          model: after.embedding.model,
        },
        langfuse: {
          enabled: after.langfuse.enabled,
          sendContent: after.langfuse.sendContent,
          debug: after.langfuse.debug,
          credentialRef: after.langfuse.credentialRef,
        },
      }),
    });
    // Project stored vault:<id> refs back to NAMES for the response (never a secret value).
    const embName = after.embedding.credentialRef
      ? await vaultNameByRef(ctx, after.embedding.credentialRef, base)
      : null;
    const lfName = after.langfuse.credentialRef
      ? await vaultNameByRef(ctx, after.langfuse.credentialRef, base)
      : null;
    return ok({
      dryRun: false,
      applied: true,
      target,
      settings: {
        embedding: { ...after.embedding, credentialRef: embName },
        langfuse: { ...after.langfuse, credentialRef: lfName },
      },
    });
  } catch (e) {
    return failOf(e);
  }
}

// ── Langfuse connect (provision-and-wire in one step) ──

export interface LangfuseConnectArgs {
  public_key: string;
  secret_key: string;
  base_url: string;
  name?: string;
  enabled?: boolean;
  send_content?: boolean;
  dry_run?: boolean;
}

// Wire a Langfuse deployment the agent provisioned. The public/secret key pair is an infra secret the
// caller already holds (it generated the pair and seeded it into Langfuse via LANGFUSE_INIT): passed RAW
// here, used in-band to fill the vault, and kept out of the audit (metadata only). Upserts the filled
// kind:langfuse vault entry (encrypted) AND turns tracing on, in one step — the MCP analogue of
// deployment_connect. This is why the "no raw secret over MCP" rule does not bind here: it binds the
// USER's credentials (OpenAI etc., filled by deeplink), not an infra secret the agent provisioned.
export async function langfuseConnect(
  principal: VerifiedToken,
  args: LangfuseConnectArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  // mcp:write (like the analogous deployment_connect and the tenant_settings_update it writes); a
  // TENANT_ADMIN can already wire Langfuse by hand, so gating this convenience to admin adds nothing.
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  if (!args.public_key || !args.secret_key) {
    return err("public_key and secret_key are required");
  }
  if (!args.base_url) return err("base_url is required");
  const name = args.name?.trim() || "langfuse";
  const enabled = args.enabled ?? true;
  if (args.dry_run !== false) {
    return ok({
      dryRun: true,
      action: "connect",
      resource: "langfuse",
      // The keys are never echoed back, not even in the preview.
      preview: {
        name,
        baseUrl: args.base_url,
        enabled,
        publicKey: "(redacted)",
        secretKey: "(redacted)",
      },
    });
  }
  try {
    // Upsert the filled vault entry so a re-connect (e.g. rotated keys) is idempotent.
    const existing = await resolveVaultRefByName(ctx, name, "langfuse", base);
    let ref: string;
    if (existing.status === "ambiguous") {
      return err(`vault name '${name}' is ambiguous; pass a distinct 'name'`);
    }
    const value = { publicKey: args.public_key, secretKey: args.secret_key };
    if (existing.status === "found") {
      await updateVaultEntry(
        ctx,
        vaultRefWhere(existing.ref).id,
        { value, baseUrl: args.base_url },
        base,
      );
      ref = existing.ref;
    } else {
      const created = await createVaultEntry(
        ctx,
        { name, value, kind: "langfuse", baseUrl: args.base_url },
        undefined,
        undefined,
        base,
      );
      ref = created.ref;
    }
    const settings = await updateLangfuse(
      ctx,
      { enabled, credentialRef: ref, sendContent: args.send_content },
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.langfuse_connect",
      target: "tenant_settings:langfuse",
      before: null,
      after: truncForAudit({
        credentialName: name,
        baseUrl: args.base_url,
        enabled: settings.enabled,
      }),
    });
    const lfName = settings.credentialRef
      ? await vaultNameByRef(ctx, settings.credentialRef, base)
      : null;
    return ok({
      dryRun: false,
      applied: true,
      target: "tenant_settings:langfuse",
      langfuse: { ...settings, credentialRef: lfName },
    });
  } catch (e) {
    return failOf(e);
  }
}

// ── API keys (revoke only; creation stays UI-only since its token cannot cross the model) ──

export async function apiKeyRevoke(
  principal: VerifiedToken,
  args: { api_key_id: string; dry_run?: boolean },
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const id = parseId(args.api_key_id, "api_key_id");
  if (typeof id !== "bigint") return id;
  const target = `api_key:${id}`;
  try {
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        action: "revoke",
        target,
        note: "Revokes the API key immediately (the key stops authenticating).",
      });
    }
    await revokeApiKey(ctx, id, base);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.api_key_revoke",
      target,
      before: null,
      after: truncForAudit({ revoked: true }),
    });
    return ok({ dryRun: false, applied: true, target });
  } catch (e) {
    return failOf(e);
  }
}
