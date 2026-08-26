import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  classifyWidgetHealth,
  type WidgetHealth,
  type WidgetHealthStatus,
} from "@/modules/channel-redirect/link";
import {
  ChatwootApiError,
  type ChatwootClient,
  fetchChatwootProfile,
} from "./client";
import { ensureDeliverySweep } from "./delivery-sweep";
import { type LoadChatwootClientDeps, loadChatwootClient } from "./instance";
import { chatwootAutoRepliesOutOfHours } from "./out-of-office";
import { ensureAgentBot } from "./provisioning";
import { invalidateRouteTokenCache } from "./route-token-cache";

// Chatwoot deployment + account + inbox management (per-tenant). A DEPLOYMENT (base URL + shared admin
// token, registered ONCE per tenant) holds the connection; ACCOUNTS (ChatwootInstance rows) hang off
// it and reuse its token. Tokens are write-only (encrypted at rest, never returned — DTOs expose only
// presence flags). There is NO explicit "provision the bot" step: the Agent Bot is created lazily on
// the first `bindInbox` (see ensureAgentBot). `syncInboxes` pulls the inbox list from Chatwoot
// (admin-token) into the mirror so an operator can see/bind inboxes before any message arrives.

// One Chatwoot account under the tenant's deployment. baseUrl + admin-token presence are
// deployment-level now (see ChatwootDeploymentDto), so they no longer appear on the account DTO.
export interface ChatwootInstanceDto {
  id: string;
  accountId: number;
  accountName: string | null;
  // ISO timestamp when the account was soft-disconnected (rows kept for history), or null when active.
  disconnectedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const SELECT = {
  id: true,
  accountId: true,
  accountName: true,
  disconnectedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDto(r: {
  id: bigint;
  accountId: number;
  accountName: string | null;
  disconnectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): ChatwootInstanceDto {
  return {
    id: String(r.id),
    accountId: r.accountId,
    accountName: r.accountName,
    disconnectedAt: r.disconnectedAt ? r.disconnectedAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

// The tenant's Chatwoot deployment (base URL + the shared admin/user token, entered once). The token
// is write-only; the DTO exposes only its presence.
export interface ChatwootDeploymentDto {
  id: string;
  baseUrl: string;
  hasAdminToken: boolean;
  createdAt: string;
  updatedAt: string;
}

const DEPLOYMENT_SELECT = {
  id: true,
  baseUrl: true,
  adminToken: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDeploymentDto(r: {
  id: bigint;
  baseUrl: string;
  adminToken: string;
  createdAt: Date;
  updatedAt: Date;
}): ChatwootDeploymentDto {
  return {
    id: String(r.id),
    baseUrl: r.baseUrl,
    hasAdminToken: r.adminToken.length > 0,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listChatwootInstances(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<ChatwootInstanceDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findMany({ select: SELECT, orderBy: { id: "asc" } }),
  );
  return rows.map(toDto);
}

export async function getChatwootInstance(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ChatwootInstanceDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "chatwoot instance not found",
      "errors.chatwootInstanceNotFound",
    );
  }
  return toDto(row);
}

// ── deployment (the tenant's single Chatwoot connection) ──

// The tenant's deployment + its accounts. `deployment` is null when none is connected yet (the UI
// shows the connect form). `accounts` includes soft-disconnected ones (kept for history); the UI
// distinguishes them by disconnectedAt.
export async function getChatwootDeployment(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<{
  deployment: ChatwootDeploymentDto | null;
  accounts: ChatwootInstanceDto[];
}> {
  return runScopedOn(base, ctx, async (db) => {
    const dep = await db.chatwootDeployment.findFirst({
      select: DEPLOYMENT_SELECT,
    });
    const accounts = await db.chatwootInstance.findMany({
      select: SELECT,
      orderBy: { id: "asc" },
    });
    return {
      deployment: dep ? toDeploymentDto(dep) : null,
      accounts: accounts.map(toDto),
    };
  });
}

// Tear down the tenant's Chatwoot connection entirely — the irreversible "switch servers" path. The
// caller (controller) must have already gated this hard (SUPER_ADMIN + re-typed domain + password).
// Deleting the deployment cascades its accounts → conversations / inboxes / bots / threads / webhook
// deliveries; Contacts are NOT cascaded (no FK) and are per-deployment, so they are wiped too —
// otherwise the next deployment's contacts would collide by chatwootContactId. After this the tenant
// has a clean slate and a different Chatwoot can be connected without id collisions (internal ids are
// autoincrement and never reused). Best-effort: the abandoned Chatwoot's bots are left as-is.
export async function disconnectChatwootDeployment(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<void> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  await runScopedOn(base, ctx, async (db) => {
    const dep = await db.chatwootDeployment.findFirst({ select: { id: true } });
    if (!dep) {
      throw new NotFoundError(
        "no chatwoot deployment connected",
        "errors.chatwootDeploymentNotFound",
      );
    }
    // Contacts first (no cascade reaches them), then the deployment (cascades everything else).
    await db.contact.deleteMany({});
    await db.chatwootDeployment.delete({ where: { id: dep.id } });
  });
  // NOTE: "Everything else" includes every ChatwootAgentBot of the tenant, two cascades down
  // (deployment -> instance -> bot), so this retires every route token the tenant owned.
  invalidateRouteTokenCache();
}

// Canonicalize a Chatwoot base URL for storage + global uniqueness: lowercase the origin (URL parse
// already lowercases scheme/host) and strip a trailing slash, so "https://Chat.example.com/" and
// "https://chat.example.com" resolve to the same deployment. Falls back to a trailing-slash strip if
// the string somehow does not parse (the zod `.url()` makes that unreachable in practice).
export function normalizeChatwootBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  try {
    const u = new URL(trimmed);
    u.hash = "";
    u.search = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export const chatwootDeploymentConnectSchema = z
  .object({
    baseUrl: z.string().url().max(2000),
    adminToken: z.string().min(1).max(2000),
  })
  .strict();
export type ChatwootDeploymentConnectInput = z.infer<
  typeof chatwootDeploymentConnectSchema
>;

// Connect (or re-point the token of) the tenant's Chatwoot deployment from a base URL + admin token,
// entered ONCE. Validates the pair by probing /profile (which also yields the reachable accounts) so a
// bad URL/token never persists. If a deployment already exists: same baseUrl ⇒ rotate the token
// (idempotent re-connect); different baseUrl ⇒ rejected (switching servers would orphan every
// account's per-deployment ids — a destructive teardown, not a connect). Returns the deployment + the
// accounts the token can reach (for the account pick-list). Network/SSRF happen OUTSIDE the tx.
export async function connectChatwootDeployment(
  ctx: TenantContext,
  input: ChatwootDeploymentConnectInput,
  deps: ListAccountsDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{
  deployment: ChatwootDeploymentDto;
  accounts: ChatwootAccountSummary[];
}> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const data = parseInput(chatwootDeploymentConnectSchema, input);
  data.baseUrl = normalizeChatwootBaseUrl(data.baseUrl);
  await assertSafeOutboundUrl(data.baseUrl); // DNS lookup OUTSIDE the tx
  // Validate the credentials (and discover accounts) before persisting anything.
  const accounts = await listChatwootAccounts(
    { baseUrl: data.baseUrl, token: data.adminToken },
    deps,
  );
  // NOTE: the base URL is intentionally NOT unique across tenants — one Chatwoot server can back many
  // tenants (cross-tenant uniqueness is enforced per ACCOUNT, see connectAccount + serverKey).
  const deployment = await runScopedOn(base, ctx, async (db) => {
    const existing = await db.chatwootDeployment.findFirst({
      select: { id: true, baseUrl: true },
    });
    if (existing && existing.baseUrl !== data.baseUrl) {
      throw new ConflictError(
        "this tenant is already connected to a different Chatwoot deployment; disconnect it first to switch servers",
        "errors.chatwootDifferentDeployment",
      );
    }
    if (existing) {
      const row = await db.chatwootDeployment.update({
        where: { id: existing.id },
        data: { adminToken: encryptJson(data.adminToken) },
        select: DEPLOYMENT_SELECT,
      });
      return toDeploymentDto(row);
    }
    const row = await db.chatwootDeployment.create({
      data: {
        tenantId,
        baseUrl: data.baseUrl,
        adminToken: encryptJson(data.adminToken),
      },
      select: DEPLOYMENT_SELECT,
    });
    return toDeploymentDto(row);
  });
  return { deployment, accounts };
}

// Rotate the deployment's admin token (the operator pasted a new one). Validated by a /profile probe
// before it persists. Affects every account under the deployment (they share it).
export async function rotateChatwootDeploymentToken(
  ctx: TenantContext,
  adminToken: string,
  deps: ListAccountsDeps = {},
  base: PrismaClient = basePrisma,
): Promise<ChatwootDeploymentDto> {
  const token = parseInput(
    z.string().min(1).max(2000),
    adminToken,
    "adminToken",
  );
  const dep = await runScopedOn(base, ctx, (db) =>
    db.chatwootDeployment.findFirst({ select: { id: true, baseUrl: true } }),
  );
  if (!dep) {
    throw new NotFoundError(
      "no chatwoot deployment connected",
      "errors.chatwootDeploymentNotFound",
    );
  }
  // Validate the new token against the live deployment before persisting it.
  await listChatwootAccounts({ baseUrl: dep.baseUrl, token }, deps);
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.chatwootDeployment.update({
      where: { id: dep.id },
      data: { adminToken: encryptJson(token) },
      select: DEPLOYMENT_SELECT,
    });
    return toDeploymentDto(row);
  });
}

// Re-list the accounts the deployment's STORED token can reach (for the "manage accounts" editor — no
// token re-entry). Uses the saved baseUrl + decrypted token. 502 (via listChatwootAccounts) when
// Chatwoot is unreachable.
export async function listDeploymentAccounts(
  ctx: TenantContext,
  deps: ListAccountsDeps = {},
  base: PrismaClient = basePrisma,
): Promise<ChatwootAccountSummary[]> {
  const dep = await runScopedOn(base, ctx, (db) =>
    db.chatwootDeployment.findFirst({
      select: { baseUrl: true, adminToken: true },
    }),
  );
  if (!dep) {
    throw new NotFoundError(
      "no chatwoot deployment connected",
      "errors.chatwootDeploymentNotFound",
    );
  }
  const accounts = await listChatwootAccounts(
    { baseUrl: dep.baseUrl, token: decryptJson<string>(dep.adminToken) },
    deps,
  );
  // Annotate each account with who already owns it across the fleet (a shared server can back many
  // tenants). Superuser read so the picker can flag accounts taken by OTHER tenants (blocked) vs the
  // current tenant's own (reconnectable). Surfacing other tenants' names is fine — this path is
  // SUPER_ADMIN-only (see chatwoot-admin.controller + the mcp:admin gate).
  const serverKey = normalizeChatwootBaseUrl(dep.baseUrl);
  const claims = await listAccountClaims(base, serverKey, ctx.tenantId);
  return accounts.map((a) => ({ ...a, claim: claims.get(a.id) ?? null }));
}

// Map of accountId → owning-tenant claim for every ChatwootInstance on this server (active OR
// soft-disconnected — a paused account still belongs to its tenant). Superuser (cross-tenant).
async function listAccountClaims(
  base: PrismaClient,
  serverKey: string,
  currentTenantId: bigint | null,
): Promise<Map<number, ChatwootAccountClaim>> {
  return asSuperAdminOn(base, async (db) => {
    const rows = await db.chatwootInstance.findMany({
      where: { serverKey },
      select: { accountId: true, tenantId: true },
    });
    const names = new Map<bigint, string>();
    if (rows.length > 0) {
      const tenants = await db.tenant.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.tenantId))] } },
        select: { id: true, name: true },
      });
      for (const t of tenants) names.set(t.id, t.name);
    }
    const out = new Map<number, ChatwootAccountClaim>();
    for (const r of rows) {
      out.set(r.accountId, {
        tenantId: String(r.tenantId),
        tenantName: names.get(r.tenantId) ?? null,
        isCurrent: currentTenantId !== null && r.tenantId === currentTenantId,
      });
    }
    return out;
  });
}

// Internal: connect ONE account under the deployment (create, or reactivate a soft-disconnected row).
// No network, no token (those live on the deployment); scoped. Returns the local instance id so the
// caller can sync its inboxes. accountName comes from the /profile probe (best-effort display only).
async function connectAccount(
  ctx: TenantContext,
  deploymentId: bigint,
  accountId: number,
  accountName: string | null,
  serverKey: string,
  base: PrismaClient,
): Promise<bigint> {
  const tenantId = ctx.tenantId;
  if (tenantId === null) throw new AppError("tenant required", 400);
  // A Chatwoot account belongs to ONE tenant fleet-wide. RLS hides another tenant's claim from the
  // scoped tx below, so pre-check cross-tenant (superuser read) for a friendly error; the unique
  // index on (serverKey, accountId) is the hard race-safe backstop on create.
  await assertAccountNotTakenByAnotherTenant(
    base,
    tenantId,
    serverKey,
    accountId,
  );
  const result = await runScopedOn(base, ctx, async (db) => {
    const existing = await db.chatwootInstance.findFirst({
      where: { accountId },
      select: { id: true },
    });
    if (existing) {
      await db.chatwootInstance.update({
        where: { id: existing.id },
        data: { disconnectedAt: null, deploymentId, accountName, serverKey },
      });
      return { id: existing.id, reconnected: true };
    }
    try {
      const row = await db.chatwootInstance.create({
        data: { tenantId, deploymentId, accountId, accountName, serverKey },
        select: { id: true },
      });
      return { id: row.id, reconnected: false };
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        throw accountTakenError();
      }
      throw err;
    }
  });
  // NOTE: AFTER THE COMMIT, never inside it. The receiver refuses events for a disconnected instance and
  // caches that refusal by route token; clearing the cache while `disconnectedAt` is still uncommitted
  // lets an event arriving in that window read the old row and cache the refusal all over again, so
  // the reconnect would not take effect until the entry expires.
  if (result.reconnected) invalidateRouteTokenCache();
  // Arm the stranded-delivery recovery sweep for this tenant (issue #228). Here and not only at
  // boot: a first-run install has no tenants when the boot arm runs, and connecting an account is
  // the moment a tenant acquires the only thing that can produce a delivery to strand. Idempotent
  // (enqueueJob upserts one live row per tenant) and best-effort — a failure here must not fail the
  // connection the operator asked for; the next boot arms it.
  try {
    await ensureDeliverySweep(tenantId, base);
  } catch (err) {
    logger.warn(
      { tenantId: String(tenantId), err },
      "delivery sweep arm failed on Chatwoot connect; continuing",
    );
  }
  return result.id;
}

function accountTakenError(): ConflictError {
  return new ConflictError(
    "this Chatwoot account is already connected to another tenant; one account belongs to a single tenant",
    "errors.chatwootAccountTaken",
  );
}

// Cross-tenant guard (superuser read bypasses RLS): rejects claiming a (serverKey, accountId) that a
// DIFFERENT tenant already owns. The same tenant reconnecting its own account is excluded by the
// tenantId filter, so reactivation of a soft-disconnected own-account is unaffected.
async function assertAccountNotTakenByAnotherTenant(
  base: PrismaClient,
  tenantId: bigint,
  serverKey: string,
  accountId: number,
): Promise<void> {
  const taken = await asSuperAdminOn(base, (db) =>
    db.chatwootInstance.findFirst({
      where: { serverKey, accountId, tenantId: { not: tenantId } },
      select: { id: true },
    }),
  );
  if (taken) throw accountTakenError();
}

// Apply the operator's account selection as a diff against the currently-connected accounts:
//   - newly-selected ⇒ connect (create/reactivate) + best-effort inbox sync;
//   - de-selected active account ⇒ soft-disconnect (unbinds agents, keeps history).
// Account names come from the deployment's /profile probe so the caller never has to trust the client.
// All network (probe, sync, unbind) runs outside the scoped writes.
export async function setConnectedAccounts(
  ctx: TenantContext,
  accountIds: number[],
  deps: LoadChatwootClientDeps & ListAccountsDeps = {},
  base: PrismaClient = basePrisma,
): Promise<ChatwootInstanceDto[]> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const wanted = [...new Set(accountIds)];
  const dep = await runScopedOn(base, ctx, (db) =>
    db.chatwootDeployment.findFirst({ select: { id: true, baseUrl: true } }),
  );
  if (!dep) {
    throw new NotFoundError(
      "no chatwoot deployment connected",
      "errors.chatwootDeploymentNotFound",
    );
  }
  const serverKey = normalizeChatwootBaseUrl(dep.baseUrl);
  // Names for the wanted accounts (best-effort; falls back to null → the #id badge still identifies).
  let nameById = new Map<number, string>();
  try {
    const summaries = await listDeploymentAccounts(ctx, deps, base);
    nameById = new Map(summaries.map((s) => [s.id, s.name]));
  } catch {
    // probe failed — proceed with null names (the operator picked these ids deliberately)
  }
  const current = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findMany({
      select: { id: true, accountId: true, disconnectedAt: true },
    }),
  );
  const activeIds = new Set(
    current.filter((c) => c.disconnectedAt === null).map((c) => c.accountId),
  );
  // Disconnect active accounts the operator removed from the selection.
  for (const c of current) {
    if (c.disconnectedAt === null && !wanted.includes(c.accountId)) {
      await softDisconnectChatwootInstance(ctx, c.id, base);
    }
  }
  // Connect (create/reactivate) the newly-selected accounts + best-effort inbox sync.
  for (const accountId of wanted) {
    if (activeIds.has(accountId)) continue; // already active — nothing to do
    const id = await connectAccount(
      ctx,
      dep.id,
      accountId,
      nameById.get(accountId) ?? null,
      serverKey,
      base,
    );
    try {
      await syncInboxes(ctx, id, deps, base);
    } catch {
      // best-effort: inboxes can be synced manually later
    }
  }
  return listChatwootInstances(ctx, base);
}

// Soft-disconnect an account: unbind every agent from its inboxes (detaching the persona bots in
// Chatwoot so it STOPS delivering events to our webhook) and stamp disconnectedAt. The rows
// (conversations / inboxes / contacts / analytics) are KEPT so history and the dashboard stay intact;
// the webhook/runtime then ignore the account. Best-effort on the Chatwoot side: an unreachable
// deployment still gets the local unbind + the disconnect stamp.
export async function softDisconnectChatwootInstance(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const inst = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findUnique({
      where: { id },
      select: { id: true },
    }),
  );
  if (!inst) {
    throw new NotFoundError(
      "chatwoot instance not found",
      "errors.chatwootInstanceNotFound",
    );
  }
  // Unbind agents from this instance's inboxes WHILE it is still active (detach the bots in Chatwoot).
  const bound = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { chatwootInstanceId: id, agentId: { not: null } },
      select: { chatwootInboxId: true },
    }),
  );
  if (bound.length > 0) {
    let client: ChatwootClient | null = null;
    try {
      client = await loadChatwootClient(tenantId, id, { base });
    } catch {
      client = null; // Chatwoot unreachable / creds gone — still unbind locally + stamp disconnected.
    }
    if (client) {
      for (const ib of bound) {
        try {
          await client.setInboxAgentBot(ib.chatwootInboxId, null);
        } catch {
          // best-effort: a per-inbox failure must not block disconnecting the rest
        }
      }
    }
    await runScopedOn(base, ctx, (db) =>
      db.inbox.updateMany({
        where: { chatwootInstanceId: id },
        data: { agentId: null },
      }),
    );
  }
  await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.update({
      where: { id },
      data: { disconnectedAt: new Date() },
    }),
  );
  // The receiver caches "this route token resolves to a live bot" by hash. Without this, events for
  // an account just disconnected would keep being processed until the entry expires.
  invalidateRouteTokenCache();
}

// Reconnect a soft-disconnected account: clear disconnectedAt (reusing the stored admin token). The
// operator must re-bind agents to the inboxes afterward (the disconnect intentionally unbound them).
export async function reconnectChatwootInstance(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<ChatwootInstanceDto> {
  const dto = await runScopedOn(base, ctx, async (db) => {
    const inst = await db.chatwootInstance.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!inst) {
      throw new NotFoundError(
        "chatwoot instance not found",
        "errors.chatwootInstanceNotFound",
      );
    }
    // The one-deployment invariant is structural now (the account already belongs to the tenant's
    // single deployment), so reconnecting just clears the flag.
    const row = await db.chatwootInstance.update({
      where: { id },
      data: { disconnectedAt: null },
      select: SELECT,
    });
    return toDto(row);
  });
  // NOTE: Mirrors the disconnect, and outside the transaction for the same reason: an event arriving
  // between the clear and the commit would re-cache the refusal it just read.
  invalidateRouteTokenCache();
  return dto;
}

// HARD-remove ONE account: delete the ChatwootInstance row (cascading its inboxes / conversations /
// bots / webhook deliveries / agent threads), freeing the (serverKey, accountId) slot so the account
// can be moved to ANOTHER tenant. Contacts are tenant-level (no FK) and are KEPT — they may belong to
// the tenant's other accounts. Irreversible; the caller (controller) hard-gates it (SUPER_ADMIN +
// re-typed name + password). Best-effort: the abandoned Chatwoot bots are left as-is — their route
// token no longer resolves once this row is gone, so their webhooks are simply rejected.
export async function removeChatwootInstance(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  await runScopedOn(base, ctx, async (db) => {
    const inst = await db.chatwootInstance.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!inst) {
      throw new NotFoundError(
        "chatwoot instance not found",
        "errors.chatwootInstanceNotFound",
      );
    }
    await db.chatwootInstance.delete({ where: { id } });
  });
  // NOTE: The delete cascades this instance's ChatwootAgentBot rows (schema.prisma: `onDelete: Cascade`),
  // so every route token it owned now resolves to nothing. Without this the receiver keeps
  // authenticating a retired token from memory, and the detached processing behind it fails on rows
  // that are gone.
  invalidateRouteTokenCache();
}

export interface InboxDto {
  id: string;
  // The owning Chatwoot instance — `chatwootInboxId`/name are per-account and can collide across
  // instances, so the UI needs this to group/label inboxes when a tenant has more than one.
  chatwootInstanceId: string;
  chatwootInboxId: number;
  name: string;
  channelType: string | null;
  provider: string | null;
  agentId: string | null;
}

const INBOX_SELECT = {
  id: true,
  chatwootInstanceId: true,
  chatwootInboxId: true,
  name: true,
  channelType: true,
  provider: true,
  agentId: true,
} as const;

function toInboxDto(r: {
  id: bigint;
  chatwootInstanceId: bigint;
  chatwootInboxId: number;
  name: string;
  channelType: string | null;
  provider: string | null;
  agentId: bigint | null;
}): InboxDto {
  return {
    id: String(r.id),
    chatwootInstanceId: String(r.chatwootInstanceId),
    chatwootInboxId: r.chatwootInboxId,
    name: r.name,
    channelType: r.channelType,
    provider: r.provider,
    agentId: r.agentId === null ? null : String(r.agentId),
  };
}

export async function listInboxes(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<InboxDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({ orderBy: { id: "asc" }, select: INBOX_SELECT }),
  );
  return rows.map(toInboxDto);
}

// The agent's bound inboxes on which CHATWOOT sends an out-of-hours reply of its own, read LIVE from
// Chatwoot rather than from the mirror. Feeds one configuration warning in the agent editor: the
// customer can be told the business is closed by one product and then served by the other, and nothing
// in either console says so, because the two settings live on opposite sides of the boundary.
//
// Live, and not a column on Inbox, because of what the warning IS. `syncInboxes` runs when an account
// is connected and when an operator presses the button, so a mirrored copy of this flag would keep
// warning about an inbox whose out-of-hours reply was switched off weeks ago, and the only way to
// clear it would be to find a sync button on another page. A warning that outlives the thing it names
// is how a whole panel gets ignored.
//
// An instance that cannot be read contributes NOTHING instead of failing the call: a Chatwoot that is
// down is not evidence that anything is misconfigured, and this is a warning nobody is waiting on. The
// same call answers "checked, all clear" and "could not check" with an empty list on purpose — both
// render as silence, so a status field here would exist only to be ignored.
export async function listOutOfOfficeInboxes(
  ctx: TenantContext,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ id: string; name: string }[]> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const bound = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { agentId },
      orderBy: { id: "asc" },
      select: { id: true, chatwootInstanceId: true, chatwootInboxId: true },
    }),
  );

  // One list call per distinct account, not per inbox: GET /inboxes is account-wide, and an agent
  // bound to six inboxes of one account must not cost six round trips.
  //
  // Concurrent, because the ceiling here is a timeout and not a duration. Every Chatwoot request
  // carries a 15s abort, so reading two accounts in sequence makes an unreachable server cost 30s of
  // an editor-load request that is producing a warning nobody is waiting on — and the second account
  // being healthy would not help, it would just be answered late. Unbounded on purpose: the fan-out
  // is the number of Chatwoot accounts the operator connected, a small number they chose, not
  // anything that grows with traffic.
  const armedByInstance = new Map(
    (
      await Promise.all(
        [...new Set(bound.map((b) => b.chatwootInstanceId))].map(
          async (instanceId) => {
            try {
              const client = await loadChatwootClient(tenantId, instanceId, {
                base,
                makeClient: deps.makeClient,
              });
              const armed = new Map<number, string>();
              for (const remote of parseInboxList(await client.listInboxes())) {
                if (chatwootAutoRepliesOutOfHours(remote)) {
                  armed.set(remote.chatwootInboxId, remote.name);
                }
              }
              return [instanceId, armed] as const;
            } catch {
              // unreachable / unauthorized — say nothing about this account's inboxes, and do not
              // let it decide the answer for the others
              return null;
            }
          },
        ),
      )
    ).filter((entry) => entry !== null),
  );

  // Chatwoot's name, not the mirror's: this reading exists because the mirror can be stale, and the
  // inbox the operator has to go find is the one named on the other side.
  const out: { id: string; name: string }[] = [];
  for (const row of bound) {
    const name = armedByInstance
      .get(row.chatwootInstanceId)
      ?.get(row.chatwootInboxId);
    if (name !== undefined) out.push({ id: String(row.id), name });
  }
  return out;
}

export type { WidgetHealth, WidgetHealthStatus };

// Live health of a web-widget inbox's website_url (the WhatsApp→website-chat redirect target).
// Fetches the inbox from Chatwoot (admin token) and classifies its website_url with the SAME
// normalizer the runtime link builder uses, so the editor's Redirect-tab warning matches actual
// redirect behavior. `inboxId` is the mirror Inbox.id (unambiguous — chatwootInboxId can collide
// across instances). An unreachable Chatwoot / unknown inbox surfaces as "unknown" (couldn't verify),
// NOT "invalid" — so a transient outage never raises a false "your Website URL is broken" alert.
export async function getWidgetInboxHealth(
  ctx: TenantContext,
  inboxId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<WidgetHealth> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const row = await runScopedOn(base, ctx, (db) =>
    db.inbox.findUnique({
      where: { id: inboxId },
      select: { chatwootInstanceId: true, chatwootInboxId: true },
    }),
  );
  if (!row) return classifyWidgetHealth(false, null);
  try {
    const client = await loadChatwootClient(tenantId, row.chatwootInstanceId, {
      base,
      makeClient: deps.makeClient,
    });
    const inbox = await client.getWebWidgetInbox(row.chatwootInboxId);
    return classifyWidgetHealth(true, inbox?.websiteUrl ?? null);
  } catch {
    return classifyWidgetHealth(false, null);
  }
}

export type InboxBotStatus = "active" | "missing";

// Live reconcile for the Channels UI: for each BOUND inbox, is its persona's Chatwoot Agent Bot still
// alive? Returns inboxId(string) → "active" | "missing". Read-only (no re-provision; that's the
// explicit Reconnect action). Best-effort per instance: an unreachable Chatwoot OMITS that instance's
// inboxes, so the client shows "unverified" rather than a false "removed". A bound inbox whose persona
// has no bot row (shouldn't happen) is reported "missing" → reconnect repairs it.
export async function reconcileInboxBots(
  ctx: TenantContext,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<Record<string, InboxBotStatus>> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const inboxes = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { agentId: { not: null } },
      select: { id: true, chatwootInstanceId: true, agentId: true },
    }),
  );
  if (inboxes.length === 0) return {};
  const bots = await runScopedOn(base, ctx, (db) =>
    db.chatwootAgentBot.findMany({
      select: {
        chatwootInstanceId: true,
        agentId: true,
        chatwootAgentBotId: true,
      },
    }),
  );
  const botByKey = new Map<string, number>();
  for (const b of bots) {
    botByKey.set(`${b.chatwootInstanceId}:${b.agentId}`, b.chatwootAgentBotId);
  }
  const byInstance = new Map<bigint, typeof inboxes>();
  for (const ib of inboxes) {
    const list = byInstance.get(ib.chatwootInstanceId) ?? [];
    list.push(ib);
    byInstance.set(ib.chatwootInstanceId, list);
  }
  const result: Record<string, InboxBotStatus> = {};
  for (const [instanceId, list] of byInstance) {
    let liveIds: Set<number>;
    try {
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps.makeClient,
      });
      liveIds = new Set((await client.listAgentBots()).map((b) => b.id));
    } catch {
      // Unreachable instance → leave its inboxes unreported (client treats absent as "unverified").
      continue;
    }
    for (const ib of list) {
      const botId =
        ib.agentId != null
          ? botByKey.get(`${instanceId}:${ib.agentId}`)
          : undefined;
      result[String(ib.id)] =
        botId != null && liveIds.has(botId) ? "active" : "missing";
    }
  }
  return result;
}

// Re-provision + reconnect the persona bot for an inbox — the "Reconnect" action when the bot was
// deleted out-of-band on Chatwoot. Bypasses bindInbox's same-agent no-op; ensureAgentBot self-heals
// (detects the missing bot and re-provisions). Network failure → uniform 502.
export async function reconnectInbox(
  ctx: TenantContext,
  inboxId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<InboxDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const { inbox, agentId, agentName } = await runScopedOn(
    base,
    ctx,
    async (db) => {
      const row = await db.inbox.findUnique({
        where: { id: inboxId },
        select: {
          id: true,
          chatwootInstanceId: true,
          chatwootInboxId: true,
          agentId: true,
        },
      });
      if (!row) {
        throw new NotFoundError("inbox not found", "errors.inboxNotFound");
      }
      if (row.agentId === null) {
        throw new AppError(
          "inbox has no agent to reconnect",
          409,
          "errors.inboxNotBound",
        );
      }
      const agent = await db.agent.findUnique({
        where: { id: row.agentId },
        select: { name: true },
      });
      if (!agent) {
        throw new NotFoundError("agent not found", "errors.agentNotFound");
      }
      return { inbox: row, agentId: row.agentId, agentName: agent.name };
    },
  );
  try {
    const client = await loadChatwootClient(
      tenantId,
      inbox.chatwootInstanceId,
      {
        base,
        makeClient: deps.makeClient,
      },
    );
    const bot = await ensureAgentBot(
      tenantId,
      inbox.chatwootInstanceId,
      agentId,
      agentName,
      client,
      { base },
    );
    await client.setInboxAgentBot(
      inbox.chatwootInboxId,
      bot.chatwootAgentBotId,
    );
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      "could not reconnect the bot with Chatwoot",
      502,
      "errors.chatwootRebindFailed",
    );
  }
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.inbox.findUniqueOrThrow({
      where: { id: inboxId },
      select: INBOX_SELECT,
    });
    return toInboxDto(row);
  });
}

export interface AgentTeamDto {
  id: number;
  name: string;
}

// Live agents + teams from the tenant's Chatwoot instance, for the handoff-targeting picker. Unlike
// inboxes (mirrored locally) these are read live via the admin token. Resolves the tenant's first
// instance; returns empty lists if there is none (the editor degrades gracefully). NOTE: a tenant
// with multiple instances lists the first one's agents/teams — runtime assignment still uses the
// conversation's own instance client, so the pinned id only needs to be valid there.
// One Chatwoot account an agent serves (derived from its bound inboxes), for the handoff picker.
export interface HandoffAccountDto {
  instanceId: string;
  accountId: number;
  accountName: string | null;
}

// Agents/teams for the handoff "pinned" picker, scoped to the accounts the agent serves (via its
// bound inboxes). A pinned target is account-scoped, so agents/teams are listed ONLY when the agent
// serves exactly one account; with 0 (no inbox) or ≥2 (multi-account) the lists stay empty and the
// editor disables pinning. `accounts` always reports the distinct accounts (for the disabled hint).
export async function listAgentsAndTeams(
  ctx: TenantContext,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{
  agents: AgentTeamDto[];
  teams: AgentTeamDto[];
  accounts: HandoffAccountDto[];
}> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const rows = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { agentId },
      select: {
        instance: {
          select: { id: true, accountId: true, accountName: true },
        },
      },
    }),
  );
  const byId = new Map<string, HandoffAccountDto>();
  for (const r of rows) {
    byId.set(String(r.instance.id), {
      instanceId: String(r.instance.id),
      accountId: r.instance.accountId,
      accountName: r.instance.accountName,
    });
  }
  const accounts = [...byId.values()];
  const only = accounts[0];
  if (accounts.length !== 1 || !only) {
    return { agents: [], teams: [], accounts };
  }
  const client = await loadChatwootClient(tenantId, BigInt(only.instanceId), {
    base,
    makeClient: deps.makeClient,
  });
  const [agents, teams] = await Promise.all([
    client.listAgents(),
    client.listTeams(),
  ]);
  return { agents, teams, accounts };
}

export interface ServiceWindowTemplateDto {
  name: string;
  category: string;
  language: string;
}

// Approved WhatsApp HSM templates available to an agent's inbox(es), for the service-window template
// picker. Reads live (admin token) across the agent's bound inboxes, grouped by instance, deduped by
// name. Best-effort: an unreachable instance contributes nothing. Empty for baileys inboxes (no HSM)
// — the editor falls back to a free-text field.
export async function listServiceWindowTemplates(
  ctx: TenantContext,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ templates: ServiceWindowTemplateDto[] }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const inboxes = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { agentId },
      select: { chatwootInstanceId: true, chatwootInboxId: true },
    }),
  );
  if (inboxes.length === 0) return { templates: [] };
  const byInstance = new Map<bigint, number[]>();
  for (const ib of inboxes) {
    const list = byInstance.get(ib.chatwootInstanceId) ?? [];
    list.push(ib.chatwootInboxId);
    byInstance.set(ib.chatwootInstanceId, list);
  }
  const byName = new Map<string, ServiceWindowTemplateDto>();
  for (const [instanceId, inboxIds] of byInstance) {
    try {
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps.makeClient,
      });
      for (const inboxId of inboxIds) {
        for (const tpl of await client.listMessageTemplates(inboxId)) {
          if (!byName.has(tpl.name)) byName.set(tpl.name, tpl);
        }
      }
    } catch {
      // best-effort: an unreachable instance contributes no templates
    }
  }
  return { templates: [...byName.values()] };
}

// NOTE: The Chatwoot instances an agent's inboxes live on, plus how many distinct ACCOUNTS they
// span. Every per-account listing below (labels, custom-attribute definitions) unions across the
// instances and warns the editor when accountCount > 1, so the resolution lives in one place.
async function agentInboxScope(
  ctx: TenantContext,
  agentId: bigint,
  base: PrismaClient,
): Promise<{ instanceIds: bigint[]; accountCount: number }> {
  const inboxes = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { agentId },
      select: {
        chatwootInstanceId: true,
        instance: { select: { accountId: true } },
      },
    }),
  );
  return {
    instanceIds: [...new Set(inboxes.map((i) => i.chatwootInstanceId))],
    accountCount: new Set(
      inboxes.map((i) => i.instance?.accountId).filter((a) => a != null),
    ).size,
  };
}

// Account label TITLES available to an agent's inbox(es), for the follow-up step's label picker.
// Reads live (admin token) via the cached vocab, deduped across the agent's instances. Best-effort:
// an unreachable instance contributes nothing. Empty → the editor falls back to a free-text field.
export interface InboxLabel {
  title: string;
  color: string | null;
}

export async function listInboxLabels(
  ctx: TenantContext,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{
  labels: InboxLabel[];
  // Distinct Chatwoot accounts the agent's inboxes span. Labels are per-account, so when this is >1
  // the union below mixes accounts and the editor offers free-text entry with a warning (item 5),
  // mirroring the handoff targeting picker.
  accountCount: number;
}> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const { instanceIds, accountCount } = await agentInboxScope(
    ctx,
    agentId,
    base,
  );
  if (instanceIds.length === 0) return { labels: [], accountCount: 0 };
  const byTitle = new Map<string, InboxLabel>();
  for (const instanceId of instanceIds) {
    try {
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps.makeClient,
      });
      for (const label of await client.listLabelsDetailed()) {
        if (!byTitle.has(label.title)) byTitle.set(label.title, label);
      }
    } catch {
      // best-effort: an unreachable instance contributes no labels
    }
  }
  return { labels: [...byTitle.values()], accountCount };
}

// NOTE: Custom-attribute DEFINITIONS available to an agent's inbox(es), for the attribute-context
// picker. Same best-effort contract as listInboxLabels, deduped by (model, key).
export interface InboxCustomAttribute {
  key: string;
  displayName: string;
  // NOTE: Chatwoot `attribute_model`: conversation_attribute | contact_attribute | task_attribute …
  model: string;
}

export async function listInboxCustomAttributes(
  ctx: TenantContext,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ attributes: InboxCustomAttribute[]; accountCount: number }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const { instanceIds, accountCount } = await agentInboxScope(
    ctx,
    agentId,
    base,
  );
  if (instanceIds.length === 0) return { attributes: [], accountCount: 0 };
  const byKey = new Map<string, InboxCustomAttribute>();
  for (const instanceId of instanceIds) {
    try {
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps.makeClient,
      });
      for (const def of await client.listCustomAttributeDefinitions()) {
        const id = `${def.model}:${def.key}`;
        if (byKey.has(id)) continue;
        byKey.set(id, {
          key: def.key,
          displayName: def.displayName,
          model: def.model,
        });
      }
    } catch {
      // NOTE: best-effort — an unreachable instance contributes no definitions
    }
  }
  return { attributes: [...byKey.values()], accountCount };
}

// An unbind asks Chatwoot for ONE state: no agent bot connected to this inbox. A 404 from
// set_agent_bot means the inbox is not there to carry one, which already IS that state, so nothing is
// left to desynchronize and the local binding may clear. Measured on the fork (4.16.0 and 4.17.0): a
// deleted inbox answers 404 {"error":"Resource could not be found"}, a live one answers 200, and a
// credential that lost access to the account answers 401 — so this route's only 404s are a missing
// inbox and a missing account, and neither can be holding a bot of ours. Every other failure keeps
// the fence, because it leaves a bot that may still be connected and delivering that inbox's events.
export function unbindNeedsNothingRemote(err: unknown): boolean {
  return err instanceof ChatwootApiError && err.status === 404;
}

// The load-bearing binding: which agent answers an inbox. This is the SINGLE operator action that
// wires an inbox end-to-end — there is no separate "provision the bot" step. The bot is per-persona:
//   - bind / switch (→ agent): lazily ensure THAT persona's Agent Bot exists, connect it to this
//     inbox on Chatwoot (set_agent_bot replaces any prior bot on the inbox), then store agentId.
//   - unbind (agent → none): DISCONNECT the bot from this inbox (so it stops delivering events that
//     would otherwise strand conversations as `pending`), then clear agentId.
//   - rebinding the SAME agent is a no-op (no network).
// Network I/O (ensure/connect/disconnect) runs OUTSIDE the scoped tx that persists agentId.
export async function bindInbox(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint | null,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<InboxDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;

  // 1. Scoped reads: the inbox (+ its Chatwoot coordinates and current binding) and, when
  //    connecting, the target agent (validated + its name, which becomes the bot's display name).
  const { inbox, agentName } = await runScopedOn(base, ctx, async (db) => {
    const row = await db.inbox.findUnique({
      where: { id: inboxId },
      select: {
        id: true,
        chatwootInstanceId: true,
        chatwootInboxId: true,
        agentId: true,
        instance: { select: { disconnectedAt: true } },
      },
    });
    if (!row) {
      throw new NotFoundError("inbox not found", "errors.inboxNotFound");
    }
    // Binding to a disconnected account would provision a bot on an account we no longer handle.
    // Reject it (the account must be reconnected first); unbinding (agentId null) stays allowed.
    if (agentId !== null && row.instance.disconnectedAt !== null) {
      throw new AppError(
        "this account is disconnected; reconnect it before assigning an agent",
        409,
        "errors.chatwootAccountDisconnected",
      );
    }
    let name = "";
    if (agentId !== null) {
      const agent = await db.agent.findUnique({
        where: { id: agentId },
        select: { name: true },
      });
      if (!agent) {
        throw new NotFoundError("agent not found", "errors.agentNotFound");
      }
      name = agent.name;
    }
    return { inbox: row, agentName: name };
  });

  // 2. Sync the Chatwoot side OUTSIDE any tx (only when the connection actually changes). A
  //    Chatwoot/network failure surfaces as a uniform 502 (ChatwootApiError carries PII-free status
  //    only); we never persist agentId if this step fails, so our state and Chatwoot stay in sync.
  try {
    if (agentId !== null && agentId !== inbox.agentId) {
      // bind or switch: ensure the persona's bot and connect it (replaces any prior bot on the inbox).
      const client = await loadChatwootClient(
        tenantId,
        inbox.chatwootInstanceId,
        { base, makeClient: deps.makeClient },
      );
      const bot = await ensureAgentBot(
        tenantId,
        inbox.chatwootInstanceId,
        agentId,
        agentName,
        client,
        { base },
      );
      await client.setInboxAgentBot(
        inbox.chatwootInboxId,
        bot.chatwootAgentBotId,
      );
    } else if (agentId === null && inbox.agentId !== null) {
      // unbind: detach whatever persona bot is connected to this inbox.
      const client = await loadChatwootClient(
        tenantId,
        inbox.chatwootInstanceId,
        { base, makeClient: deps.makeClient },
      );
      try {
        await client.setInboxAgentBot(inbox.chatwootInboxId, null);
      } catch (err) {
        if (!unbindNeedsNothingRemote(err)) throw err;
      }
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(
      "could not sync the bot with Chatwoot",
      502,
      "errors.chatwootBindFailed",
    );
  }

  // 3. Persist the binding (scoped, no network).
  return runScopedOn(base, ctx, async (db) => {
    await db.inbox.update({ where: { id: inboxId }, data: { agentId } });
    const row = await db.inbox.findUniqueOrThrow({
      where: { id: inboxId },
      select: INBOX_SELECT,
    });
    return toInboxDto(row);
  });
}

// Whether Chatwoot ANSWERED that this inbox does not exist. This is the single fact that authorizes
// destroying an operator's mirror row, so it is deliberately narrow: only our own error type, and
// only a 404. Everything else — a refusal, a broken Chatwoot, a wrong credential, a request that
// never left — means we did not get an answer, and "we could not ask" must never read as "it is
// gone". Measured live against the fork (2026-08-25): a live inbox answers 200, an absent one 404
// {"error":"Resource could not be found"}, a missing token 401. A 403 is the interesting one: the
// controller runs `authorize @inbox, :show?` AFTER the `find`, so a 403 proves the inbox EXISTS.
//
// Shares a body with `unbindNeedsNothingRemote` and is deliberately a different function. That one
// asks "is there nothing left to disconnect?" of a POST to /set_agent_bot; this asks "does this
// inbox exist?" of a GET on the inbox. They agree only because both routes happen to resolve through
// the same `find`, and either route's 404 semantics could change without the other. The costs differ
// too: a wrong answer there skips a call, a wrong answer here deletes a row.
export function remoteInboxIsGone(err: unknown): boolean {
  return err instanceof ChatwootApiError && err.status === 404;
}

// Read the mirror row and ask Chatwoot whether its inbox still exists. Shared by the removal and by
// the removal's PREVIEW, so a dry run answers the same question the write answers: a preview that
// replies from its arguments alone approves exactly what the write then refuses.
async function loadInboxAndAsk(
  ctx: TenantContext,
  inboxId: bigint,
  deps: LoadChatwootClientDeps,
  base: PrismaClient,
): Promise<{ inbox: InboxDto; gone: boolean }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;

  const row = await runScopedOn(base, ctx, (db) =>
    db.inbox.findUnique({ where: { id: inboxId }, select: INBOX_SELECT }),
  );
  if (!row) {
    throw new NotFoundError("inbox not found", "errors.inboxNotFound");
  }

  // Ask, OUTSIDE any tx. NOTE: unlike `bindInbox`, an AppError raised while loading the client is
  // NOT rethrown as itself — every way of failing to get an answer collapses into the same refusal,
  // because the only thing that matters downstream is that we did not get the 404.
  try {
    const client = await loadChatwootClient(tenantId, row.chatwootInstanceId, {
      base,
      makeClient: deps.makeClient,
    });
    await client.getInbox(row.chatwootInboxId);
  } catch (err) {
    if (!remoteInboxIsGone(err)) {
      // NOTE: the sentence says CONFIRM and not "reach", because this branch also carries answers
      // that did reach us (401, 403, 500). "Could not reach Chatwoot" would be false for those, and
      // a sentence that is false on a branch it covers is the defect issue #292 spent a PR removing.
      throw new AppError(
        "could not confirm with Chatwoot that this inbox was deleted",
        502,
        "errors.chatwootInboxProbeFailed",
      );
    }
    return { inbox: toInboxDto(row), gone: true };
  }
  return { inbox: toInboxDto(row), gone: false };
}

// The preview half, for a transport that offers a dry run before it writes.
export async function previewInboxRemoval(
  ctx: TenantContext,
  inboxId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ inbox: InboxDto; gone: boolean }> {
  return loadInboxAndAsk(ctx, inboxId, deps, base);
}

// Remove the mirror of an inbox that no longer exists in Chatwoot — the explicit action that the
// comment in `syncInboxes` points at. Pruning on sync was considered and rejected there (a sync that
// cannot reach an inbox would otherwise delete a binding the operator configured), which left the
// orphan with no lifecycle at all.
//
// THE FENCE IS THE FEATURE. The mirror recreates an `Inbox` row for any inbox that sends us traffic
// (`upsertInbox`, deliberately: mirroring has to work before an operator binds anything), so
// deleting the mirror of a LIVE inbox does not remove anything — the next message rebuilds the row
// with no agent bound, and the customer lands in `emitUnroutedMessage` with nobody to answer. A
// removal is therefore only ever correct for an inbox Chatwoot states is gone.
//
// Reads Chatwoot, never writes to it, and needs no remote cleanup: the inbox is gone, so no persona
// bot of ours is connected to it. Conversations are kept (`Inbox.conversations` is `onDelete:
// SetNull`); `llm_usage.inbox_id` and `execution_logs.inbox_id` are bare columns with no foreign
// key, so past spend and past log lines survive with a dangling id and the dashboard renders them as
// an unnamed bucket. That trade is the point: the operator asked for the row to go.
export async function removeInbox(
  ctx: TenantContext,
  inboxId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<void> {
  const { gone } = await loadInboxAndAsk(ctx, inboxId, deps, base);
  if (!gone) {
    throw new AppError(
      "this inbox still exists in Chatwoot; delete it there first",
      409,
      "errors.inboxStillExists",
    );
  }

  // NOTE: a writer that is ALREADY in flight can put the row back, and that is deliberate rather
  // than unhandled. Two can: a `syncInboxes` whose remote list was fetched before the upstream
  // deletion, and a webhook delivery being mirrored. Neither is worth a tombstone, and a tombstone
  // would be the harmful fix: `upsertInbox` recreating a row because TRAFFIC arrived is the
  // behaviour this whole fence rests on, so a row that refuses to be recreated is an inbox whose
  // customers reach nobody and whose messages are mirrored nowhere — silently, and with no operator
  // action that repairs it. What the window costs today is a row reappearing unbound, which the
  // operator removes again; what a tombstone would cost is traffic. The window is also small by
  // construction: a sync started after the upstream deletion cannot list the inbox at all.
  // `deleteMany`, not `delete`: the row was read, then the network was asked, so a concurrent
  // removal can land in between and `delete` would answer that window with a P2025 — a 500 for two
  // operators doing the same correct thing. A DELETE is idempotent, and "it is already gone" is the
  // outcome the caller asked for.
  await runScopedOn(base, ctx, async (db) => {
    await db.inbox.deleteMany({ where: { id: inboxId } });
  });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface RemoteInbox {
  chatwootInboxId: number;
  name: string;
  channelType: string | null;
  // WhatsApp provider (whatsapp_cloud | default | baileys | zapi) — only meaningful for
  // Channel::Whatsapp; null otherwise. Surfaced by the inbox serializer (json.provider).
  provider: string | null;
  // Chatwoot's OWN out-of-hours auto-reply, the two halves of it that are configuration
  // (json.working_hours_enabled / json.out_of_office_message on the same serializer). Kept because an
  // agent can be bound to an inbox that already answers out of hours on a schedule this product
  // cannot see — chatwootAutoRepliesOutOfHours (./out-of-office.ts) is the rule that reads them.
  workingHoursEnabled: boolean;
  outOfOfficeMessage: string | null;
}

// Pure parse of the Chatwoot inbox-list response. Confirmed against the chatwoot-pro fork:
// `{ payload: [{ id, name, channel_type, … }] }`. Tolerant of a bare array and of
// missing name/channel_type; skips entries without a numeric id.
export function parseInboxList(raw: unknown): RemoteInbox[] {
  const payload = isRecord(raw) ? raw.payload : raw;
  const arr = Array.isArray(payload) ? payload : [];
  const out: RemoteInbox[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const id =
      typeof item.id === "number"
        ? item.id
        : typeof item.id === "string" && /^\d+$/.test(item.id)
          ? Number(item.id)
          : null;
    if (id === null) continue;
    out.push({
      chatwootInboxId: id,
      name: typeof item.name === "string" ? item.name : `Inbox ${id}`,
      channelType:
        typeof item.channel_type === "string" ? item.channel_type : null,
      provider: typeof item.provider === "string" ? item.provider : null,
      // Strict boolean, like every other operator switch read off a wire we do not own: absent,
      // "true" and 1 all read as off, so a shape change can only ever stop the warning, never invent
      // one about an inbox that answers nothing.
      workingHoursEnabled: item.working_hours_enabled === true,
      outOfOfficeMessage:
        typeof item.out_of_office_message === "string"
          ? item.out_of_office_message
          : null,
    });
  }
  return out;
}

// ── account discovery (instance-setup helper) ──

export interface ChatwootAccountClaim {
  tenantId: string;
  tenantName: string | null;
  // True when the owner is the tenant currently being configured (a reconnectable own account),
  // false when another tenant owns it (blocked).
  isCurrent: boolean;
}

export interface ChatwootAccountSummary {
  id: number;
  name: string;
  role: string | null;
  // Which tenant already owns this Chatwoot account (server + id), if any — for the super-admin
  // account picker on a shared server. Populated only by listDeploymentAccounts (it has the
  // deployment's serverKey); undefined on the stateless pre-connect probe.
  claim?: ChatwootAccountClaim | null;
}

export const chatwootAccountsProbeSchema = z
  .object({
    baseUrl: z.string().url().max(2000),
    token: z.string().min(1).max(2000),
  })
  .strict();
export type ChatwootAccountsProbeInput = z.infer<
  typeof chatwootAccountsProbeSchema
>;

// Pure parse of the Chatwoot `/api/v1/profile` response. The owner's reachable accounts live under
// `accounts: [{ id, name, role, … }]`. Tolerant of a bare array, a missing `accounts`, a string id,
// and a missing name/role; skips entries without a numeric id. Returns [] when the token is valid
// but attached to no account (the caller then offers the manual-id fallback).
export function parseChatwootAccounts(raw: unknown): ChatwootAccountSummary[] {
  const accounts = isRecord(raw) ? raw.accounts : raw;
  const arr = Array.isArray(accounts) ? accounts : [];
  const out: ChatwootAccountSummary[] = [];
  for (const item of arr) {
    if (!isRecord(item)) continue;
    const id =
      typeof item.id === "number"
        ? item.id
        : typeof item.id === "string" && /^\d+$/.test(item.id)
          ? Number(item.id)
          : null;
    if (id === null) continue;
    out.push({
      id,
      name: typeof item.name === "string" ? item.name : `Account ${id}`,
      role: typeof item.role === "string" ? item.role : null,
    });
  }
  return out;
}

export interface ListAccountsDeps {
  fetchProfile?: (p: { baseUrl: string; token: string }) => Promise<unknown>;
}

// Turns a (baseUrl, token) pair into the list of accounts that token can reach, for the
// instance-setup form (so the operator never types the numeric accountId by hand). Stateless: no DB
// write, the token is NOT persisted (it is provided again at create-time). Network/SSRF/auth failure
// surfaces as a clean 502 the UI converts into the manual-id fallback.
export async function listChatwootAccounts(
  input: ChatwootAccountsProbeInput,
  deps: ListAccountsDeps = {},
): Promise<ChatwootAccountSummary[]> {
  const data = parseInput(chatwootAccountsProbeSchema, input);
  const fetchProfile = deps.fetchProfile ?? fetchChatwootProfile;
  let raw: unknown;
  try {
    raw = await fetchProfile({ baseUrl: data.baseUrl, token: data.token });
  } catch {
    // NOTE: never surface the underlying message (it can echo the URL) and never log the token —
    // a uniform 502 + i18n key keeps the response predictable for the manual-id fallback.
    throw new AppError(
      "could not reach Chatwoot with the provided URL/token",
      502,
      "errors.chatwootProfileFailed",
    );
  }
  return parseChatwootAccounts(raw);
}

export interface SyncInboxesResult {
  total: number;
  created: number;
  updated: number;
}

// Pull the inbox list from Chatwoot (admin-token) and reconcile the local mirror: upsert by
// (tenant, instance, chatwootInboxId), refreshing name/channelType. The agent BINDING
// (`Inbox.agentId`) is owned locally and PRESERVED — sync never clears it. Inboxes removed upstream
// are left in place (keeping a binding beats pruning it; an explicit unbind is a separate action).
// DNS + the GET happen OUTSIDE the tx; only the upserts run inside the scoped tx.
export async function syncInboxes(
  ctx: TenantContext,
  instanceId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<SyncInboxesResult> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  // Confirm the instance belongs to the tenant (scoped) before any network.
  const instance = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findUnique({
      where: { id: instanceId },
      select: { id: true },
    }),
  );
  if (!instance) {
    throw new NotFoundError(
      "chatwoot instance not found",
      "errors.chatwootInstanceNotFound",
    );
  }
  // Network OUTSIDE the tx.
  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    makeClient: deps.makeClient,
  });
  const remote = parseInboxList(await client.listInboxes());

  // Best-effort: refresh the account display name (Chatwoot can rename it). Sync is the operator's
  // explicit "reconcile with Chatwoot" gesture, so it is the natural moment. A failure is ignored —
  // the stored name (or null) is kept and the #id badge still identifies the account.
  let accountName: string | undefined;
  try {
    const name = await client.getAccountName();
    if (name) accountName = name;
  } catch {
    // ignore — keep the stored name
  }

  // Reconcile (scoped tx, no network).
  return runScopedOn(base, ctx, async (db) => {
    if (accountName !== undefined) {
      await db.chatwootInstance.update({
        where: { id: instanceId },
        data: { accountName },
      });
    }
    let created = 0;
    let updated = 0;
    for (const inbox of remote) {
      const existing = await db.inbox.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootInboxId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId: inbox.chatwootInboxId,
          },
        },
        select: { id: true },
      });
      // Atomic INSERT … ON CONFLICT: concurrent syncs (the load-time auto-sync and the manual
      // button) can race on the unique key, and a failed create inside this scoped $transaction
      // would poison every later statement (P2002 aborts the whole tx — a catch-and-update here
      // can never run). The pre-read only feeds the created/updated counters, so the worst a race
      // can do is report a created row that a concurrent sync actually created first.
      await db.inbox.upsert({
        where: {
          tenantId_chatwootInstanceId_chatwootInboxId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootInboxId: inbox.chatwootInboxId,
          },
        },
        create: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inbox.chatwootInboxId,
          name: inbox.name,
          channelType: inbox.channelType,
          provider: inbox.provider,
        },
        update: {
          name: inbox.name,
          channelType: inbox.channelType,
          provider: inbox.provider,
        },
      });
      if (existing) updated++;
      else created++;
    }
    return { total: remote.length, created, updated };
  });
}
