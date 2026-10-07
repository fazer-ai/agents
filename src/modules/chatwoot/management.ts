import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isMonitoring } from "@/modules/agents/mode";
import { redactEndpoint } from "@/modules/audit/projection";
import { auditMutation } from "@/modules/audit/service";
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
import { type EnsuredAgentBot, ensureAgentBot } from "./provisioning";
import { invalidateRouteTokenCache } from "./route-token-cache";

// Chatwoot deployment + account + inbox management (per-tenant). A DEPLOYMENT (base URL + shared admin
// token, registered ONCE per tenant) holds the connection; ACCOUNTS (ChatwootInstance rows) hang off
// it and reuse its token. Tokens are write-only (encrypted at rest, never returned — DTOs expose only
// presence flags). There is NO explicit "provision the bot" step: the Agent Bot is created lazily on
// the first `bindInbox` (see ensureAgentBot). `syncInboxes` pulls the inbox list from Chatwoot
// (admin-token) into the mirror so an operator can see/bind inboxes before any message arrives.

// One Chatwoot account under the tenant's deployment. baseUrl and admin-token presence are
// deployment-level (see ChatwootDeploymentDto), not on the account DTO.
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
    const dep = await db.chatwootDeployment.findFirst({
      select: { id: true, baseUrl: true },
    });
    if (!dep) {
      throw new NotFoundError(
        "no chatwoot deployment connected",
        "errors.chatwootDeploymentNotFound",
      );
    }
    // NOTE: the deployment and then every account under it, before the counts: the outermost of the
    // module's three lock levels, so a sync or connect committing between the count and the delete
    // cannot add rows the count never mentioned (the deployment lock stops new accounts, the account
    // locks stop their inboxes moving).
    // TODO: an inbox mirrored by inbound traffic (`upsertInbox`, no account lock) can still land in
    // the same instant and be counted low; locking the delivery path for an audit number is not worth it.
    await db.$queryRaw`SELECT id FROM chatwoot_deployments WHERE id = ${dep.id} FOR NO KEY UPDATE`;
    await db.$queryRaw`SELECT id FROM chatwoot_instances WHERE deployment_id = ${dep.id} ORDER BY id FOR NO KEY UPDATE`;
    // What went with it, counted before the delete (the widest destructive act the console
    // offers; contacts are deleted by hand since no cascade reaches them). Recorded before the delete:
    // `audit_logs.tenant_id` cascades on the tenant, which is not what is deleted here.
    const [accounts, inboxes, contacts] = await Promise.all([
      db.chatwootInstance.count(),
      db.inbox.count(),
      db.contact.count(),
    ]);
    await auditMutation(db, ctx, {
      action: "deployment.disconnect",
      target: `chatwoot_deployment:${dep.id}`,
      before: {
        id: String(dep.id),
        baseUrl: redactEndpoint(dep.baseUrl),
        accounts,
        inboxes,
        contacts,
      },
    });
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

// One tenant, one Chatwoot server: a connect naming a different base URL than the stored one is
// refused, and disconnecting is the only way to switch. The write and the preview both compare the
// normalized input here, which is also what gets stored, so they cannot disagree.
function assertNotADifferentDeployment(
  existing: { baseUrl: string } | null,
  wantedBaseUrl: string,
): void {
  if (existing && existing.baseUrl !== wantedBaseUrl) {
    throw new ConflictError(
      "this tenant is already connected to a different Chatwoot deployment; disconnect it first to switch servers",
      "errors.chatwootDifferentDeployment",
    );
  }
}

// The database half of `connectChatwootDeployment`'s verdict. ADVISORY, like the uniqueness checks:
// it reads outside the write's transaction, so a tenant with nothing connected here can have a
// deployment by the time the apply lands. What it buys is the refusal that actually happens — an
// operator pointing at a second server — arriving before the preview promises a connection, and
// before the apply spends a round trip validating credentials against a server it will not accept.
export async function assertDeploymentNotSwitching(
  ctx: TenantContext,
  baseUrl: string,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const existing = await runScopedOn(base, ctx, (db) =>
    db.chatwootDeployment.findFirst({ select: { baseUrl: true } }),
  );
  assertNotADifferentDeployment(existing, baseUrl);
}

// What `connectChatwootDeployment` decides about its input before any database: the schema, the
// normalized base URL, and whether it may be reached at all (SSRF verdict, DNS included), so the MCP
// preview asks the same question the apply asks and cannot approve a URL the apply blocks. The
// credential probe stays in the apply: it is a call, which is why a preview cannot promise success.
export async function assertDeploymentConnectable(
  input: ChatwootDeploymentConnectInput,
) {
  const data = parseInput(chatwootDeploymentConnectSchema, input);
  data.baseUrl = normalizeChatwootBaseUrl(data.baseUrl);
  await assertSafeOutboundUrl(data.baseUrl); // DNS lookup OUTSIDE the tx
  return data;
}

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
  const data = await assertDeploymentConnectable(input);
  // NOTE: before the credential round trip. The transaction below remains the authority; asking
  // early avoids sending the admin token to a server we are about to reject, and keeps the refusal
  // the same as the preview's ("different deployment", not "bad credentials").
  await assertDeploymentNotSwitching(ctx, data.baseUrl, base);
  // Validate the credentials (and discover accounts) before persisting anything.
  const accounts = await listChatwootAccounts(
    { baseUrl: data.baseUrl, token: data.adminToken },
    deps,
  );
  // The base URL is intentionally NOT unique across tenants — one Chatwoot server can back many
  // tenants (cross-tenant uniqueness is enforced per ACCOUNT, see connectAccount + serverKey).
  const deployment = await runScopedOn(base, ctx, async (db) => {
    const existing = await db.chatwootDeployment.findFirst({
      select: { id: true, baseUrl: true },
    });
    assertNotADifferentDeployment(existing, data.baseUrl);
    if (existing) {
      await db.$queryRaw`SELECT id FROM chatwoot_deployments WHERE id = ${existing.id} FOR NO KEY UPDATE`;
    }
    const storedToken = existing
      ? readStoredToken(
          (
            await db.chatwootDeployment.findUniqueOrThrow({
              where: { id: existing.id },
              select: { adminToken: true },
            })
          ).adminToken,
        )
      : null;
    const row = existing
      ? await db.chatwootDeployment.update({
          where: { id: existing.id },
          data: { adminToken: encryptJson(data.adminToken) },
          select: DEPLOYMENT_SELECT,
        })
      : await db.chatwootDeployment.create({
          data: {
            tenantId,
            baseUrl: data.baseUrl,
            adminToken: encryptJson(data.adminToken),
          },
          select: DEPLOYMENT_SELECT,
        });
    const dto = toDeploymentDto(row);
    // NOTE: the server and how many accounts the token reached, never the token (a documented
    // raw-secret carve-out, `docs/mcp.md`, and this row outlives the deployment). A re-connect with
    // the same token is idempotent and records nothing; asked of the plaintext, because `encryptJson`
    // randomizes.
    if (existing === null) {
      await auditMutation(db, ctx, {
        action: "deployment.connect",
        target: `chatwoot_deployment:${dto.id}`,
        after: {
          id: dto.id,
          // NOTE: The ORIGIN, by the same rule every operator-entered URL answers to: this one is
          // typed by hand, `normalizeChatwootBaseUrl` keeps whatever path and userinfo came with
          // it, and the row outlives the deployment it names.
          baseUrl: redactEndpoint(dto.baseUrl),
          reachableAccounts: accounts.length,
        },
      });
    } else if (storedToken !== data.adminToken) {
      // NOTE: the action names the change, not the door: re-submitting against the connected
      // deployment changes only the admin token, the same write `rotateChatwootDeploymentToken`
      // records as `deployment.rotate_token`. Same write, same name, same projection (nothing about
      // either end of the token).
      await auditMutation(db, ctx, {
        action: "deployment.rotate_token",
        target: `chatwoot_deployment:${dto.id}`,
        after: { id: dto.id, adminTokenRotated: true },
      });
    }
    return dto;
  });
  return { deployment, accounts };
}

// The stored admin token as plaintext, only ever compared. `decryptJson` may throw, like every other
// reader of these columns: swallowing it would only fix the comparison, while the client loader,
// the webhook and the disconnect still throw, so connect would report success on a broken deployment.
function readStoredToken(blob: string): string {
  const v = decryptJson(blob);
  if (typeof v !== "string") {
    throw new AppError("stored Chatwoot admin token is not a string", 500);
  }
  return v;
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
    // NOTE: LOCKED before the token is read, or two identical rotations both read the old value and
    // both record a rotation only one of them performed.
    await db.$queryRaw`SELECT id FROM chatwoot_deployments WHERE id = ${dep.id} FOR NO KEY UPDATE`;
    const current = await db.chatwootDeployment.findUniqueOrThrow({
      where: { id: dep.id },
      select: { adminToken: true },
    });
    const row = await db.chatwootDeployment.update({
      where: { id: dep.id },
      data: { adminToken: encryptJson(token) },
      select: DEPLOYMENT_SELECT,
    });
    const dto = toDeploymentDto(row);
    // That it moved, never to or from what: a row keeping either end would outlive the
    // rotation. Asked of the plaintext, since `encryptJson` randomizes and a ciphertext comparison
    // would report a rotation on every retry.
    const moved = readStoredToken(current.adminToken) !== token;
    if (moved) {
      await auditMutation(db, ctx, {
        action: "deployment.rotate_token",
        target: `chatwoot_deployment:${dto.id}`,
        after: { id: dto.id, adminTokenRotated: true },
      });
    }
    return dto;
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
// caller can sync its inboxes, and whether this call is the one that put the account under the
// fleet: a concurrent request may have connected it first, and then this one changed nothing.
// accountName comes from the /profile probe (best-effort display only).
async function connectAccount(
  ctx: TenantContext,
  deploymentId: bigint,
  accountId: number,
  accountName: string | null,
  serverKey: string,
  base: PrismaClient,
): Promise<{ id: bigint; changed: boolean }> {
  const tenantId = ctx.tenantId;
  if (tenantId === null) throw new AppError("tenant required", 400);
  // A Chatwoot account belongs to ONE tenant fleet-wide. RLS hides another tenant's claim from the
  // scoped tx below, so pre-check cross-tenant (superuser read) for a friendly error; the unique
  // index on (serverKey, accountId) is the hard race-safe backstop on create.
  await assertAccountsNotTakenByAnotherTenant(base, tenantId, serverKey, [
    accountId,
  ]);
  const result = await runScopedOn(base, ctx, async (db) => {
    // NOTE: the deployment row first, outermost of the three (deployment, account, inboxes), so the
    // module locks in one order. It also keeps the disconnect's count honest: locking existing
    // accounts cannot block a new one being inserted, and this lock can.
    await db.$queryRaw`SELECT id FROM chatwoot_deployments WHERE id = ${deploymentId} FOR NO KEY UPDATE`;
    const existing = await db.chatwootInstance.findFirst({
      where: { accountId },
      select: { id: true },
    });
    if (existing) {
      // One conditional write decides the row: two overlapping requests both read the account
      // as disconnected under read-committed, and an unconditional update would record a second
      // `instance.connect`. With the condition in the `where`, the loser re-evaluates after the first
      // commits and matches nothing. The metadata rides inside the condition, so the loser does not
      // move `accountName` unrecorded.
      const { count } = await db.chatwootInstance.updateMany({
        where: { id: existing.id, disconnectedAt: { not: null } },
        data: { disconnectedAt: null, deploymentId, accountName, serverKey },
      });
      if (count > 0) {
        // NOTE: in this transaction, not with the choice that asked for it: `setConnectedAccounts`
        // connects one account per iteration, and a crash between two must not leave one handled and
        // unrecorded. The disconnect side records a row per account the same way.
        await auditMutation(db, ctx, {
          action: "instance.connect",
          target: `chatwoot_instance:${existing.id}`,
          after: { id: String(existing.id), accountId, accountName },
        });
        return { id: existing.id, reconnected: true, changed: true };
      }
      // Zero has two causes. Either the row is already connected (another request won, no
      // change is right), or `removeChatwootInstance` deleted it (it locks the instance while this
      // holds the deployment, so nothing serializes them). Reading zero as the first would return a
      // dead id and have `setConnectedAccounts` sync and report it. Ask again: still there is
      // idempotent success, gone means the create below is what the caller asked for.
      const stillThere = await db.chatwootInstance.findUnique({
        where: { id: existing.id },
        select: { id: true },
      });
      if (stillThere) {
        return { id: existing.id, reconnected: false, changed: false };
      }
    }
    try {
      const row = await db.chatwootInstance.create({
        data: { tenantId, deploymentId, accountId, accountName, serverKey },
        select: { id: true },
      });
      await auditMutation(db, ctx, {
        action: "instance.connect",
        target: `chatwoot_instance:${row.id}`,
        after: { id: String(row.id), accountId, accountName },
      });
      return { id: row.id, reconnected: false, changed: true };
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
  // NOTE: after the commit, never inside: the receiver caches refusals for a disconnected instance by
  // route token, and clearing before `disconnectedAt` commits lets an event re-cache the refusal.
  if (result.reconnected) invalidateRouteTokenCache();
  // NOTE: arm the stranded-delivery sweep here too, not only at boot: a first-run install has no
  // tenants at boot, and connecting an account is when a tenant can first strand a delivery.
  // Idempotent and best-effort (the connection must not fail over it; the next boot arms it).
  try {
    await ensureDeliverySweep(tenantId, base);
  } catch (err) {
    logger.warn(
      { tenantId: String(tenantId), err },
      "delivery sweep arm failed on Chatwoot connect; continuing",
    );
  }
  return { id: result.id, changed: result.changed };
}

function accountTakenError(): ConflictError {
  return new ConflictError(
    "this Chatwoot account is already connected to another tenant; one account belongs to a single tenant",
    "errors.chatwootAccountTaken",
  );
}

// Cross-tenant guard (superuser read bypasses RLS): rejects claiming a (serverKey, accountId) that a
// different tenant owns; the same tenant reconnecting its own account is excluded by tenantId. It
// takes the whole set (one privileged transaction per element over an uncapped array would be
// wasteful) but queries in chunks: each id is a bind parameter and Postgres caps them at 32767, so
// one `IN` crashes on input the published schema accepts. Chunking grows the query count, not its
// width. A realistic call is one chunk.
const CLAIM_CHECK_CHUNK = 1000;

async function assertAccountsNotTakenByAnotherTenant(
  base: PrismaClient,
  tenantId: bigint,
  serverKey: string,
  accountIds: number[],
): Promise<void> {
  if (accountIds.length === 0) return;
  // The chunks share ONE transaction. Chunking to dodge the parameter ceiling would otherwise
  // hand back the per-element privileged transaction this function was written to remove, just
  // divided by a thousand.
  const taken = await asSuperAdminOn(base, async (db) => {
    for (let i = 0; i < accountIds.length; i += CLAIM_CHECK_CHUNK) {
      const hit = await db.chatwootInstance.findFirst({
        where: {
          serverKey,
          accountId: { in: accountIds.slice(i, i + CLAIM_CHECK_CHUNK) },
          tenantId: { not: tenantId },
        },
        select: { id: true },
      });
      if (hit) return hit;
    }
    return null;
  });
  if (taken) throw accountTakenError();
}

// What `setConnectedAccounts` decides before it writes or calls anything: the tenant has a
// deployment, and every account it was handed is claimable (not owned by another tenant). Split out
// so the MCP preview asks the same question the apply asks; both halves, because a preflight that
// covers part of its core's judgement reads exactly like one that covers all of it.
export async function assertAccountsClaimable(
  ctx: TenantContext,
  accountIds: number[],
  base: PrismaClient = basePrisma,
): Promise<{ id: bigint; baseUrl: string }> {
  const dep = await assertDeploymentConnected(ctx, base);
  const tenantId = ctx.tenantId;
  if (tenantId === null) throw new AppError("tenant required", 400);
  const serverKey = normalizeChatwootBaseUrl(dep.baseUrl);
  await assertAccountsNotTakenByAnotherTenant(base, tenantId, serverKey, [
    ...new Set(accountIds),
  ]);
  return dep;
}

// The tenant's connected deployment, or the refusal every account operation owes its caller.
export async function assertDeploymentConnected(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<{ id: bigint; baseUrl: string }> {
  const dep = await runScopedOn(base, ctx, (db) =>
    db.chatwootDeployment.findFirst({ select: { id: true, baseUrl: true } }),
  );
  if (!dep) {
    throw new NotFoundError(
      "no chatwoot deployment connected",
      "errors.chatwootDeploymentNotFound",
    );
  }
  return dep;
}

// The bound on `account_ids` is the deployment's own account list: each id not yet active costs a
// row and two sequential HTTP calls, and an id outside `GET /api/v1/profile` is an account the token
// cannot operate (Chatwoot answers 401). `reported === null` is a failed probe and stays fail-open
// (an outage must not refuse ids the operator picked), capped by this number, which is not on the
// published schema so it stays a net rather than the contract.
const UNREPORTED_ACCOUNTS_FALLBACK_MAX = 500;

export function assertAccountsSelectable(
  wanted: number[],
  reported: number[] | null,
): void {
  if (reported === null) {
    if (wanted.length > UNREPORTED_ACCOUNTS_FALLBACK_MAX) {
      throw new AppError(
        `too many account_ids (${wanted.length}); this deployment's account list could not be read, so the request is capped at ${UNREPORTED_ACCOUNTS_FALLBACK_MAX}`,
        400,
        "errors.chatwootTooManyAccounts",
        {
          count: String(wanted.length),
          max: String(UNREPORTED_ACCOUNTS_FALLBACK_MAX),
        },
      );
    }
    return;
  }
  const known = new Set(reported);
  const unknown = wanted.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    // The first few, not all of them. The message is read by a person, and a caller that sent
    // forty thousand ids does not need forty thousand back to learn what went wrong.
    const shown = unknown.slice(0, 5).join(", ");
    const rest = unknown.length > 5 ? ` (and ${unknown.length - 5} more)` : "";
    throw new AppError(
      `this deployment does not report account(s) ${shown}${rest}`,
      400,
      "errors.chatwootAccountNotOnDeployment",
      { accounts: `${shown}${rest}` },
    );
  }
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
  const dep = await assertAccountsClaimable(ctx, wanted, base);
  const serverKey = normalizeChatwootBaseUrl(dep.baseUrl);
  // One probe, not one per account, and its answer is the bound as well as the source of
  // display names. A failure still falls through to null names, and `assertAccountsSelectable` reads
  // that same null as "no list available" and applies the fallback cap instead.
  let nameById = new Map<number, string>();
  let reported: number[] | null = null;
  try {
    const summaries = await listDeploymentAccounts(ctx, deps, base);
    nameById = new Map(summaries.map((s) => [s.id, s.name]));
    reported = summaries.map((s) => s.id);
  } catch {
    // probe failed — proceed with null names (the operator picked these ids deliberately)
  }
  assertAccountsSelectable(wanted, reported);
  const current = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findMany({
      select: { id: true, accountId: true, disconnectedAt: true },
    }),
  );
  const activeIds = new Set(
    current.filter((c) => c.disconnectedAt === null).map((c) => c.accountId),
  );
  // Whether this invocation is the one that moved the set. Each write below decides it for itself,
  // because the snapshot above cannot: two identical requests read the same `activeIds`, and only
  // one of them gets to change a row.
  let moved = false;
  // Disconnect active accounts the operator removed from the selection.
  for (const c of current) {
    if (c.disconnectedAt === null && !wanted.includes(c.accountId)) {
      if (await softDisconnectChatwootInstance(ctx, c.id, base, deps))
        moved = true;
    }
  }
  // Connect (create/reactivate) the newly-selected accounts + best-effort inbox sync.
  for (const accountId of wanted) {
    if (activeIds.has(accountId)) continue; // already active — nothing to do
    const { id, changed } = await connectAccount(
      ctx,
      dep.id,
      accountId,
      nameById.get(accountId) ?? null,
      serverKey,
      base,
    );
    if (changed) moved = true;
    try {
      await syncInboxes(ctx, id, deps, base);
    } catch {
      // best-effort: inboxes can be synced manually later
    }
  }
  const instances = await listChatwootInstances(ctx, base);
  // NOTE: the choice as one row, on top of the per-account rows (they are different facts), and only
  // when the set moved, decided by the writes, not the snapshot: a re-submitted form skips both
  // loops, and of two overlapping copies only the one whose conditional write matched changed
  // anything.
  if (moved) {
    // NOTE: best-effort, the only row in this family that is: the writes it summarizes are N
    // transactions by design, and the selection has already been applied, so failing the request
    // would report a change as a failure. The per-account rows are the durable record.
    try {
      await runScopedOn(base, ctx, (db) =>
        auditMutation(db, ctx, {
          action: "deployment.set_accounts",
          target: `chatwoot_deployment:${dep.id}`,
          after: {
            accountIds: wanted,
            connected: instances.filter((a) => a.disconnectedAt === null)
              .length,
          },
        }),
      );
    } catch (err) {
      logger.error(
        { err, tenantId: String(ctx.tenantId), deploymentId: String(dep.id) },
        "chatwoot: the account selection was applied and its audit row was not",
      );
    }
  }
  return instances;
}

// Soft-disconnect an account: unbind every agent from its inboxes (detaching the persona bots in
// Chatwoot so it STOPS delivering events to our webhook) and stamp disconnectedAt. The rows are KEPT
// so history and the dashboard stay intact; the webhook/runtime then ignore the account. Best-effort
// on the Chatwoot side: an unreachable deployment still gets the local unbind and stamp. Returns
// whether THIS call stamped it (a retry or the loser of two overlapping requests gets `false`).
export async function softDisconnectChatwootInstance(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
  deps: LoadChatwootClientDeps = {},
): Promise<boolean> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const inst = await runScopedOn(base, ctx, (db) =>
    db.chatwootInstance.findUnique({
      where: { id },
      select: { id: true, accountId: true, disconnectedAt: true },
    }),
  );
  if (!inst) {
    throw new NotFoundError(
      "chatwoot instance not found",
      "errors.chatwootInstanceNotFound",
    );
  }
  // One transaction for the three local writes (clear bindings, stamp, audit row), so a
  // failure cannot leave inboxes bound to nobody on an account still marked active.
  const { stamped, detach } = await runScopedOn(base, ctx, async (db) => {
    // NOTE: the account row first, before any inbox: `syncInboxes` takes the same lock then upserts
    // inboxes, and the other order is an ABBA deadlock. NO KEY UPDATE, not FOR UPDATE (module-wide):
    // an INSERT whose foreign key points here takes KEY SHARE, which FOR UPDATE conflicts with, so
    // the webhook mirror inserting a conversation would deadlock with this. NO KEY UPDATE still
    // excludes itself and ordinary UPDATEs, all the serialization needed.
    await db.$queryRaw`SELECT id FROM chatwoot_instances WHERE id = ${id} FOR NO KEY UPDATE`;
    // `RETURNING`, so the bindings removed are the same set the detach walks, and the count is
    // that set. Listed first and cleared after, a bind in between would leave an inbox unbound here
    // with its bot still attached in Chatwoot. `agent_id IS NOT NULL` makes the write its own filter.
    const unbound = await db.$queryRaw<{ chatwoot_inbox_id: number }[]>`
      UPDATE inboxes
         SET agent_id = NULL, updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND chatwoot_instance_id = ${id}
         AND agent_id IS NOT NULL
      RETURNING chatwoot_inbox_id`;
    // The stamp and row only where the account was still active, decided by the write: a retry
    // would otherwise move the stamp, and two overlapping requests both read `null`.
    const { count } = await db.chatwootInstance.updateMany({
      where: { id, disconnectedAt: null },
      data: { disconnectedAt: new Date() },
    });
    // NOTE: or the unbind, since clearing a binding is a mutation either way: a bind passing its
    // check while the disconnect commits leaves an inbox bound on a disconnected account, and the
    // retry that clears it must still leave a row. `stamped: false` says it completed a disconnect.
    if (count > 0 || unbound.length > 0) {
      await auditMutation(db, ctx, {
        action: "instance.disconnect",
        target: `chatwoot_instance:${id}`,
        before: {
          id: String(inst.id),
          accountId: inst.accountId,
          unboundInboxes: unbound.length,
          stamped: count > 0,
        },
      });
    }
    return {
      stamped: count > 0,
      detach: unbound.map((r) => r.chatwoot_inbox_id),
    };
  });
  // NOTE: the receiver caches "this route token resolves to a live bot". Invalidated once the
  // disconnect is durable and before the network work, which can take a whole timeout while warm
  // entries keep queueing webhooks for a disconnected account.
  invalidateRouteTokenCache();
  // NOTE: Chatwoot after our commit: detaching first and then rolling back would leave the account
  // active here while Chatwoot stopped delivering. This way a failed transaction changes nothing and
  // a failed detach is the accepted outcome (disconnected locally, stray events ignored).
  if (detach.length > 0) {
    let client: ChatwootClient | null = null;
    try {
      client = await loadChatwootClient(tenantId, id, {
        base,
        makeClient: deps.makeClient,
      });
    } catch {
      client = null; // Chatwoot unreachable / creds gone — the local disconnect already stands.
    }
    if (client) {
      for (const inboxId of detach) {
        // Re-asked before each call, outside any lock: one unreachable inbox holds the loop for
        // a timeout, in which an operator can reconnect and bind, and pulling that bot would leave
        // an inbox bound here with no bot upstream, which nothing repairs. The binding is the
        // question, not the disconnected flag: the column saying a bot is there authorizes pulling
        // it, and `bindInbox` refuses on a disconnected account, so the flag would add nothing. It
        // narrows the window, not closes it: we never issue a detach our committed state no longer
        // authorizes.
        const authorized = await runScopedOn(base, ctx, (db) =>
          db.inbox.count({
            where: {
              chatwootInstanceId: id,
              chatwootInboxId: inboxId,
              agentId: null,
            },
          }),
        );
        if (authorized === 0) continue;
        try {
          await client.setInboxAgentBot(inboxId, null);
        } catch {
          // best-effort: a per-inbox failure must not block detaching the rest
        }
      }
    }
  }
  return stamped;
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
      select: { id: true, disconnectedAt: true },
    });
    if (!inst) {
      throw new NotFoundError(
        "chatwoot instance not found",
        "errors.chatwootInstanceNotFound",
      );
    }
    // The account already belongs to the tenant's single deployment, so reconnecting just
    // clears the flag. Conditional, and the condition is the test: two overlapping reconnects both
    // read a non-null flag, and a check before the write would let both record a reconnection.
    const { count: cleared } = await db.chatwootInstance.updateMany({
      where: { id, disconnectedAt: { not: null } },
      data: { disconnectedAt: null },
    });
    const row = await db.chatwootInstance.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    const reconnected = toDto(row);
    // NOTE: no MCP twin, so this name is the action's only door to the trail. Only when the account
    // was disconnected: a retry on an active account changes nothing and a row would be a fake event.
    if (cleared > 0) {
      await auditMutation(db, ctx, {
        action: "instance.reconnect",
        target: `chatwoot_instance:${id}`,
        after: {
          id: reconnected.id,
          accountId: reconnected.accountId,
          disconnectedAt: null,
        },
      });
    }
    return reconnected;
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
    // NOTE: LOCKED before the count, because the count is about what the delete below is going to
    // destroy. A sync holding this same lock is mirroring inboxes under the account right now; read
    // without it, the snapshot is taken before that transaction commits and the cascade then takes
    // rows the row never mentioned.
    await db.$queryRaw`SELECT id FROM chatwoot_instances WHERE id = ${id} FOR NO KEY UPDATE`;
    const inst = await db.chatwootInstance.findUnique({
      where: { id },
      select: { id: true, accountId: true, accountName: true },
    });
    if (!inst) {
      throw new NotFoundError(
        "chatwoot instance not found",
        "errors.chatwootInstanceNotFound",
      );
    }
    // NOTE: BEFORE the delete, and counted: the cascade takes this account's inboxes and agent bots with
    // it, so afterwards there is nothing left to describe. No MCP twin either, so this name is the
    // only record the action has ever had.
    await auditMutation(db, ctx, {
      action: "instance.remove",
      target: `chatwoot_instance:${id}`,
      before: {
        id: String(inst.id),
        accountId: inst.accountId,
        accountName: inst.accountName,
        inboxes: await db.inbox.count({ where: { chatwootInstanceId: id } }),
      },
    });
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
  // The agents watching this inbox: bound as observers on the fork, they receive every event and
  // answer nothing. Independent of `agentId`, the one responder.
  observerAgentIds: string[];
}

const INBOX_SELECT = {
  id: true,
  chatwootInstanceId: true,
  chatwootInboxId: true,
  name: true,
  channelType: true,
  provider: true,
  agentId: true,
  observers: {
    // NOTE: the stamp travels with the id. The DTO ignores it (a pending row is an observer wherever
    // the answer gates a refusal); the audit line, which describes the state before this call, must
    // not count the pending row this same call just wrote.
    select: { agentId: true, attachedAt: true },
    orderBy: { id: "asc" as const },
  },
} as const;

// The observers Chatwoot has actually agreed to, for the one reading that cannot count an intent.
function confirmedObserverIds(row: {
  observers: { agentId: bigint; attachedAt: Date | null }[];
}): string[] {
  return row.observers
    .filter((o) => o.attachedAt !== null)
    .map((o) => String(o.agentId));
}

function toInboxDto(r: {
  id: bigint;
  chatwootInstanceId: bigint;
  chatwootInboxId: number;
  name: string;
  channelType: string | null;
  provider: string | null;
  agentId: bigint | null;
  observers: { agentId: bigint }[];
}): InboxDto {
  return {
    id: String(r.id),
    chatwootInstanceId: String(r.chatwootInstanceId),
    chatwootInboxId: r.chatwootInboxId,
    observerAgentIds: r.observers.map((o) => String(o.agentId)),
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

// The agent's bound inboxes on which Chatwoot sends its own out-of-hours reply, read live, for one
// editor warning (the customer can be told "closed" by one product and served by the other). Live,
// not a column on Inbox: a mirrored flag refreshed only on sync would keep warning long after the
// reply was switched off, and a warning that outlives its subject gets the whole panel ignored. An
// unreadable instance contributes nothing (an outage is no evidence of misconfiguration), but is
// counted, so a caller reporting its own coverage can name the account it never heard from;
// `listOutOfOfficeInboxes` below is the projection for everyone who does not care.
export async function readOutOfOfficeInboxes(
  ctx: TenantContext,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ inboxes: { id: string; name: string }[]; unreadable: number }> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const bound = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { agentId },
      orderBy: { id: "asc" },
      select: { id: true, chatwootInstanceId: true, chatwootInboxId: true },
    }),
  );

  // One list call per distinct account (GET /inboxes is account-wide), run concurrently:
  // every request carries a 15s abort, so sequential reads let one unreachable server delay the
  // editor load. Unbounded on purpose: the fan-out is the few accounts the operator connected.
  const perInstance = await Promise.all(
    [...new Set(bound.map((b) => b.chatwootInstanceId))].map(
      async (instanceId) => {
        try {
          const client = await loadChatwootClient(tenantId, instanceId, {
            base,
            makeClient: deps.makeClient,
          });
          const listed = readInboxStates(await client.listInboxes());
          const armed = new Map<number, string>();
          for (const remote of listed.inboxes) {
            if (chatwootAutoRepliesOutOfHours(remote)) {
              armed.set(remote.chatwootInboxId, remote.name);
            }
          }
          return [instanceId, { armed, decided: listed.decided }] as const;
        } catch {
          // unreachable / unauthorized — say nothing about this account's inboxes, and do not let it
          // decide the answer for the others. Counted rather than merely dropped: see the header.
          return null;
        }
      },
    ),
  );
  const byInstance = new Map(perInstance.filter((entry) => entry !== null));

  // Chatwoot's name, not the mirror's (the mirror may be stale). Coverage is counted per bound
  // inbox: one whose account, entry or out-of-hours fields could not be read is one this call cannot
  // vouch for, while every inbox beside it is still reported.
  const inboxes: { id: string; name: string }[] = [];
  let unreadable = 0;
  for (const row of bound) {
    const account = byInstance.get(row.chatwootInstanceId);
    if (!account?.decided?.has(row.chatwootInboxId)) {
      unreadable += 1;
      continue;
    }
    const name = account.armed.get(row.chatwootInboxId);
    if (name !== undefined) inboxes.push({ id: String(row.id), name });
  }
  return { inboxes, unreadable };
}

// The same reading for a caller that has nowhere to put the failure count: the editor's panel, whose
// rule is that an unreachable Chatwoot reports no inboxes rather than a warning it cannot act on.
export async function listOutOfOfficeInboxes(
  ctx: TenantContext,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<{ id: string; name: string }[]> {
  return (await readOutOfOfficeInboxes(ctx, agentId, deps, base)).inboxes;
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

// Live reconcile for the Channels UI: for each BOUND inbox and each OBSERVER binding, is that
// persona's Chatwoot Agent Bot still alive? Read-only (no re-provision; that's the explicit
// Reconnect action, or observing again). Best-effort per instance: an unreachable Chatwoot OMITS
// that instance's inboxes, so the client shows "unverified" rather than a false "removed". A binding
// whose persona has no bot row (shouldn't happen) is reported "missing" → reconnect repairs it.
export type InboxBotStatuses = {
  // inboxId → the responder persona's bot.
  inboxes: Record<string, InboxBotStatus>;
  // `${inboxId}:${agentId}` → that observer's bot. Keyed by the pair because an observer binding is
  // one, and an agent can observe several inboxes.
  observers: Record<string, InboxBotStatus>;
};

export async function reconcileInboxBots(
  ctx: TenantContext,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<InboxBotStatuses> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const inboxes = await runScopedOn(base, ctx, (db) =>
    db.inbox.findMany({
      where: { OR: [{ agentId: { not: null } }, { observers: { some: {} } }] },
      select: {
        id: true,
        chatwootInstanceId: true,
        agentId: true,
        // NOTE: the stamp as well: this is where an operator learns a binding is not what the
        // console shows, and a pending row answers the bot question wrongly (see below).
        observers: { select: { agentId: true, attachedAt: true } },
      },
    }),
  );
  if (inboxes.length === 0) return { inboxes: {}, observers: {} };
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
  const observerResult: Record<string, InboxBotStatus> = {};
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
      if (ib.agentId != null) {
        const botId = botByKey.get(`${instanceId}:${ib.agentId}`);
        result[String(ib.id)] =
          botId != null && liveIds.has(botId) ? "active" : "missing";
      }
      // NOTE: the observer's half of the same question: its bot deleted out of band is the same
      // outage as the responder's. Observing again is its Reconnect (idempotent attach, and
      // `ensureAgentBot` re-provisions). A row Chatwoot never confirmed is not an active binding:
      // the bot may exist for another inbox of the persona, so it is reported `missing`, which offers
      // Reconnect, right for both pending shapes (attach never ran, or ran and was never stamped).
      for (const o of ib.observers) {
        const botId = botByKey.get(`${instanceId}:${o.agentId}`);
        observerResult[`${ib.id}:${o.agentId}`] =
          o.attachedAt !== null && botId != null && liveIds.has(botId)
            ? "active"
            : "missing";
      }
    }
  }
  return { inboxes: result, observers: observerResult };
}

// `ensureAgentBot` plus the repair that travels with it. The bot row is one per (instance, agent),
// shared by every inbox the persona answers or watches, so a replacement after an out-of-band delete
// must re-attach all of them, or `reconcileInboxBots` (which asks only whether the bot exists) shows
// them `active` while Chatwoot delivers nothing. Here for every caller (bind, reconnect, observe).
// Re-attaches when the id changed, and always for `reconnectInbox`, so a second click repairs a
// failure of the first. Per inbox, best-effort, at `error`; each binding is re-read right before its
// call so an unbind in between is not undone. Details: docs/chatwoot.md, "Observer binding".
async function ensureAgentBotAndReattach(
  ctx: TenantContext,
  instanceId: bigint,
  agentId: bigint,
  agentName: string,
  client: ChatwootClient,
  // `skipInboxId` is the inbox the CALLER attaches itself, immediately after this returns.
  // `always` re-asserts every other attachment even when the bot was not replaced: the repair path.
  opts: { skipInboxId?: bigint; always?: boolean; base?: PrismaClient } = {},
): Promise<EnsuredAgentBot> {
  const base = opts.base ?? basePrisma;
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const before = await runScopedOn(base, ctx, (db) =>
    db.chatwootAgentBot.findUnique({
      where: {
        tenantId_chatwootInstanceId_agentId: {
          tenantId,
          chatwootInstanceId: instanceId,
          agentId,
        },
      },
      select: { chatwootAgentBotId: true },
    }),
  );
  const bot = await ensureAgentBot(
    tenantId,
    instanceId,
    agentId,
    agentName,
    client,
    { base },
  );
  const replaced =
    before !== null && before.chatwootAgentBotId !== bot.chatwootAgentBotId;
  if (!replaced && opts.always !== true) return bot;
  const [observed, answered] = await runScopedOn(base, ctx, async (db) => [
    await db.inboxObserver.findMany({
      where: {
        tenantId,
        agentId,
        ...(opts.skipInboxId === undefined
          ? {}
          : { inboxId: { not: opts.skipInboxId } }),
        inbox: { chatwootInstanceId: instanceId },
        // NOTE: confirmed bindings only. A pending row is an unfinished observe: attaching it here
        // leaves a bot whose row says "attaching" forever, and stamping it here survives its
        // compensation and detach. Skipped, both sides agree, and observing again repairs it.
        attachedAt: { not: null },
      },
      select: { inboxId: true, inbox: { select: { chatwootInboxId: true } } },
      // NOTE: a stable order: nothing depends on which order, but "what changed between two steps
      // of this loop" is only a reproducible question if there is one.
      orderBy: { inboxId: "asc" },
    }),
    await db.inbox.findMany({
      where: {
        agentId,
        chatwootInstanceId: instanceId,
        ...(opts.skipInboxId === undefined
          ? {}
          : { id: { not: opts.skipInboxId } }),
      },
      select: { id: true, chatwootInboxId: true },
      orderBy: { id: "asc" },
    }),
  ]);
  const reattach = [
    ...observed.map((o) => ({
      inboxId: o.inboxId,
      chatwootInboxId: o.inbox.chatwootInboxId,
      as: "observer" as const,
    })),
    ...answered.map((i) => ({
      inboxId: i.id,
      chatwootInboxId: i.chatwootInboxId,
      as: "responder" as const,
    })),
  ];
  for (const other of reattach) {
    try {
      // Confirmed here too and in the recheck below: an observer can be unobserved and a new
      // observe insert its unstamped row after the snapshot, and attaching for that observe would
      // leave something its own compensation cannot detach.
      const stands = await runScopedOn(base, ctx, async (db) =>
        other.as === "observer"
          ? (await db.inboxObserver.count({
              where: {
                tenantId,
                agentId,
                inboxId: other.inboxId,
                attachedAt: { not: null },
              },
            })) > 0
          : (await db.inbox.count({
              where: { id: other.inboxId, agentId },
            })) > 0,
      );
      if (!stands) continue;
      if (other.as === "observer") {
        await client.addInboxObserver(
          other.chatwootInboxId,
          bot.chatwootAgentBotId,
        );
      } else {
        await client.setInboxAgentBot(
          other.chatwootInboxId,
          bot.chatwootAgentBotId,
        );
      }
      // And the binding is asked again afterwards: a rebind to another agent calls Chatwoot
      // before it commits, so this attach can put the old persona back upstream while the database
      // commits the new one (the console shows active, the wrong agent answers). Not closable here
      // (the writers share no ordering); the second read turns that silence into a line naming the
      // inbox, and binding or observing again repairs it.
      const stillStands = await runScopedOn(base, ctx, async (db) =>
        other.as === "observer"
          ? (await db.inboxObserver.count({
              where: {
                tenantId,
                agentId,
                inboxId: other.inboxId,
                attachedAt: { not: null },
              },
            })) > 0
          : (await db.inbox.count({
              where: { id: other.inboxId, agentId },
            })) > 0,
      ).catch(() => true);
      if (!stillStands) {
        logger.error(
          {
            agentId: String(agentId),
            chatwootInboxId: other.chatwootInboxId,
            as: other.as,
          },
          "chatwoot: this persona's bot was reattached to an inbox whose binding moved while the call was in flight; Chatwoot may now route it to a persona the database no longer names — binding or observing it again repairs it",
        );
      }
    } catch (err) {
      logger.error(
        {
          err,
          agentId: String(agentId),
          chatwootInboxId: other.chatwootInboxId,
          as: other.as,
        },
        "chatwoot: an inbox this persona is on is not attached to its bot and could not be reattached; Chatwoot delivers it nothing while the console still reports it active — binding or observing it again repairs it",
      );
    }
  }
  return bot;
}

// Everything `reconnectInbox` decides before it calls Chatwoot: the inbox exists, it is bound, and
// the agent it names is still there. Split out so the MCP preview can ask the same question the
// apply asks without performing the reconnection.
export async function assertInboxReconnectable(
  ctx: TenantContext,
  inboxId: bigint,
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, ctx, async (db) => {
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
  });
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
  const { inbox, agentId, agentName } = await assertInboxReconnectable(
    ctx,
    inboxId,
    base,
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
    const bot = await ensureAgentBotAndReattach(
      ctx,
      inbox.chatwootInstanceId,
      agentId,
      agentName,
      client,
      // The repair path: it re-asserts every attachment of this persona whether or not the bot
      // needed replacing, so it is also what repairs a reattachment an earlier one could not make.
      { skipInboxId: inboxId, always: true, base },
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
    const dto = toInboxDto(row);
    // NOTE: the local binding did not move (Chatwoot is re-pointed at the bot the inbox names), so
    // no `before`. The agent is the one this call acted on, captured before the round trip, not a
    // re-read: a bind landing meanwhile would file the repair under the wrong agent.
    await auditMutation(db, ctx, {
      action: "inbox.reconnect",
      target: `inbox:${inboxId}`,
      after: { id: dto.id, agentId: String(agentId) },
    });
    return dto;
  });
}

export interface AgentTeamDto {
  id: number;
  name: string;
}

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

// The Chatwoot instances an agent's inboxes live on, plus how many distinct ACCOUNTS they
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
  // the union mixes accounts and the editor offers free-text entry with a warning, like the handoff
  // targeting picker.
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

// Custom-attribute DEFINITIONS available to an agent's inbox(es), for the attribute-context
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

// An unbind asks Chatwoot for one state: no agent bot on this inbox. A 404 from set_agent_bot means
// the inbox (or account) is not there to carry one, which already is that state, so the local
// binding may clear (a deleted inbox answers 404, a lost credential 401). Every other failure keeps
// the fence: a bot may still be connected and delivering that inbox's events.
export function unbindNeedsNothingRemote(err: unknown): boolean {
  return err instanceof ChatwootApiError && err.status === 404;
}

// Everything `bindInbox` decides before it touches Chatwoot: the inbox exists, its account is still
// connected, and the agent being bound exists. Split out so the MCP preview refuses what the apply
// refuses (a bind onto a disconnected account included).
export async function assertInboxBindable(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint | null,
  base: PrismaClient = basePrisma,
) {
  return runScopedOn(base, ctx, async (db) => {
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
        select: { name: true, settings: true, enabled: true, mode: true },
      });
      if (!agent) {
        throw new NotFoundError("agent not found", "errors.agentNotFound");
      }
      // A monitoring agent may be the responder (bound, reading, answering nothing, the
      // conversations starting `pending` for the team). The observer binding is for an inbox
      // somebody else answers. One agent cannot be both on one inbox: the fork delivers once, as the
      // responder, and the receiver would read the route as an observer's.
      const observing = await db.inboxObserver.findFirst({
        where: { inboxId, agentId },
        select: { id: true },
      });
      if (observing) {
        throw new AppError(
          "this agent already observes this inbox",
          422,
          "errors.agentAlreadyObserves",
        );
      }
      name = agent.name;
    }
    return { inbox: row, agentName: name };
  });
}

// The load-bearing binding: which agent answers an inbox. This is the SINGLE operator action that
// wires an inbox end-to-end; there is no separate "provision the bot" step. The bot is per-persona:
//   - bind / switch (→ agent): lazily ensure THAT persona's Agent Bot exists, connect it to this
//     inbox on Chatwoot (set_agent_bot replaces any prior bot on the inbox), then store agentId.
//   - unbind (agent → none): DISCONNECT the bot from this inbox, then clear agentId.
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
  const { inbox, agentName } = await assertInboxBindable(
    ctx,
    inboxId,
    agentId,
    base,
  );

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
      const bot = await ensureAgentBotAndReattach(
        ctx,
        inbox.chatwootInstanceId,
        agentId,
        agentName,
        client,
        { skipInboxId: inboxId, base },
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
  // NOTE: Chatwoot is already attached and this can still fail, leaving the bot upstream while our
  // row names the previous agent. Reported, not compensated: a compensating detach is another remote
  // call with its own failure, and a retry repairs it completely (step 2 sees the binding unchanged,
  // calls Chatwoot again idempotently, and commits). The disconnect orders its remote call the other
  // way because there the retry is a no-op.
  let persisted: { dto: InboxDto; retiredObserverBotId: number | null };
  try {
    persisted = await persistBinding();
  } catch (err) {
    // A failure (audit insert, lock) is a retry away; a refusal decided inside the transaction
    // (account disconnected, agent deleted under us) refuses again. Both leave the bot attached
    // upstream, so both are logged, and only one may say "retry".
    const refused = err instanceof AppError;
    const line = {
      err,
      tenantId: String(tenantId),
      inboxId: String(inboxId),
      agentId: agentId === null ? null : String(agentId),
    };
    if (refused) {
      logger.warn(
        line,
        "chatwoot: the bot was attached in Chatwoot and the write refused the binding; a retry refuses the same way",
      );
    } else {
      logger.error(
        line,
        "chatwoot: the bot was attached in Chatwoot and the binding was not saved — retry the bind",
      );
    }
    throw err;
  }
  // NOTE: the observer attachment the race left on the fork is redundant until this agent is
  // unbound, when it would resume as an observer nothing names. Detached after the commit,
  // best-effort, outside every lock; a failure is what `unobserveInbox` repairs.
  if (persisted.retiredObserverBotId !== null) {
    try {
      // Re-read the binding first: post-commit and unlocked, the retired pair can be observing
      // again by now, and the DELETE would remove a valid attachment (bot-status says active, nothing
      // is delivered). A failed read keeps the attachment. `agentId` is non-null wherever a row was
      // retired, but the signature allows null, so it is narrowed.
      const stands =
        agentId === null
          ? 0
          : await runScopedOn(base, ctx, (db) =>
              db.inboxObserver.count({ where: { inboxId, agentId } }),
            ).catch(() => 1);
      if (stands > 0) return persisted.dto;
      const client = await loadChatwootClient(
        tenantId,
        inbox.chatwootInstanceId,
        { base, makeClient: deps.makeClient },
      );
      await client.removeInboxObserver(
        inbox.chatwootInboxId,
        persisted.retiredObserverBotId,
      );
    } catch (err) {
      if (!unbindNeedsNothingRemote(err)) {
        logger.warn(
          { err, inboxId: String(inboxId), agentId: String(agentId) },
          "chatwoot: the observer attachment the responder binding retired could not be detached — an unobserve repairs it",
        );
      }
    }
  }
  return persisted.dto;

  function persistBinding(): Promise<{
    dto: InboxDto;
    retiredObserverBotId: number | null;
  }> {
    return runScopedOn(base, ctx, async (db) => {
      let retiredObserverBotId: number | null = null;
      // The account row first, re-asking the top read's question, since a disconnect fits in
      // the Chatwoot-call window: it would unbind the inboxes bound then, this would commit
      // `agentId` after, and its detach would pull our new bot, leaving an unrepairable binding.
      // Module order (account, then inbox), so no deadlock with `syncInboxes` or the disconnect.
      const account = await db.$queryRaw<{ disconnected_at: Date | null }[]>`
      SELECT i.disconnected_at
        FROM chatwoot_instances i
       WHERE i.id = ${inbox.chatwootInstanceId}
         FOR NO KEY UPDATE`;
      if (agentId !== null && account[0]?.disconnected_at != null) {
        throw new AppError(
          "this account is disconnected; reconnect it before assigning an agent",
          409,
          "errors.chatwootAccountDisconnected",
        );
      }
      // NOTE: the agent next, locked as a foreign key would (`Inbox.agentId` has no `@relation`), so
      // a `deleteAgent` in the Chatwoot-call window cannot leave a binding to a gone agent. `FOR KEY
      // SHARE` conflicts only with `FOR UPDATE`, so binds do not serialize against each other or an
      // ordinary agent save (those take `FOR NO KEY UPDATE`, since a bind waiting here holds the
      // account row); only deletion conflicts. Before the inbox row: `deleteAgent` takes the agent and
      // then its inboxes, and the other order deadlocks (40P01) on a re-bind. Same order as
      // `updateExperiment`. An unbind references no agent and takes nothing.
      if (agentId !== null) {
        const alive = await db.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
        FROM agents
       WHERE id = ${agentId}
         FOR KEY SHARE`;
        if (alive.length === 0) {
          throw new NotFoundError("agent not found", "errors.agentNotFound");
        }
      }
      // Read inside the transaction with the row locked, because the audit compares against
      // it: an unlocked read would let two overlapping binds both claim to start from null.
      const locked = await db.$queryRaw<{ agent_id: bigint | null }[]>`
      SELECT agent_id
        FROM inboxes
       WHERE id = ${inboxId}
         FOR NO KEY UPDATE`;
      const beforeWrite = locked[0] ?? null;
      // NOTE: the two bindings are exclusive per (inbox, agent), and an observe of this agent can
      // pass its check in the Chatwoot-call window. The responder wins (the fork delivers once, as the
      // responder), so an observer row is retired here, under the lock, and recorded as a detach.
      // `observeInbox` decides the same race the same way.
      if (agentId !== null) {
        const pre = await db.inbox.findUniqueOrThrow({
          where: { id: inboxId },
          select: INBOX_SELECT,
        });
        const retired = await db.inboxObserver.deleteMany({
          where: { inboxId, agentId },
        });
        if (retired.count > 0) {
          const was = toInboxDto(pre).observerAgentIds;
          await auditMutation(db, ctx, {
            action: "inbox.unobserve",
            target: `inbox:${inboxId}`,
            before: { observerAgentIds: was },
            after: {
              observerAgentIds: was.filter((id) => id !== String(agentId)),
            },
          });
          const bot = await db.chatwootAgentBot.findUnique({
            where: {
              tenantId_chatwootInstanceId_agentId: {
                tenantId,
                chatwootInstanceId: inbox.chatwootInstanceId,
                agentId,
              },
            },
            select: { chatwootAgentBotId: true },
          });
          retiredObserverBotId = bot?.chatwootAgentBotId ?? null;
        }
      }
      // Stamped only when the binding moves: an observer stands down for the responder's own
      // delivery by asking how old the binding is, so re-stamping on a no-op re-submit would age it
      // forward. An unbind clears it, so the next bind starts its own clock.
      const boundTo = beforeWrite?.agent_id ?? null;
      // NOTE: who routes this inbox moved, and the counter is a database trigger, not stepped here:
      // an application counter is only as good as its list of writers, which misses the previous
      // release during a rolling deploy. The trigger counts both movements here (`agent_id`, the
      // retired observer row); a no-op re-submit moves neither.
      await db.inbox.update({
        where: { id: inboxId },
        data: {
          agentId,
          ...(agentId === null
            ? { responderBoundAt: null }
            : boundTo === agentId
              ? {}
              : { responderBoundAt: new Date() }),
        },
      });
      const row = await db.inbox.findUniqueOrThrow({
        where: { id: inboxId },
        select: INBOX_SELECT,
      });
      const dto = toInboxDto(row);
      const wasBoundTo = boundTo;
      // NOTE: both sides, because an unbind is the same call with a null (the agent lost is known
      // only from the top read). Only when the binding moved, compared against that read.
      if (wasBoundTo !== agentId) {
        await auditMutation(db, ctx, {
          action: "inbox.bind",
          target: `inbox:${inboxId}`,
          before: { agentId: wasBoundTo === null ? null : String(wasBoundTo) },
          after: { agentId: dto.agentId },
        });
      }
      return { dto, retiredObserverBotId };
    });
  }
}

// Every refusal an observe makes before it touches Chatwoot, in one place, so the MCP preview says
// the same "no" the apply would (a preview approving an impossible operation is worse than none).
// Read-only and unlocked: the apply re-asks under its own locks what the race can change (the
// exclusivity, the account's connection, the agent's mode).
export async function readObserveTarget(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<{
  inbox: {
    id: bigint;
    chatwootInstanceId: bigint;
    chatwootInboxId: number;
    agentId: bigint | null;
  };
  agentName: string;
  alreadyObserving: boolean;
}> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  return runScopedOn(base, ctx, async (db) => {
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
    if (row.instance.disconnectedAt !== null) {
      throw new AppError(
        "this account is disconnected; reconnect it before assigning an agent",
        409,
        "errors.chatwootAccountDisconnected",
      );
    }
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { name: true, mode: true, settings: true, enabled: true },
    });
    if (!agent) {
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    if (row.agentId === agentId) {
      throw new AppError(
        "this agent answers this inbox; it cannot observe it too",
        422,
        "errors.agentIsResponder",
      );
    }
    // This agent's own row, never another watcher's: an inbox carries several, and reading theirs
    // as ours would skip this call's pending row and fail its stamp.
    const own = await db.inboxObserver.findFirst({
      where: { tenantId, inboxId, agentId },
      // NOTE: the stamp as well: the row is written ahead of the fork, so "a row exists" is not "a
      // call completed" (see `alreadyObserving` below).
      select: { attachedAt: true },
    });
    // NOTE: the mode is asked of a new observer only: a production agent can hold an observer row
    // from a promotion inside an attach window, and refusing here would 422 the Reconnect that
    // repairs it.
    if (!isMonitoring(agent.mode) && own === null) {
      throw new AppError(
        "only a monitoring agent can observe an inbox",
        422,
        "errors.observerNotMonitoring",
      );
    }
    return {
      inbox: row,
      agentName: agent.name,
      // NOTE: whether this agent already observed the inbox, so a rollback does not take back an
      // attachment this call did not create. A confirmed row only: reading an overlapping observe's
      // pending row as "already" would write no row and skip the detach, leaving an attachment
      // nothing names if the first call fails. As not-yet, its insert loses to the unique index.
      alreadyObserving: own !== null && own.attachedAt !== null,
    };
  });
}

// The one refusal a bind makes about the observer binding, exported so the MCP preview of
// `inbox_bind` does not approve a pair the apply refuses.
export async function assertBindTargetNotObserving(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    const observing = await db.inboxObserver.findFirst({
      where: { inboxId, agentId },
      select: { id: true },
    });
    if (observing) {
      throw new AppError(
        "this agent already observes this inbox",
        422,
        "errors.agentAlreadyObserves",
      );
    }
  });
}

// Taking back a pending observer row: a transaction of its own (all three call sites run after the
// main transaction, on a road out that is not a completed observe), and top-level so the lock-order
// fence in `audit-channel-family.test.ts` reads it as a separate path. Only ever the row the caller
// wrote, and only while unstamped: a concurrent observe that completed owns it by then.
async function dropPendingObserverRow(
  ctx: TenantContext,
  inboxId: bigint,
  // THE ROW, not the pair it names: see where it is written for what the pair stops identifying
  // once an unobserve and a second observe can both land inside the attach window.
  pendingRowId: bigint,
  agentId: bigint,
  base: PrismaClient,
): Promise<void> {
  try {
    await runScopedOn(base, ctx, async (db) => {
      // NOTE: the inbox first (the module's one lock order): the DELETE's AFTER DELETE trigger waits
      // on the inbox row, while `bindInbox` and `unobserveInbox` lock the inbox then delete the
      // observer row, so the other order is a 40P01 that would be swallowed below, leaving a pending
      // row while the compensation detaches upstream.
      await db.$queryRaw`SELECT id FROM inboxes WHERE id = ${inboxId} FOR NO KEY UPDATE`;
      await db.inboxObserver.deleteMany({
        where: { id: pendingRowId, attachedAt: null },
      });
    });
  } catch (err) {
    // A row left pending is read as an attach in flight: the receiver reports the attach window and
    // the observe tick retries rather than acting. Re-observing stamps it and unobserving removes
    // it, which is the repair every other leak in this path already has.
    logger.warn(
      { err, inboxId: String(inboxId), agentId: String(agentId) },
      "chatwoot: an observer row this call wrote could not be taken back; it stays pending until an observe or an unobserve settles it",
    );
  }
}

// The observer binding, next to the responder above. A monitoring agent's bot is attached to the
// inbox on the fork as an observer: it receives every event on its own route and owns nothing, so
// the inbox keeps starting conversations `open` for whoever answers it. Same shape as `bindInbox`:
// scoped reads, the network outside any transaction, the row persisted once Chatwoot agreed. Only a
// monitoring agent may observe, never the inbox's own responder (the fork delivers once, as the
// responder, and the receiver reads a route by `InboxObserver` first).
export async function observeInbox(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<InboxDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;

  const { inbox, agentName, alreadyObserving } = await readObserveTarget(
    ctx,
    inboxId,
    agentId,
    base,
  );

  // 2. Chatwoot, outside any transaction, as in `bindInbox`. The window between the fork's
  //    agreement and the stamp is covered by the receiver (`observerRuntimeForRoute` reads the
  //    route from what the delivery proves), and a lost answer is repaired by a retry (idempotent
  //    POST). The pending-row protocol: docs/chatwoot.md, "Observer binding".
  // NOTE: declared above `bindingStands`, which must be able to name this call's own row, the one
  // row its compensation must not count. Assigned where the row is written.
  let pendingRowId: bigint | null = null;
  // Whether anything committed still needs the attachment. Two first-time observes share one
  // idempotent attachment upstream, so the loser's compensation re-reads the rows now and skips the
  // detach when one stands (the start-of-call `alreadyObserving` is stale). It skips exactly one
  // row, by id: this call's own pending row. Another call's pending row is a dependency in the
  // making (it has already attached) and counts.
  const bindingStands = async (): Promise<boolean> => {
    try {
      return await runScopedOn(
        base,
        ctx,
        async (db) =>
          (await db.inboxObserver.count({
            where: {
              tenantId,
              inboxId,
              agentId,
              // NOTE: every row of this pair except this call's own while unstamped. A concurrent
              // call that completed did so by stamping this row (the unique is on the pair), so
              // excluding by id alone would miss the winner's commit; an unstamped row that is not
              // ours is another call in flight.
              ...(pendingRowId === null
                ? {}
                : { NOT: { id: pendingRowId, attachedAt: null } }),
            },
          })) > 0,
      );
    } catch (err) {
      // Unreadable: keep the attachment. Leaving one nothing names is what `unobserveInbox` repairs
      // on demand; pulling one a committed row depends on is a silent outage nothing repairs.
      logger.warn(
        { err, inboxId: String(inboxId), agentId: String(agentId) },
        "chatwoot: could not check whether an observer row still needs this attachment; leaving it in place",
      );
      return true;
    }
  };
  // Taking back the intent on every road out that is not a completed observe: only the row
  // this call wrote, only while unstamped (a concurrent observe that completed owns it by then).
  const dropPendingRow = async () => {
    if (pendingRowId === null) return;
    await dropPendingObserverRow(ctx, inboxId, pendingRowId, agentId, base);
  };
  let client: ChatwootClient | null = null;
  let botId: number | null = null;
  try {
    client = await loadChatwootClient(tenantId, inbox.chatwootInstanceId, {
      base,
      makeClient: deps.makeClient,
    });
    const bot = await ensureAgentBotAndReattach(
      ctx,
      inbox.chatwootInstanceId,
      agentId,
      agentName,
      client,
      // This call attaches the current inbox itself, on the line below.
      { skipInboxId: inboxId, base },
    );
    botId = bot.chatwootAgentBotId;
    // NOTE: the intent, written here and not earlier: it must exist while the fork is asked (a
    // delivery arriving then needs a row to read), and written only once this call holds a client
    // and a bot id, so a pending row always means a call that can still take its attachment back.
    // Nothing is attached for this inbox before this point (`skipInboxId`). A unique violation means
    // another observe of this same agent wrote the pair first; this call settles that row by the
    // pair below. Not written when already observing (this call is the repair, and must not delete
    // a row it never made). Its id is kept, because `(tenantId, inboxId, agentId)` names a slot, not
    // a row, across an unobserve.
    if (!alreadyObserving) {
      try {
        const created = await runScopedOn(base, ctx, async (db) => {
          // The agent's own row, locked in the insert's transaction: the insert's foreign key
          // takes only `KEY SHARE`, compatible with `updateAgent`'s `FOR NO KEY UPDATE`, so without
          // this a promotion and the pending row could both commit, leaving a production agent with
          // an unsettleable pending observer. Same lock as the promotion, so one sees the other.
          // Order agent then inbox, as `deleteAgent` (the insert's trigger takes the inbox row).
          const rows = await db.$queryRaw<Array<{ mode: string }>>`
            SELECT mode FROM agents WHERE id = ${agentId} FOR NO KEY UPDATE`;
          const modeNow = rows[0]?.mode;
          // Gone between the preflight and here: the same answer the foreign key gives on the insert
          // below, and the same one the transaction gives for the same race.
          if (modeNow === undefined) {
            throw new NotFoundError("agent not found", "errors.agentNotFound");
          }
          if (!isMonitoring(modeNow)) {
            throw new AppError(
              "only a monitoring agent can observe an inbox",
              422,
              "errors.observerNotMonitoring",
            );
          }
          return db.inboxObserver.create({
            // NOTE: explicitly null, against the column default: the default makes anything unaware
            // of pending rows (the previous release in a rolling deploy, a fixture, a manual repair)
            // write a confirmed one, and this is the single writer that means the null.
            data: { tenantId, inboxId, agentId, attachedAt: null },
            select: { id: true },
          });
        });
        pendingRowId = created.id;
      } catch (err) {
        // NOTE: a foreign key here names the inbox, not the agent: the agent is locked two statements
        // up, while `removeInbox` can delete the mirror after the read that found it. Asked when
        // Prisma names the constraint (`field_name`), so a foreign key added later reports itself.
        if ((err as { code?: string }).code === "P2003") {
          const field = String(
            (err as { meta?: { field_name?: unknown } }).meta?.field_name ?? "",
          );
          if (field.includes("agent_id")) {
            throw new NotFoundError("agent not found", "errors.agentNotFound");
          }
          throw new NotFoundError("inbox not found", "errors.inboxNotFound");
        }
        if ((err as { code?: string }).code !== "P2002") throw err;
      }
    }
    try {
      await client.addInboxObserver(inbox.chatwootInboxId, botId);
    } catch (err) {
      // NOTE: a 404 here is either the route (a Chatwoot older than the fork's observer binding) or
      // the inbox gone upstream with its mirror kept (`remoteInboxIsGone`). They point the operator
      // opposite ways, so the inbox is asked before either is claimed.
      if (err instanceof ChatwootApiError && err.status === 404) {
        let gone = false;
        try {
          await client.getInbox(inbox.chatwootInboxId);
        } catch (probe) {
          if (!remoteInboxIsGone(probe)) throw probe;
          gone = true;
        }
        if (gone) {
          throw new NotFoundError(
            "this inbox no longer exists in Chatwoot; remove its mirror",
            "errors.inboxGoneRemote",
          );
        }
        throw new AppError(
          "this Chatwoot has no observer binding on inboxes",
          502,
          "errors.chatwootObserverUnsupported",
        );
      }
      throw err;
    }
  } catch (err) {
    // NOTE: the intent goes back with the failed call: a row left behind would report an attach in
    // flight that nothing is flying.
    await dropPendingRow();
    // NOTE: a POST whose answer was lost is an attachment nothing names: without a row the mode and
    // deletion refusals do not apply, so a later promotion would leave a production bot attached.
    // Taken back here, best-effort; a failed detach is what `unobserveInbox` repairs.
    if (
      botId !== null &&
      client !== null &&
      !alreadyObserving &&
      !(await bindingStands())
    ) {
      try {
        await client.removeInboxObserver(inbox.chatwootInboxId, botId);
      } catch (undo) {
        if (!unbindNeedsNothingRemote(undo)) {
          logger.warn(
            {
              err: undo,
              inboxId: String(inboxId),
              agentId: String(agentId),
              why: "the attach failed and could not be taken back",
            },
            "chatwoot: an observer attachment nothing here names could not be detached — an unobserve repairs it",
          );
        }
      }
    }
    if (err instanceof AppError) throw err;
    throw new AppError(
      "could not sync the bot with Chatwoot",
      502,
      "errors.chatwootBindFailed",
    );
  }

  // The attachment the fork now holds, taken back when what landed meanwhile made it wrong: nothing
  // else can name it afterwards. Best-effort and outside every lock; a detach that fails leaves what
  // `unobserveInbox` repairs, since that asks the fork whether or not a row is there.
  const detachQuietly = async (why: string) => {
    if (client === null || botId === null) return;
    if (await bindingStands()) return;
    try {
      await client.removeInboxObserver(inbox.chatwootInboxId, botId);
    } catch (err) {
      if (!unbindNeedsNothingRemote(err)) {
        logger.warn(
          { err, inboxId: String(inboxId), agentId: String(agentId), why },
          "chatwoot: an observer attachment nothing here names could not be detached — an unobserve repairs it",
        );
      }
    }
  };

  // 3. Persist the binding (scoped, no network). The account row first, re-asking the top read
  //    (a disconnect fits in the Chatwoot window); then the inbox row, locked, because the audit
  //    compares against the observer list read under it. Then the agent row, locked, its mode
  //    re-asked: a promotion in the window would leave the fork attached for an agent that answers,
  //    read by the receiver as the responder. Same lock as `updateAgent`, so either order ends well.
  //    The module's one lock order (account, inbox, then agent last).
  let persisted: { dto: InboxDto; responderWon: boolean };
  try {
    persisted = await runScopedOn(base, ctx, async (db) => {
      const account = await db.$queryRaw<{ disconnected_at: Date | null }[]>`
        SELECT i.disconnected_at
          FROM chatwoot_instances i
         WHERE i.id = ${inbox.chatwootInstanceId}
           FOR NO KEY UPDATE`;
      if (account[0]?.disconnected_at != null) {
        throw new AppError(
          "this account is disconnected; reconnect it before assigning an agent",
          409,
          "errors.chatwootAccountDisconnected",
        );
      }
      await db.$queryRaw`SELECT id FROM inboxes WHERE id = ${inboxId} FOR NO KEY UPDATE`;
      const before = await db.inbox.findUniqueOrThrow({
        where: { id: inboxId },
        select: INBOX_SELECT,
      });
      // The module's one lock mode, which is enough here: it conflicts with the stronger lock
      // `updateAgent` takes on the same row, so the two serialize, while a lock that blocks a
      // child insert would deadlock against the webhook mirror (see the fence in
      // tests/modules/audit-channel-family.test.ts).
      const agentNow = await db.$queryRaw<Array<{ mode: string }>>`
        SELECT mode FROM agents WHERE id = ${agentId} FOR NO KEY UPDATE`;
      // NOTE: asked of a new observer only: re-observing is the console's repair for a row whose
      // bot needs re-provisioning. A vanished agent falls through to the upsert's foreign key
      // (P2003, below). The exemption is a confirmed row, never this call's own pending one:
      // `updateAgent` and the pending insert do not serialize, so a promotion can commit beside it.
      if (
        agentNow[0] !== undefined &&
        !isMonitoring(agentNow[0].mode) &&
        !before.observers.some(
          (o) => o.agentId === agentId && o.attachedAt !== null,
        )
      ) {
        throw new AppError(
          "only a monitoring agent can observe an inbox",
          422,
          "errors.observerNotMonitoring",
        );
      }
      // NOTE: the exclusivity check predates the Chatwoot calls, and a bind of this agent fits in
      // between. The responder wins (the fork delivers once, as the responder): no row is written and
      // the attachment is taken back below. `bindInbox` retires the row from its side the same way.
      if (before.agentId === agentId) {
        // NOTE: the intent goes here, not in the outer compensation, because the DTO returned is read
        // in this transaction and would list this call's pending row. By id: another call's row can
        // sit in the same slot by now.
        if (pendingRowId !== null) {
          await db.inboxObserver.deleteMany({
            where: { id: pendingRowId, attachedAt: null },
          });
        }
        const settled = await db.inbox.findUniqueOrThrow({
          where: { id: inboxId },
          select: INBOX_SELECT,
        });
        return { dto: toInboxDto(settled), responderWon: true };
      }
      // Already observing means a confirmed row: this call's own pending row is in `before`,
      // and counting it would make every first observe look like a repeat.
      const already =
        (await db.inboxObserver.findFirst({
          where: { tenantId, inboxId, agentId, attachedAt: { not: null } },
          select: { id: true },
        })) !== null;
      // The stamp, on the row this call wrote, by id: `(tenantId, inboxId, agentId)` names a slot, and an
      // unobserve plus a second observe in the attach window would put a stranger's intent there.
      // Where no row was written, the pair is the right address: this call is settling the row it
      // deferred to (the confirmed one it repairs, or the unique violation's winner), which names
      // exactly this inbox and agent; it is also the repair for a row abandoned mid-attach.
      const stampedAt = new Date();
      const settled = await db.inboxObserver.updateMany({
        where:
          pendingRowId !== null
            ? { id: pendingRowId, attachedAt: null }
            : { tenantId, inboxId, agentId },
        data: { attachedAt: stampedAt },
      });
      // NOTE: nothing to stamp means the intent was taken back meanwhile. Refused, never recreated:
      // recreating could revive a binding an unobserve just removed.
      if (settled.count === 0) {
        // NOTE: two causes. With a row of its own (or a repair of a confirmed binding), an unobserve
        // took it back. With neither, this call deferred to another observe's row, which that call's
        // compensation deleted: a retry, not a decision. Writing the row here cannot tell them apart.
        // Two throws, not a ternary: the error-catalog fence reads the message beside each key at the
        // call site (tests/api/error-catalog.test.ts).
        if (pendingRowId === null && !alreadyObserving) {
          throw new AppError(
            "another observe of this inbox was in flight and did not complete",
            409,
            "errors.observeRacedAnother",
          );
        }
        throw new AppError(
          "this observe was taken back while the attach was in flight",
          409,
          "errors.observeTakenBack",
        );
      }
      const row = await db.inbox.findUniqueOrThrow({
        where: { id: inboxId },
        select: INBOX_SELECT,
      });
      const dto = toInboxDto(row);
      // NOTE: Only when the list MOVED. Observing again is a second click on the same switch, or
      // the retry above with nothing left to repair: Chatwoot was asked again, nothing here
      // changed, and a row would report a change that is not one. Same rule as `bindInbox`
      // re-submitted with its agent.
      if (!already) {
        await auditMutation(db, ctx, {
          action: "inbox.observe",
          target: `inbox:${inboxId}`,
          // NOTE: the state before this call, not the rows before this write: this call's own pending
          // row is in `before` too.
          before: { observerAgentIds: confirmedObserverIds(before) },
          after: { observerAgentIds: dto.observerAgentIds },
        });
      }
      return { dto, responderWon: false };
    });
  } catch (err) {
    // NOTE: the intent goes back with every refusal here, before the detach and the throw: a row
    // left pending would be read as an attach still in flight.
    await dropPendingRow();
    // NOTE: The agent deleted between the checks at the top and this row. `deleteAgent` refuses
    // only while a row exists, and the row is what this transaction was about to write; the
    // foreign key says so, the bot row went with the agent, and the fork is attached to a bot
    // nothing here can name any more — so it is detached now, because no retry can.
    if ((err as { code?: string }).code === "P2003") {
      await detachQuietly("the agent was deleted during the attach");
      throw new NotFoundError("agent not found", "errors.agentNotFound");
    }
    // NOTE: any other throw leaves the row unwritten (a refusal inside the Chatwoot window, or a
    // failed write), so the upstream attachment is the only trace and would observe past the mode
    // and deletion refusals: taken back, since no retry can. Only what this call attached: a
    // re-observe that found the binding must leave it (a disconnect keeps observers). That is a
    // question about now, not the start of the call: `detachQuietly` reads a confirmed row of this
    // pair and leaves the attachment when one stands.
    await detachQuietly("the observe did not complete after the attach");
    throw err;
  }
  if (persisted.responderWon) {
    // NOTE: the bind retires the observer row from its side only if it could see it; this call's
    // pending row was written after that read, so it goes back here with the attachment.
    await dropPendingRow();
    await detachQuietly("the responder binding won the race");
  }
  return persisted.dto;
}

// The observer's unbind, idempotent on both sides: the fork is asked to detach whenever a bot of this
// persona exists, row or no row, and a 404 means the state asked for already holds (as in
// `unbindNeedsNothingRemote`). Asking regardless of the row makes this the repair for every
// attachment no row names (a lost answer, a race leftover, an overlapping observe and unobserve).
// A row that was never there records nothing.
export async function unobserveInbox(
  ctx: TenantContext,
  inboxId: bigint,
  agentId: bigint,
  deps: LoadChatwootClientDeps = {},
  base: PrismaClient = basePrisma,
): Promise<InboxDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;

  const inbox = await runScopedOn(base, ctx, async (db) => {
    const row = await db.inbox.findUnique({
      where: { id: inboxId },
      select: { id: true, chatwootInstanceId: true, chatwootInboxId: true },
    });
    if (!row) {
      throw new NotFoundError("inbox not found", "errors.inboxNotFound");
    }
    const bot = await db.chatwootAgentBot.findUnique({
      where: {
        tenantId_chatwootInstanceId_agentId: {
          tenantId,
          chatwootInstanceId: row.chatwootInstanceId,
          agentId,
        },
      },
      select: { chatwootAgentBotId: true },
    });
    return { ...row, chatwootAgentBotId: bot?.chatwootAgentBotId ?? null };
  });

  // No bot row means nothing of ours is attached on Chatwoot under this persona; only the local
  // binding is left to clear.
  if (inbox.chatwootAgentBotId !== null) {
    try {
      const client = await loadChatwootClient(
        tenantId,
        inbox.chatwootInstanceId,
        { base, makeClient: deps.makeClient },
      );
      await client.removeInboxObserver(
        inbox.chatwootInboxId,
        inbox.chatwootAgentBotId,
      );
    } catch (err) {
      if (!unbindNeedsNothingRemote(err)) {
        if (err instanceof AppError) throw err;
        throw new AppError(
          "could not sync the bot with Chatwoot",
          502,
          "errors.chatwootBindFailed",
        );
      }
    }
  }

  // The inbox row locked for the same reason as in `observeInbox`: the list the audit compares
  // against is read under it. No account lock and no disconnected check, because detaching stays
  // allowed on a disconnected account, as `bindInbox`'s unbind does.
  return runScopedOn(base, ctx, async (db) => {
    await db.$queryRaw`SELECT id FROM inboxes WHERE id = ${inboxId} FOR NO KEY UPDATE`;
    const before = await db.inbox.findUniqueOrThrow({
      where: { id: inboxId },
      select: INBOX_SELECT,
    });
    const { count } = await db.inboxObserver.deleteMany({
      where: { inboxId, agentId },
    });
    const row = await db.inbox.findUniqueOrThrow({
      where: { id: inboxId },
      select: INBOX_SELECT,
    });
    const dto = toInboxDto(row);
    // NOTE: `count` says whether a row was there when the delete ran; a concurrent unobserve that
    // landed first, or a binding that never had one, records nothing.
    if (count > 0) {
      await auditMutation(db, ctx, {
        action: "inbox.unobserve",
        target: `inbox:${inboxId}`,
        before: { observerAgentIds: toInboxDto(before).observerAgentIds },
        after: { observerAgentIds: dto.observerAgentIds },
      });
    }
    return dto;
  });
}

// Whether Chatwoot answered that this inbox does not exist, the single fact that authorizes
// destroying an operator's mirror row, so deliberately narrow: our own error type and a 404 only.
// Anything else means we did not get an answer. A 403 proves the inbox exists (`authorize` runs
// after the `find`). Separate from `unbindNeedsNothingRemote` though the body matches: the two
// routes agree only because both resolve through the same `find`, and a wrong answer here deletes
// a row where there it only skips a call.
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
      // NOTE: the sentence says "confirm", not "reach": this branch also carries answers that did
      // reach us (401, 403, 500), and "could not reach" would be false for those.
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

// Remove the mirror of an inbox that no longer exists in Chatwoot (sync deliberately never prunes: a
// sync that cannot reach an inbox would delete a configured binding). The fence is the feature: the
// mirror recreates an `Inbox` row for any inbox sending traffic (`upsertInbox`), so deleting a live
// inbox's mirror only rebinds it to nobody, and removal is correct only for an inbox Chatwoot says
// is gone. Reads Chatwoot, never writes. Conversations are kept (`onDelete: SetNull`); llm_usage and
// execution_logs keep a dangling `inbox_id` (no foreign key), shown as an unnamed bucket.
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

  // NOTE: a writer already in flight (a sync listed before the upstream deletion, a webhook being
  // mirrored) can put the row back, deliberately: a tombstone would make `upsertInbox` refuse to
  // recreate a row for traffic, leaving customers reaching nobody with no repair. The window costs
  // a row reappearing unbound. `deleteMany`, not `delete`: a concurrent removal after the read would
  // make `delete` answer P2025 (a 500) for two operators doing the same correct thing.
  await runScopedOn(base, ctx, async (db) => {
    // NOTE: re-read under the row lock, not from `inbox` above: a sync or bind can write in the
    // window left open above, and the trail describes what was removed, not what was read.
    await db.$queryRaw`SELECT id FROM inboxes WHERE id = ${inboxId} FOR NO KEY UPDATE`;
    const current = await db.inbox.findUnique({
      where: { id: inboxId },
      select: {
        id: true,
        name: true,
        chatwootInboxId: true,
        agentId: true,
        // NOTE: the watchers go with it (`InboxObserver` cascades on the inbox), so they are in the
        // projection, read under the same lock: the trail names who was watching, on the one
        // action that cannot be undone.
        observers: { select: { agentId: true } },
      },
    });
    const { count } = await db.inbox.deleteMany({ where: { id: inboxId } });
    // NOTE: Only when THIS call is the one that removed it. `deleteMany` is idempotent on purpose (two
    // operators doing the same correct thing must not produce a 500), and a row per attempt would
    // put the same removal on the trail as many times as it was retried.
    if (count > 0 && current) {
      await auditMutation(db, ctx, {
        action: "inbox.remove",
        target: `inbox:${inboxId}`,
        before: {
          id: String(current.id),
          name: current.name,
          chatwootInboxId: current.chatwootInboxId,
          agentId: current.agentId === null ? null : String(current.agentId),
          // NOTE: the cascade's casualties, on the removal's row rather than a separate
          // `inbox.unobserve`: one action happened.
          observerAgentIds: current.observers.map((o) => String(o.agentId)),
        },
      });
    }
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

// Which inboxes' out-of-hours state was read, per inbox, which is the unit the answer is about: an
// account-wide flag would throw away the inboxes read correctly. `parseInboxList` keeps dropping
// what it cannot read, right for the caller that draws the result; this names the ids it decided,
// so a caller reporting coverage can name the others. "Decided" means the two fields the rule reads
// (`chatwootAutoRepliesOutOfHours`) arrived in the promised shape: a boolean switch and, when on, a
// string message. A default standing in for an unreadable value is the silence this breaks.
export function readInboxStates(raw: unknown): {
  inboxes: RemoteInbox[];
  decided: Set<number> | null;
} {
  const payload = isRecord(raw) ? raw.payload : raw;
  // Not a list at all: nothing was decided, and there is no id to name. The caller reads `null` as
  // "this account said nothing I could use", which is different from an account that listed zero.
  if (!Array.isArray(payload)) return { inboxes: [], decided: null };
  const decided = new Set<number>();
  for (const item of payload) {
    if (!isRecord(item)) continue;
    const id =
      typeof item.id === "number"
        ? item.id
        : typeof item.id === "string" && /^\d+$/.test(item.id)
          ? Number(item.id)
          : null;
    if (id === null) continue;
    if (typeof item.working_hours_enabled !== "boolean") continue;
    if (
      item.working_hours_enabled &&
      // NOTE: an explicit `null` is a read answer (the column is nullable and null by default, so
      // "working hours on, no message" is the ordinary state). Rejecting it would put nearly every
      // install into `unchecked`. `undefined` (key absent) and other types stay unreadable.
      item.out_of_office_message !== null &&
      typeof item.out_of_office_message !== "string"
    ) {
      continue;
    }
    decided.add(id);
  }
  return { inboxes: parseInboxList(raw), decided };
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
    // NOTE: the whole reconcile serializes on the account row, the one lock that covers an inbox
    // that does not exist yet: two first-time syncs (auto-sync on load plus the button) would both
    // read `existing` as null. Syncs of different accounts never contend.
    await db.$queryRaw`SELECT id FROM chatwoot_instances WHERE id = ${instanceId} FOR NO KEY UPDATE`;
    // The rename is its own conditional write, so a name Chatwoot did not change does not
    // count as one. The `null` arm is not decoration: `accountName <> 'x'` is NULL for a row whose
    // name is NULL, so a plain `not` would silently skip the very rows that most need the name.
    let renamed = false;
    if (accountName !== undefined) {
      const { count } = await db.chatwootInstance.updateMany({
        where: {
          id: instanceId,
          OR: [{ accountName: null }, { accountName: { not: accountName } }],
        },
        data: { accountName },
      });
      renamed = count > 0;
    }
    let created = 0;
    let updated = 0;
    for (const inbox of remote) {
      // The comparison lives inside the write: a webhook's `upsertInbox` (no account lock) can
      // commit a rename between a read and an upsert, which would then overwrite it and record no
      // change. Raw SQL because it must be one statement: a create-then-catch cannot work (P2002
      // aborts the scoped transaction) and Prisma's upsert cannot "update only if it differs".
      // `xmax = 0` separates inserted from updated; a matching conflict returns no row.
      const [touched] = await db.$queryRaw<{ inserted: boolean }[]>`
        INSERT INTO inboxes
          (tenant_id, chatwoot_instance_id, chatwoot_inbox_id, name, channel_type, provider,
           created_at, updated_at)
        VALUES (${tenantId}::bigint, ${instanceId}::bigint, ${inbox.chatwootInboxId}::int,
                ${inbox.name}::text, ${inbox.channelType}::text, ${inbox.provider}::text,
                now(), now())
        ON CONFLICT (tenant_id, chatwoot_instance_id, chatwoot_inbox_id) DO UPDATE
           SET name = EXCLUDED.name,
               channel_type = EXCLUDED.channel_type,
               provider = EXCLUDED.provider,
               updated_at = now()
         WHERE inboxes.name IS DISTINCT FROM EXCLUDED.name
            OR inboxes.channel_type IS DISTINCT FROM EXCLUDED.channel_type
            OR inboxes.provider IS DISTINCT FROM EXCLUDED.provider
        RETURNING (xmax = 0) AS inserted`;
      if (touched?.inserted) created++;
      else if (touched) updated++;
    }
    const result = { total: remote.length, created, updated };
    // NOTE: `updated` counts inboxes this sync changed, not ones that existed: the Channels page
    // auto-syncs every active account on open, and a reconcile that moved nothing is a read, which
    // gets no trail row and no "3 updated" toast.
    if (created > 0 || updated > 0 || renamed) {
      await auditMutation(db, ctx, {
        action: "instance.sync_inboxes",
        target: `chatwoot_instance:${instanceId}`,
        after: { ...result, accountRenamed: renamed },
      });
    }
    return result;
  });
}
