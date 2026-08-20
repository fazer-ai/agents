import { ZodError } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  setBrandingAsset,
  updateBrandingColors,
} from "@/api/features/branding/branding.admin.service";
import {
  ALLOWED_ASSET_TYPES,
  ASSET_MAX_BYTES,
  type ColorUpdate,
  getGlobalBranding,
} from "@/api/features/branding/branding.service";
import basePrisma from "@/api/lib/prisma";
import { updateTenant } from "@/api/v1/tenants.admin.service";
import { getTenant } from "@/api/v1/tenants.service";
import config from "@/config";
import { AppError } from "@/lib/errors";
import {
  asSuperAdminOn,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import {
  type BehaviorSettingsPatch,
  mergeBehaviorSettings,
  readBehaviorSettings,
} from "@/modules/agents/behavior-settings";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";
import {
  assertPromptSize,
  assertSettingsTextSizes,
  getAgent,
  listAgents,
  updateAgent,
} from "@/modules/agents/service";
import { type AuditEntry, recordAudit } from "@/modules/audit/service";
import {
  createPendingVaultEntry,
  isVaultIdRef,
  resolveVaultRefByName,
  tryResolveVaultSecret,
  vaultNameByRef,
} from "@/modules/vault/service";
import { hasScope, type VerifiedToken } from "./oauth/tokens";

// MCP write tools — the privileged half of the MCP surface, gated by the hardened-spec guardrails:
//   - scope: mcp:write is REQUIRED (the token's role already filtered scopes at /authorize);
//   - tenant fence: the token MUST be scoped to a tenant (a tenant-less SUPER_ADMIN token cannot
//     write blind — it must target a tenant), and the write is fenced to that tenant by RLS/
//     asSuperAdmin (the tool args never carry a tenant — anti-IDOR);
//   - dry-run by DEFAULT: every tool previews a field-level diff and applies NOTHING unless the
//     caller passes dry_run:false explicitly (preview-before-apply);
//   - audit: a successful apply appends an AuditLog row (actorType "mcp"), before/after
//     allowlist-projected and length-bounded (never the raw model config / secrets).

export type WriteResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string };

export const ok = (data: Record<string, unknown>): WriteResult => ({
  ok: true,
  data,
});
export const err = (error: string): WriteResult => ({ ok: false, error });

export interface WriteDeps {
  base?: PrismaClient;
}

// Field-level diff: only keys whose JSON projection changed appear (before → after).
export function diffFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      out[key] = { before: before[key], after: after[key] };
    }
  }
  return out;
}

const AUDIT_STR_MAX = 4000;

// Bound string sizes in the audit projection (a system prompt can be tens of KB).
export function truncForAudit(v: unknown): unknown {
  if (typeof v === "string") {
    return v.length > AUDIT_STR_MAX
      ? `${v.slice(0, AUDIT_STR_MAX)}…[truncated]`
      : v;
  }
  if (Array.isArray(v)) return v.map(truncForAudit);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) o[k] = truncForAudit(val);
    return o;
  }
  return v;
}

// NOTE: service-layer ZodErrors must surface as a tool result (err), never bubble raw into the
// MCP SDK's generic exception envelope.
function zodIssuesMessage(e: ZodError): string {
  return `validation failed: ${e.issues
    .map((i) => `${i.path.map(String).join(".") || "value"}: ${i.message}`)
    .join("; ")}`;
}

export function ctxOf(principal: VerifiedToken): TenantContext {
  return {
    tenantId: principal.tenantId,
    userId: principal.userId,
    role: principal.role,
  };
}

// Common gate: mcp:write scope present AND the token is scoped to a tenant. Returns the resolved
// context or a WriteResult error.
export function gate(principal: VerifiedToken): TenantContext | WriteResult {
  if (!hasScope(principal, "mcp:write")) {
    return err("insufficient_scope: this tool requires the mcp:write scope");
  }
  if (principal.tenantId === null) {
    return err(
      "no tenant target: the token must be scoped to a tenant (a SUPER_ADMIN must target one)",
    );
  }
  return ctxOf(principal);
}

// Admin gate: mcp:admin scope present AND a tenant target. For fleet/super-admin-only operations that
// still act on one tenant (e.g. Chatwoot server + account management, whose shared-token probe would
// otherwise leak other tenants' accounts). A tenant-scoped mcp:write token is NOT enough.
export function adminGate(
  principal: VerifiedToken,
): TenantContext | WriteResult {
  if (!hasScope(principal, "mcp:admin")) {
    return err("insufficient_scope: this tool requires the mcp:admin scope");
  }
  if (principal.tenantId === null) {
    return err(
      "no tenant target: the token must be scoped to a tenant (a SUPER_ADMIN must target one)",
    );
  }
  return ctxOf(principal);
}

// Read gate: mcp:read scope present AND a tenant target. Tenant-scoped reads need the same fence as
// writes (a tenant-less SUPER_ADMIN token must target a tenant), but only the read scope.
export function readGate(
  principal: VerifiedToken,
): TenantContext | WriteResult {
  if (!hasScope(principal, "mcp:read")) {
    return err("insufficient_scope: this tool requires the mcp:read scope");
  }
  if (principal.tenantId === null) {
    return err(
      "no tenant target: the token must be scoped to a tenant (a SUPER_ADMIN must target one)",
    );
  }
  return ctxOf(principal);
}

// Appends the audit row in a tx where the RLS WITH CHECK passes (asSuperAdmin for a SUPER_ADMIN
// token, the scoped tenant tx otherwise).
export async function recordMcpAudit(
  ctx: TenantContext,
  base: PrismaClient,
  entry: AuditEntry,
): Promise<void> {
  const tenantId = ctx.tenantId;
  const write = (db: ScopedDb) => recordAudit(db, tenantId, entry);
  if (ctx.role === "SUPER_ADMIN") await asSuperAdminOn(base, write);
  else await runScopedOn(base, ctx, write);
}

// ── secret-by-reference helpers (the binding rule: no raw secret ever crosses the model) ──
//
// MCP tools speak vault entry NAMES; nothing accepts a raw secret value as an argument nor returns
// one. consoleUrl builds an out-of-band link the operator follows in the browser when a credential
// must be created or a generated secret revealed.

export function consoleUrl(path: string): string {
  const baseUrl = config.publicUrl.replace(/\/+$/, "");
  return `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

// Resolution outcome for a credential argument: either a stable `vault:<id>` ref to store, or a
// WriteResult to short-circuit the tool with (an explicit error, or a graceful "create it first"
// pointer to the console — never raised as an exception).
export type SecretRefResult = { ref: string } | { fail: WriteResult };

// Resolve a vault entry NAME (or a `vault:<id>` ref) to the stable `vault:<id>` ref a service stores
// in its credentialRef/secretRef column. A missing entry is NOT an error: it returns a console URL
// so the operator can create the credential out of band (the secret never travels through the model).
export async function resolveSecretRef(
  ctx: TenantContext,
  nameOrRef: string,
  base: PrismaClient,
  kind?: string | null,
): Promise<SecretRefResult> {
  if (isVaultIdRef(nameOrRef)) {
    const name = await vaultNameByRef(ctx, nameOrRef, base);
    if (!name) return { fail: err(`credential ref "${nameOrRef}" not found`) };
    return { ref: nameOrRef };
  }
  const resolution = await resolveVaultRefByName(
    ctx,
    nameOrRef,
    kind ?? null,
    base,
  );
  if (resolution.status === "not_found") {
    return {
      fail: ok({
        needsCredential: true,
        message: `No vault entry named "${nameOrRef}". Create it in the console (the secret value is never passed through this tool), then retry.`,
        createAt: consoleUrl("/vault"),
      }),
    };
  }
  if (resolution.status === "ambiguous") {
    return {
      fail: err(
        `credential "${nameOrRef}" is ambiguous (types: ${resolution.kinds.join(", ")}); pass the vault:<id> ref instead`,
      ),
    };
  }
  // A PENDING entry (resolution.pending) intentionally resolves normally: callers may wire config to a
  // reference whose secret is not filled yet (the whole point of credential_create). The "fill it"
  // alert is surfaced by configHealth + the vault list, not by failing the wiring here.
  return { ref: resolution.ref };
}

// Resolve a vault entry NAME (or ref) to its PLAINTEXT string value, server-side. Used only where the
// downstream service needs the raw value (e.g. the Chatwoot adminToken, a token-bearing alert URL).
// The value is consumed in the service call and never returned to the caller (the model).
export type SecretValueResult = { value: string } | { fail: WriteResult };

export async function resolveSecretValue(
  ctx: TenantContext,
  nameOrRef: string,
  base: PrismaClient,
): Promise<SecretValueResult> {
  const resolved = await resolveSecretRef(ctx, nameOrRef, base);
  if ("fail" in resolved) return resolved;
  const value = await runScopedOn(base, ctx, (db) =>
    tryResolveVaultSecret<unknown>(db, resolved.ref),
  );
  if (typeof value !== "string" || value.length === 0) {
    return {
      fail: err(
        `vault entry "${nameOrRef}" does not hold a plain string secret (multi-field credentials are not usable here)`,
      ),
    };
  }
  return { value };
}

export interface CredentialCreateArgs {
  name: string;
  kind?: string;
  base_url?: string | null;
  param_name?: string | null;
  dry_run?: boolean;
}

// credential_create: create a reference-only ("pending") vault entry and return a deeplink (fillAt)
// for the operator to fill the secret in the console. The binding rule holds — this tool NEVER
// receives a secret value. The pending entry can be referenced by other write tools immediately
// (resolveSecretRef resolves it), but it resolves as "missing" at runtime until filled; the vault
// list and the agent editor (configHealth) flag the pending state so the operator knows to complete it.
export async function credentialCreate(
  principal: VerifiedToken,
  args: CredentialCreateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;

  const kind = args.kind ?? "generic";
  const preview = {
    name: args.name,
    kind,
    status: "pending",
    baseUrl: args.base_url ?? null,
    paramName: args.param_name ?? null,
  };

  // dry-run is the default: create ONLY when dry_run is explicitly false.
  if (args.dry_run !== false) {
    return ok({ dryRun: true, target: "vault:new", preview });
  }

  try {
    const { id, ref } = await createPendingVaultEntry(
      ctx,
      {
        name: args.name,
        kind: args.kind ?? null,
        baseUrl: args.base_url ?? null,
        paramName: args.param_name ?? null,
      },
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.credential_create",
      target: ref,
      // No secret exists yet — the audit projection carries only the reference metadata.
      before: {},
      after: { name: args.name, kind, status: "pending" },
    });
    return ok({
      dryRun: false,
      applied: true,
      ref,
      name: args.name,
      kind,
      status: "pending",
      fillAt: consoleUrl(`/resources/vault?fill=${id}`),
    });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}

export interface PromptSetArgs {
  agent_id: string;
  system_prompt: string;
  dry_run?: boolean;
}

// prompt_set: replace an agent's system prompt. Tenant-fenced (a foreign agent_id is invisible →
// "agent not found", never a cross-tenant write).
export async function promptSet(
  principal: VerifiedToken,
  args: PromptSetArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;

  let agentId: bigint;
  try {
    agentId = BigInt(args.agent_id);
  } catch {
    return err("invalid agent_id");
  }

  try {
    // NOTE: checked here (not only inside updateAgent) so the DRY-RUN path enforces the cap too —
    // a preview must never claim a diff the apply would reject.
    assertPromptSize(args.system_prompt);
    const current = await getAgent(ctx, agentId, base);
    const beforeProj = { systemPrompt: current.systemPrompt };
    const afterProj = { systemPrompt: args.system_prompt };
    const diff = diffFields(beforeProj, afterProj);
    const target = `agent:${agentId}`;

    // dry-run is the default: apply ONLY when dry_run is explicitly false.
    if (args.dry_run !== false) {
      return ok({ dryRun: true, target, diff });
    }

    const updated = await updateAgent(
      ctx,
      agentId,
      { systemPrompt: args.system_prompt },
      base,
    );
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.prompt_set",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit({ systemPrompt: updated.systemPrompt }),
    });
    return ok({ dryRun: false, applied: true, target, diff });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}

// agent_list: enumerate the tenant's agents (id, name, enabled) so an MCP caller can discover the
// agent_id the settings tools target. Read-only, tenant-fenced (only this tenant's agents).
export async function agentList(
  principal: VerifiedToken,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;
  try {
    const agents = await listAgents(ctx, base);
    return ok({
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        enabled: a.enabled,
      })),
    });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}

export interface AgentSettingsGetArgs {
  agent_id: string;
}

// agent_settings_get: the normalized per-agent BEHAVIOR config (debounce/stt/tts/split/
// serviceWindow + grounding). Read-only, tenant-fenced (a foreign agent_id → "agent not found").
// credentialRef values are vault entry NAMES, never the secrets themselves.
export async function agentSettingsGet(
  principal: VerifiedToken,
  args: AgentSettingsGetArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = readGate(principal);
  if ("ok" in ctx) return ctx;

  let agentId: bigint;
  try {
    agentId = BigInt(args.agent_id);
  } catch {
    return err("invalid agent_id");
  }

  try {
    const agent = await getAgent(ctx, agentId, base);
    const settings = readBehaviorSettings(agent.settings);
    // The MCP contract speaks NAMES: project the stored `vault:<id>` refs back to entry names, over
    // the same (block, field) list the write path resolves them from.
    for (const { block: key, field } of SETTINGS_CREDENTIAL_PATHS) {
      const block = settings[key] as unknown as
        | Record<string, unknown>
        | undefined;
      const ref = block?.[field];
      if (block && typeof ref === "string" && ref) {
        block[field] = await vaultNameByRef(ctx, ref, base);
      }
    }
    return ok({ agentId: agent.id, settings });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}

export interface AgentSettingsSetArgs extends BehaviorSettingsPatch {
  agent_id: string;
  dry_run?: boolean;
}

// agent_settings_set: patch an agent's BEHAVIOR config. The patch is a partial over the behavior
// blocks; each block is MERGED into the existing settings bag (untouched keys preserved, exactly
// like REST/UI) and RE-READ through the typed readers so the persisted value is always clamped/
// validated (a bad value collapses to a safe default — never a raw write). Tenant-fenced; dry-run by
// default (previews a normalized diff); audited on apply.
export async function agentSettingsSet(
  principal: VerifiedToken,
  args: AgentSettingsSetArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;

  let agentId: bigint;
  try {
    agentId = BigInt(args.agent_id);
  } catch {
    return err("invalid agent_id");
  }

  const patch: BehaviorSettingsPatch = {};
  if (args.debounce !== undefined) patch.debounce = args.debounce;
  if (args.stt !== undefined) patch.stt = args.stt;
  if (args.tts !== undefined) patch.tts = args.tts;
  if (args.vision !== undefined) patch.vision = args.vision;
  if (args.split !== undefined) patch.split = args.split;
  if (args.serviceWindow !== undefined)
    patch.serviceWindow = args.serviceWindow;
  if (args.grounding !== undefined) patch.grounding = args.grounding;
  if (args.followUp !== undefined) patch.followUp = args.followUp;
  if (args.handoff !== undefined) patch.handoff = args.handoff;
  if (args.limits !== undefined) patch.limits = args.limits;
  if (args.observability !== undefined)
    patch.observability = args.observability;
  if (args.availability !== undefined) patch.availability = args.availability;
  if (args.memory !== undefined) patch.memory = args.memory;
  if (args.channelRedirect !== undefined)
    patch.channelRedirect = args.channelRedirect;
  if (args.attributeContext !== undefined)
    patch.attributeContext = args.attributeContext;
  if (args.sendImage !== undefined) patch.sendImage = args.sendImage;
  if (Object.keys(patch).length === 0) {
    return err(
      "no updatable fields provided (debounce, stt, tts, vision, split, serviceWindow, followUp, handoff, limits, availability, channelRedirect, attributeContext, sendImage, observability, memory and/or grounding)",
    );
  }

  try {
    // The MCP contract speaks NAMES (or `vault:<id>` refs for disambiguation).
    // A `vault:<id>` ref is validated directly; a plain name goes through resolveVaultRefByName
    // so ambiguity (multiple kinds sharing the same name) surfaces as an explicit error rather
    // than a silent wrong-entry selection.
    // NOTE: (block, field) pairs, not one field per block: `tts` carries a second credential for
    // the speech normalizer's own model, and a loop that only knows `credentialRef` would let that
    // one through as a raw name, which then fails to resolve at turn time instead of here.
    for (const { block: key, field } of SETTINGS_CREDENTIAL_PATHS) {
      // Re-read inside the loop: two fields of the same block are rewritten in sequence.
      const block = patch[key];
      const value = block?.[field];
      if (block && typeof value === "string" && value) {
        if (isVaultIdRef(value)) {
          // Caller passed a stable ref directly — just validate it resolves in this tenant.
          const name = await vaultNameByRef(ctx, value, base);
          if (!name) return err(`credential ref "${value}" not found`);
          // Store as-is (already in vault:<id> form).
        } else {
          const resolution = await resolveVaultRefByName(
            ctx,
            value,
            null,
            base,
          );
          if (resolution.status === "not_found") {
            return err(`credential "${value}" not found`);
          }
          if (resolution.status === "ambiguous") {
            const typeList = resolution.kinds.join(", ");
            return err(
              `credential "${value}" is ambiguous (types: ${typeList}); pass the vault:<id> ref or rename one of the entries`,
            );
          }
          patch[key] = { ...block, [field]: resolution.ref };
        }
      }
    }
    const current = await getAgent(ctx, agentId, base);
    const before = readBehaviorSettings(current.settings);
    // On the PATCH, before the merge: mergeBehaviorSettings re-reads each touched block through its
    // typed reader, so by the time the merged bag exists an over-cap note has already been clamped
    // and there is nothing left to refuse. Before the dry run too, not only before the apply — a
    // preview that promises a write the apply would refuse is worse than no preview. Against the
    // stored bag, so re-sending a legacy value untouched is not a refusal.
    assertSettingsTextSizes(patch, current.settings);
    const nextBag = mergeBehaviorSettings(
      (current.settings ?? {}) as Record<string, unknown>,
      patch,
    );
    const afterPreview = readBehaviorSettings(nextBag);
    const target = `agent:${agentId}`;
    // Diff only the touched blocks (normalized before → normalized after).
    const beforeProj: Record<string, unknown> = {};
    const afterProj: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as (keyof BehaviorSettingsPatch)[]) {
      beforeProj[key] = before[key];
      afterProj[key] = afterPreview[key];
    }
    const diff = diffFields(beforeProj, afterProj);

    // dry-run is the default: apply ONLY when dry_run is explicitly false.
    if (args.dry_run !== false) {
      return ok({ dryRun: true, target, diff });
    }

    const updated = await updateAgent(
      ctx,
      agentId,
      { settings: nextBag },
      base,
    );
    const afterApplied = readBehaviorSettings(updated.settings);
    const afterAppliedProj: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as (keyof BehaviorSettingsPatch)[]) {
      afterAppliedProj[key] = afterApplied[key];
    }
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.agent_settings_set",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit(afterAppliedProj),
    });
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, afterAppliedProj),
    });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}

export interface TenantUpdateArgs {
  name?: string;
  dry_run?: boolean;
}

// tenant_update: update the targeted tenant (name). The target is the context's tenant — the token's
// own tenant for a tenant-scoped principal, or the per-call `tenant` the MCP wrapper resolved for a
// fleet-level SUPER_ADMIN (this service never reads a tenant arg itself). App identity/branding is
// GLOBAL (not per-tenant) and lives outside MCP.
export async function tenantUpdate(
  principal: VerifiedToken,
  args: TenantUpdateArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  const ctx = gate(principal);
  if ("ok" in ctx) return ctx;
  const tenantId = ctx.tenantId as bigint;

  const patch: { name?: string } = {};
  if (args.name !== undefined) patch.name = args.name;
  if (Object.keys(patch).length === 0) {
    return err("no updatable fields provided (name)");
  }

  try {
    const current = await getTenant(ctx, tenantId, base);
    const beforeProj = { name: current.name };
    const target = `tenant:${tenantId}`;

    if (args.dry_run !== false) {
      const previewAfter = {
        name: patch.name ?? current.name,
      };
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, previewAfter),
      });
    }

    const updated = await updateTenant(ctx, tenantId, patch, base);
    const afterProj = { name: updated.name };
    const diff = diffFields(beforeProj, afterProj);
    await recordMcpAudit(ctx, base, {
      actorId: principal.userId,
      actorType: "mcp",
      action: "mcp.tenant_update",
      target,
      before: truncForAudit(beforeProj),
      after: truncForAudit(afterProj),
    });
    return ok({ dryRun: false, applied: true, target, diff });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}

export interface BrandingSetArgs {
  brand_name?: string | null;
  color_mode?: "SIMPLE" | "ADVANCED";
  brand_color?: string | null;
  tokens_light?: Record<string, unknown>;
  tokens_dark?: Record<string, unknown>;
  site_url?: string | null;
  support_email?: string | null;
  hide_github_link?: boolean;
  dry_run?: boolean;
}

// branding_set: update the GLOBAL app identity colors. This is FLEET-level (NOT tenant-scoped), so
// unlike the other write tools it does not require/accept a tenant target — it requires the
// mcp:admin scope, the privileged tier only SUPER_ADMIN tokens hold (the role check below is
// defense-in-depth, in case mcp:admin is ever granted more broadly). Logo/favicon are uploaded via
// branding_asset_set (below). The apply is audited at the fleet level (tenant_id NULL). Dry-run by default.
export async function brandingSet(
  principal: VerifiedToken,
  args: BrandingSetArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  if (!hasScope(principal, "mcp:admin")) {
    return err("insufficient_scope: this tool requires the mcp:admin scope");
  }
  if (principal.role !== "SUPER_ADMIN") {
    return err("forbidden: global branding requires a SUPER_ADMIN token");
  }

  const update: ColorUpdate = {};
  if (args.brand_name !== undefined) update.brandName = args.brand_name;
  if (args.color_mode !== undefined) update.colorMode = args.color_mode;
  if (args.brand_color !== undefined) update.brandColor = args.brand_color;
  if (args.tokens_light !== undefined) update.tokensLight = args.tokens_light;
  if (args.tokens_dark !== undefined) update.tokensDark = args.tokens_dark;
  if (args.site_url !== undefined) update.siteUrl = args.site_url;
  if (args.support_email !== undefined) {
    update.supportEmail = args.support_email;
  }
  if (args.hide_github_link !== undefined) {
    update.hideGithubLink = args.hide_github_link;
  }
  if (Object.keys(update).length === 0) {
    return err(
      "no updatable fields provided (brand_name, color_mode, brand_color, tokens_light, tokens_dark, site_url, support_email and/or hide_github_link)",
    );
  }

  try {
    const before = await getGlobalBranding();
    const beforeProj = {
      brandName: before.brandName,
      colorMode: before.colorMode,
      brandColor: before.brandColor,
      tokensLight: before.tokensLight,
      tokensDark: before.tokensDark,
      siteUrl: before.siteUrl,
      supportEmail: before.supportEmail,
      hideGithubLink: before.hideGithubLink,
    };
    const target = "branding:global";

    // dry-run is the default: apply ONLY when dry_run is explicitly false.
    if (args.dry_run !== false) {
      // Preview reflects the requested patch (sanitization is applied on apply).
      const previewAfter = {
        brandName:
          update.brandName === undefined
            ? before.brandName
            : update.brandName || null,
        colorMode: update.colorMode ?? before.colorMode,
        brandColor:
          update.brandColor === undefined
            ? before.brandColor
            : update.brandColor || null,
        tokensLight: (update.tokensLight ?? before.tokensLight) as Record<
          string,
          unknown
        >,
        tokensDark: (update.tokensDark ?? before.tokensDark) as Record<
          string,
          unknown
        >,
        siteUrl:
          update.siteUrl === undefined
            ? before.siteUrl
            : update.siteUrl || null,
        supportEmail:
          update.supportEmail === undefined
            ? before.supportEmail
            : update.supportEmail || null,
        hideGithubLink: update.hideGithubLink ?? before.hideGithubLink,
      };
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, previewAfter),
      });
    }

    const after = await updateBrandingColors(update);
    const afterProj = {
      brandName: after.brandName,
      colorMode: after.colorMode,
      brandColor: after.brandColor,
      tokensLight: after.tokensLight,
      tokensDark: after.tokensDark,
      siteUrl: after.siteUrl,
      supportEmail: after.supportEmail,
      hideGithubLink: after.hideGithubLink,
    };
    // Fleet-level audit (tenant_id NULL); the write tx runs asSuperAdmin.
    await recordMcpAudit(
      { tenantId: null, userId: principal.userId, role: "SUPER_ADMIN" },
      base,
      {
        actorId: principal.userId,
        actorType: "mcp",
        action: "mcp.branding_set",
        target,
        before: truncForAudit(beforeProj),
        after: truncForAudit(afterProj),
      },
    );
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, afterProj),
    });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}

export interface BrandingAssetSetArgs {
  kind?: string;
  variant?: string;
  content_base64?: string;
  mime?: string;
  dry_run?: boolean;
}

// branding_asset_set: upload a GLOBAL branding asset (logo/favicon) over MCP. Same fleet-level gate as
// branding_set (mcp:admin + SUPER_ADMIN). The image arrives base64-encoded; we rebuild a Blob — which
// satisfies setBrandingAsset's structural { type, size, arrayBuffer() } — so the SAME service validation
// (MIME allowlist + per-kind size cap) and disk+DB write run, no multipart needed. All the cheap
// validation runs before any DB/disk access. Dry-run by default; apply is audited at the fleet level.
export async function brandingAssetSet(
  principal: VerifiedToken,
  args: BrandingAssetSetArgs,
  deps: WriteDeps = {},
): Promise<WriteResult> {
  const base = deps.base ?? basePrisma;
  if (!hasScope(principal, "mcp:admin")) {
    return err("insufficient_scope: this tool requires the mcp:admin scope");
  }
  if (principal.role !== "SUPER_ADMIN") {
    return err("forbidden: global branding requires a SUPER_ADMIN token");
  }
  if (args.kind !== "logo" && args.kind !== "favicon") {
    return err('invalid kind: expected "logo" or "favicon"');
  }
  if (args.variant !== "dark" && args.variant !== "light") {
    return err('invalid variant: expected "dark" or "light"');
  }
  const kind = args.kind;
  const variant = args.variant;
  const mime = (args.mime ?? "").trim();
  if (!ALLOWED_ASSET_TYPES.includes(mime)) {
    return err(
      `unsupported image type "${mime}" (allowed: ${ALLOWED_ASSET_TYPES.join(", ")})`,
    );
  }
  // Strip an optional data: URL prefix + whitespace, then validate the charset before decoding
  // (Buffer.from is lenient — a wrong arg would silently write a corrupt image otherwise).
  const raw = (args.content_base64 ?? "").trim();
  const b64 = (
    raw.includes(",") ? raw.slice(raw.indexOf(",") + 1) : raw
  ).replace(/\s+/g, "");
  if (b64.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    return err("content_base64 is not valid base64");
  }
  const bytes = Buffer.from(b64, "base64");
  if (bytes.byteLength === 0) {
    return err("content_base64 decoded to zero bytes");
  }
  if (bytes.byteLength > ASSET_MAX_BYTES[kind]) {
    return err(
      `image too large: ${bytes.byteLength} bytes exceeds the ${ASSET_MAX_BYTES[kind]}-byte cap for ${kind}`,
    );
  }

  const target = `branding:asset:${kind}:${variant}`;
  try {
    const before = await getGlobalBranding();
    const replacingExisting = before[kind][variant];

    // dry-run is the default: a binary has no field-level diff, so preview the metadata that WOULD
    // be written (apply ONLY when dry_run is explicitly false).
    if (args.dry_run !== false) {
      return ok({
        dryRun: true,
        target,
        preview: {
          kind,
          variant,
          mime,
          bytes: bytes.byteLength,
          replacingExisting,
        },
      });
    }

    // A Blob satisfies setBrandingAsset's structural type, so the multipart UI path and this MCP path
    // share the exact same validation + write.
    const blob = new Blob([bytes], { type: mime });
    const after = await setBrandingAsset(kind, variant, blob);

    await recordMcpAudit(
      { tenantId: null, userId: principal.userId, role: "SUPER_ADMIN" },
      base,
      {
        actorId: principal.userId,
        actorType: "mcp",
        action: "mcp.branding_asset_set",
        target,
        // Metadata only — never the image bytes.
        before: truncForAudit({ kind, variant, present: replacingExisting }),
        after: truncForAudit({
          kind,
          variant,
          present: after[kind][variant],
          mime,
          bytes: bytes.byteLength,
        }),
      },
    );
    return ok({
      dryRun: false,
      applied: true,
      target,
      result: {
        kind,
        variant,
        mime,
        bytes: bytes.byteLength,
        replacedExisting: replacingExisting,
        version: after.version,
      },
    });
  } catch (e) {
    if (e instanceof AppError) return err(e.message);
    if (e instanceof ZodError) return err(zodIssuesMessage(e));
    throw e;
  }
}
