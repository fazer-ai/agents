import { ZodError } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import {
  setBrandingAsset,
  updateBrandingColors,
} from "@/api/features/branding/branding.admin.service";
import {
  ALLOWED_ASSET_TYPES,
  ASSET_MAX_BYTES,
  assertBrandingColorsUpdatable,
  type ColorUpdate,
  getGlobalBranding,
} from "@/api/features/branding/branding.service";
import basePrisma from "@/api/lib/prisma";
import { updateTenant } from "@/api/v1/tenants.admin.service";
import { assertTenantUpdatable, getTenant } from "@/api/v1/tenants.service";
import { parseDbId } from "@/lib/db-id";
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
import { configHealthAfterWrite } from "@/modules/agents/config-health-read";
import {
  credRefSlot,
  SETTINGS_CREDENTIAL_PATHS,
} from "@/modules/agents/credential-paths";
import {
  assertPromptSize,
  assertResolveLabelsNotProtected,
  assertSettingsContactAuthRule,
  assertSettingsDebugWindow,
  assertSettingsModelFallback,
  assertSettingsProtectedLabels,
  assertSettingsRetiredLabelKeys,
  assertSettingsTextSizes,
  assertSettingsToolPreconditions,
  getAgent,
  listAgents,
  updateAgent,
} from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { type AuditEntry, recordAudit } from "@/modules/audit/service";
import type { LoadChatwootClientDeps } from "@/modules/chatwoot/instance";
import type { ListAccountsDeps } from "@/modules/chatwoot/management";
import { readDebugModes } from "@/modules/flowlog/debug-mode";
import { getTenantSettings } from "@/modules/tenant-settings/service";
import {
  assertPendingVaultEntryCreatable,
  assertVaultNameAvailable,
  createPendingVaultEntry,
  isVaultIdRef,
  resolveVaultRefByName,
  tryResolveVaultSecret,
  vaultNameByRef,
} from "@/modules/vault/service";
import { vaultCreateUrl, vaultFillUrl } from "./console-links";
import { hasScope, type VerifiedToken } from "./oauth/tokens";

// MCP write tools, the privileged half of the MCP surface (docs/mcp.md):
//   - scope: mcp:write is REQUIRED;
//   - tenant fence: the token MUST target a tenant, and the write is fenced to it by RLS/
//     asSuperAdmin (the tool args never carry a tenant: anti-IDOR);
//   - dry-run by DEFAULT: nothing is applied unless the caller passes dry_run:false;
//   - audit: a successful apply appends an AuditLog row, allowlist-projected and length-bounded.

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
  // NOTE: injectable Chatwoot client factory, for the writes whose PREVIEW calls Chatwoot rather
  // than answering from its arguments (`inbox_remove`: the write refuses a live inbox, so a preview
  // that cannot ask would approve what the apply rejects). Defaults to the real SSRF-validated one.
  makeClient?: LoadChatwootClientDeps["makeClient"];
  // NOTE: injectable account-list probe, for the same reason: `deployment_set_accounts` checks its
  // input against the accounts the deployment reports, and a preview that cannot reach that list
  // would approve ids the apply refuses.
  fetchProfile?: ListAccountsDeps["fetchProfile"];
}

// The one id parser for every MCP surface, read and write alike. `BigInt("")` is 0n and
// `BigInt(" 17 ")` is 17n, so a mistyped id would become a VALID id for some other row, and a write
// would edit that one. An id is a run of digits or a mistake worth reporting.
export function parseMcpId(raw: string, label: string): bigint | WriteResult {
  // Range as well as spelling. `BigInt` is arbitrary precision, so an id past 2^63-1 parses here and
  // is refused by POSTGRES when the query binds it — a tool call that answers with a database error
  // instead of "invalid <label>". `parseDbId` holds both halves; see lib/db-id.ts.
  const id = parseDbId(raw);
  return id === null ? err(`invalid ${label}`) : id;
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

// Service-layer ZodErrors must surface as a tool result (err), never bubble raw into the
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
    // The door, carried on the context so the SERVICE can attribute the row it writes. Every tool
    // here used to pass `actorType: "mcp"` to its own audit call one layer up; a service reached
    // through this context would otherwise record the operator as a browser session.
    actorType: "mcp",
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
//
// `requireTenant: false` is for the read that names its OWN trail instead of a tenant's: `audit_list`
// with `scope=fleet|all` reads the rows keyed to no tenant, so a target is not merely unnecessary
// there, it is a value the read has nowhere to put -- and on a deployment with no tenants at all,
// demanding one would make those rows unreadable from MCP. The default is unchanged, so every other
// caller keeps the fence; the role check that actually guards the wider trails is `listAudit`'s own.
export function readGate(
  principal: VerifiedToken,
  opts: { requireTenant?: boolean } = {},
): TenantContext | WriteResult {
  if (!hasScope(principal, "mcp:read")) {
    return err("insufficient_scope: this tool requires the mcp:read scope");
  }
  if (opts.requireTenant !== false && principal.tenantId === null) {
    return err(
      "no tenant target: the token must be scoped to a tenant (a SUPER_ADMIN must target one)",
    );
  }
  return ctxOf(principal);
}

// The gate for a tool that serves an AUTHORING CONTRACT: `code_tool_schema` and
// `document_template_schema`. Both are constants, both are named by a write tool's description as
// the place the contract lives, and `filterScopes` (api/v1/mcp-oauth.controller.ts) grants exactly
// the scopes a client asked for, so a token holding `mcp:write` and not `mcp:read` is a real token.
// Gating these on read alone points that client at a tool it can neither list nor call, which is the
// whole cost of having moved the contract out of the create description.
export function authoringGate(
  principal: VerifiedToken,
): TenantContext | WriteResult {
  if (!hasScope(principal, "mcp:read") && !hasScope(principal, "mcp:write")) {
    return err(
      "insufficient_scope: this tool requires the mcp:read or mcp:write scope",
    );
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
// one. `console-links.ts` builds the out-of-band link the operator follows in the browser when a
// credential must be created or a generated secret revealed.

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
        createAt: vaultCreateUrl(ctx.tenantId),
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
  // alert is surfaced by config-health + the vault list, not by failing the wiring here.
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
// list and the agent editor (config-health) flag the pending state so the operator knows to complete it.
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
    // NOTE: everything `createPendingVaultEntry` decides about its input (the name, the kind
    // against the catalog, connect-flow kinds that cannot be pending, a required base URL, an
    // unused param name), asked through the same pure function the core uses, so the two verdicts
    // cannot drift.
    try {
      const { name, kind } = assertPendingVaultEntryCreatable({
        name: args.name,
        kind: args.kind ?? null,
        baseUrl: args.base_url ?? null,
        paramName: args.param_name ?? null,
      });
      // ADVISORY, and the only preflight here that is. See `assertVaultNameAvailable`: it reads
      // outside the write's transaction, so it answers the collision the operator already made,
      // not a reservation. It takes the pair the line above NORMALIZED, since that is what the
      // uniqueness is on.
      await assertVaultNameAvailable(ctx, name, kind, base);
    } catch (e) {
      if (e instanceof AppError) return err(e.message);
      if (e instanceof ZodError) return err(zodIssuesMessage(e));
      throw e;
    }
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
    return ok({
      dryRun: false,
      applied: true,
      ref,
      name: args.name,
      kind,
      status: "pending",
      fillAt: vaultFillUrl(ctx.tenantId, id),
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

  const agentId = parseMcpId(args.agent_id, "agent_id");
  if (typeof agentId !== "bigint") return agentId;

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

    await updateAgent(ctx, agentId, { systemPrompt: args.system_prompt }, base);
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

// The read returns what the write accepts, down to the field: three guardrail fields do nothing
// under `input` and the write refuses them, so returning them would hand back a document the next
// `agent_settings_set` rejects. Projected here, not in the reader, so the console and the runtime
// keep their uniform shape (pinned by tests/modules/agent-settings-mcp-parity.test.ts).
function dropOutputOnlyInputFields(
  settings: ReturnType<typeof readBehaviorSettings>,
): ReturnType<typeof readBehaviorSettings> {
  const { promptAdherence, answerRelevance, ...checks } =
    settings.guardrails.input.checks;
  const { generationPrompt, ...input } = settings.guardrails.input;
  return {
    ...settings,
    guardrails: {
      ...settings.guardrails,
      input: { ...input, checks } as typeof settings.guardrails.input,
    },
  };
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

  const agentId = parseMcpId(args.agent_id, "agent_id");
  if (typeof agentId !== "bigint") return agentId;

  try {
    const agent = await getAgent(ctx, agentId, base);
    const settings = dropOutputOnlyInputFields(
      readBehaviorSettings(agent.settings),
    );
    // The MCP contract speaks NAMES: project the stored `vault:<id>` refs back to entry names, over
    // the same (block, field) list the write path resolves them from.
    for (const { path } of SETTINGS_CREDENTIAL_PATHS) {
      const slot = credRefSlot(
        settings as unknown as Record<string, unknown>,
        path,
      );
      const ref = slot?.holder[slot.key];
      if (slot && typeof ref === "string" && ref) {
        slot.holder[slot.key] = await vaultNameByRef(ctx, ref, base);
      }
    }
    // The unified debug-mode warning, including the tenant-level switch that lives on another
    // surface; one extra read here avoids a second copy of the condition.
    const debugModes = readDebugModes(
      agent.settings,
      await getTenantSettings(ctx, base),
    );
    return ok({
      agentId: agent.id,
      settings,
      debugModes: {
        ...debugModes,
        fullDetailUntil: debugModes.fullDetailUntil?.toISOString() ?? null,
      },
    });
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

  const agentId = parseMcpId(args.agent_id, "agent_id");
  if (typeof agentId !== "bigint") return agentId;

  // The keys come FROM THE SCHEMA, not from a list beside it, so a block published in the
  // schema cannot be dropped here; the refusal below names the same set. The cast is safe: `args`
  // was parsed against `BEHAVIOR_PATCH_SHAPE`, the shape that defines `patch`'s own type.
  const patch: BehaviorSettingsPatch = {};
  const patchable = Object.keys(
    BEHAVIOR_PATCH_SHAPE,
  ) as (keyof BehaviorSettingsPatch)[];
  for (const key of patchable) {
    const value = (args as unknown as Record<string, unknown>)[key];
    if (value !== undefined) {
      (patch as Record<string, unknown>)[key] = value;
    }
  }
  // NOTE: a `__proto__` key is lost before this function runs (zod's loose-object rebuild in the
  // SDK's argument parse drops it), so it cannot be refused by name. No stored bag can hold one
  // either, so there is nothing to delete; docs/mcp.md has the reasoning and the tests that pin it.
  if (Object.keys(patch).length === 0) {
    // `filter`, not `slice`: the astral-cap sweep reads every bare `.slice(` in src/ as a possible
    // surrogate cut, and a list of keys is not worth an entry in that registry.
    const last = patchable.at(-1);
    const rest = patchable.filter((k) => k !== last);
    return err(
      `no updatable fields provided (${rest.join(", ")} and/or ${last})`,
    );
  }

  try {
    // The MCP contract speaks NAMES (or `vault:<id>` refs for disambiguation).
    // A `vault:<id>` ref is validated directly; a plain name goes through resolveVaultRefByName
    // so ambiguity (multiple kinds sharing the same name) surfaces as an explicit error rather
    // than a silent wrong-entry selection.
    // NOTE: PATHS, not one field per block: `tts` carries a second credential for the speech
    // normalizer's own model, and `memory` carries one two levels down, on `compaction`. A loop that
    // only knows `credentialRef`, or that only looks one level deep, lets those through as raw names
    // — which then fail to resolve at turn time instead of here.
    for (const { path } of SETTINGS_CREDENTIAL_PATHS) {
      // Re-read inside the loop: two fields of the same block are rewritten in sequence.
      const slot = credRefSlot(patch as Record<string, unknown>, path);
      const value = slot?.holder[slot.key];
      if (slot && typeof value === "string" && value) {
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
          slot.holder[slot.key] = resolution.ref;
        }
      }
    }
    const current = await getAgent(ctx, agentId, base);
    const before = dropOutputOnlyInputFields(
      readBehaviorSettings(current.settings),
    );
    // On the PATCH, before the merge: mergeBehaviorSettings re-reads each touched block through its
    // typed reader, so by the time the merged bag exists an over-cap note has already been clamped
    // and there is nothing left to refuse. Before the dry run too, not only before the apply — a
    // preview that promises a write the apply would refuse is worse than no preview. Against the
    // stored bag, so re-sending a legacy value untouched is not a refusal.
    assertSettingsTextSizes(patch, current.settings);
    assertSettingsDebugWindow(patch, current.settings);
    assertSettingsModelFallback(patch, current.settings, "merge");
    // NOTE: on the PATCH and before the merge, as above, and also because this reader is a FILTER:
    // a condition that does not parse is DROPPED, so after the merge the call would answer ok
    // having replaced a working guard with nothing.
    assertSettingsToolPreconditions(patch, current.settings);
    // NOTE: same reason: the contactAuth reader drops a rule it cannot parse.
    assertSettingsContactAuthRule(patch, current.settings);
    // NOTE: same reason: `mergeBehaviorSettings` normalizes through readers that no longer know the
    // retired taxonomy keys, so they would vanish and both halves answer ok for configuration that
    // does nothing. Asked of the PATCH, the only place the key still exists.
    assertSettingsRetiredLabelKeys(patch);
    assertSettingsProtectedLabels(patch, current.settings);
    const nextBag = mergeBehaviorSettings(
      (current.settings ?? {}) as Record<string, unknown>,
      patch,
    );
    // On the MERGED bag, not the patch: fields merge within a block, so a stored fence survives a
    // patch that touches the same block, and the preview must refuse what the apply would.
    assertResolveLabelsNotProtected(nextBag);
    // PROJECTED, like the read — the same question asked in a third place. A client is expected to
    // reuse the preview's `after` (that is what a dry run is for), so a diff carrying the fields the
    // write refuses hands back a document that the apply rejects.
    const afterPreview = dropOutputOnlyInputFields(
      readBehaviorSettings(nextBag),
    );
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
    const afterApplied = dropOutputOnlyInputFields(
      readBehaviorSettings(updated.settings),
    );
    const afterAppliedProj: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as (keyof BehaviorSettingsPatch)[]) {
      afterAppliedProj[key] = afterApplied[key];
    }
    return ok({
      dryRun: false,
      applied: true,
      target,
      diff: diffFields(beforeProj, afterAppliedProj),
      ...(await configHealthAfterWrite(ctx, agentId, base)),
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
      // NOTE: the core's own question, asked INSIDE the branch because the apply reaches the core,
      // which asks it again; above the branch it would be a second lookup that can disagree.
      assertTenantUpdatable(patch);
      const previewAfter = {
        name: patch.name ?? current.name,
      };
      return ok({
        dryRun: true,
        target,
        diff: diffFields(beforeProj, previewAfter),
      });
    }

    // The row is `updateTenant`'s to write, in its own transaction and under the tenant it
    // changed, which is not necessarily this context's.
    const updated = await updateTenant(ctx, tenantId, patch, base);
    const afterProj = { name: updated.name };
    const diff = diffFields(beforeProj, afterProj);
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
    const before = await getGlobalBranding(base);
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
      // NOTE: the core's own question, asked INSIDE the branch because the apply reaches the core,
      // which asks it again; above the branch it would be a second lookup that can disagree.
      assertBrandingColorsUpdatable(update);
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

    // `updateBrandingColors` records its own fleet-level row (tenant_id NULL) inside the
    // asSuperAdmin transaction that writes the identity.
    const after = await updateBrandingColors(
      {
        tenantId: null,
        userId: principal.userId,
        role: "SUPER_ADMIN",
        actorType: "mcp",
      },
      update,
      base,
    );
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
    const before = await getGlobalBranding(base);
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
    // share the exact same validation + write, and now the same audit row, from inside it.
    const blob = new Blob([bytes], { type: mime });
    const after = await setBrandingAsset(
      {
        tenantId: null,
        userId: principal.userId,
        role: "SUPER_ADMIN",
        actorType: "mcp",
      },
      kind,
      variant,
      blob,
      base,
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
