import { z } from "zod";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError, ConflictError, NotFoundError } from "@/lib/errors";
import { parseInput } from "@/lib/parse-input";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
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
    const dep = await db.chatwootDeployment.findFirst({
      select: { id: true, baseUrl: true },
    });
    if (!dep) {
      throw new NotFoundError(
        "no chatwoot deployment connected",
        "errors.chatwootDeploymentNotFound",
      );
    }
    // NOTE: The deployment and then every account under it, in that order, BEFORE the counts. This
    // is the outermost of the three levels the module locks, and the reason it is taken here is the
    // count: a sync or a connect committing between the reading and the delete gives the cascade
    // rows the row never mentioned. Holding the deployment stops a new account from appearing;
    // holding the accounts stops their inboxes from moving.
    //
    // TODO: An inbox mirrored by INBOUND TRAFFIC (`upsertInbox`, which answers a webhook and takes
    // no account lock) can still land in the same instant and be counted low. The count is a
    // description of a destructive act, not a receipt, and closing that would put a lock on the
    // delivery path to make an audit number exact.
    await db.$queryRaw`SELECT id FROM chatwoot_deployments WHERE id = ${dep.id} FOR NO KEY UPDATE`;
    await db.$queryRaw`SELECT id FROM chatwoot_instances WHERE deployment_id = ${dep.id} ORDER BY id FOR NO KEY UPDATE`;
    // NOTE: WHAT WENT WITH IT, counted before the delete, because after it there is nothing left to count.
    // This is the widest destructive act the console offers: the cascade reaches every account,
    // inbox, agent bot and conversation of the tenant, and the contacts are deleted by hand first
    // because no cascade reaches them. The row is the only thing that survives it.
    //
    // NOTE: Recorded BEFORE the delete rather than after, and it stays: `audit_logs.tenant_id` cascades on
    // the TENANT, which is not what is being deleted here.
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

// What `connectChatwootDeployment` decides about its INPUT, before any database: the schema, the
// normalized base URL it would store, and whether that URL may be reached at all. Split out so the
// MCP preview can ask the same question the apply asks (#490).
//
// NOTE: the SSRF verdict is IN here, DNS included, and the writer below no longer repeats it. It is
// a verdict about the argument — `http://127.0.0.1:9/` fails on the protocol, `https://localhost` on
// where the name points — and leaving either half out let the preview approve a URL the apply then
// answered "Blocked outbound URL" for. It costs nothing on an apply, because the preview branch is
// the only caller that reaches this ahead of the write. The credential probe stays below: that one
// is a call, and it is why a preview cannot promise the connection will succeed.
// One tenant, one Chatwoot server: a connect that names a DIFFERENT base URL than the one already
// stored is refused, and disconnecting is the only way to switch. Both the write and the preview
// compare through here, so the two cannot end up disagreeing about what counts as "different" —
// the comparison is against the NORMALIZED input, which is also what gets stored.
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
  // NOTE: BEFORE the credential round trip, not after. The transaction below asks this again and
  // remains the authority; this early copy exists because the answer is already knowable from our
  // own database, and reaching the network first means sending the operator's admin token to a
  // server we are about to reject anyway. It also keeps the two halves agreeing on WHICH refusal
  // the caller gets: the preview answers "different deployment" with no network at all, and an
  // apply that validated credentials first would answer "bad credentials" for the same call (#490).
  await assertDeploymentNotSwitching(ctx, data.baseUrl, base);
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
    // NOTE: The server and how many accounts the token could reach, and NEVER the token itself: it
    // is one of the two documented raw-secret carve-outs (`docs/mcp.md`), and this row outlives the
    // deployment it describes.
    //
    // A re-connect with the SAME token is the idempotent case (the form re-submitted, a retry after
    // a timeout) and records nothing. Asked of the plaintext, because `encryptJson` randomizes and
    // the column always differs.
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
      // NOTE: The action names the CHANGE, not the door it came through, which is the rule the whole
      // trail is built on. Re-submitting this form against the deployment already connected changes
      // exactly one column, the admin token, and `rotateChatwootDeploymentToken` records that same
      // write as `deployment.rotate_token`; naming it `deployment.connect` here would make the
      // action depend on which screen the operator happened to use, and put a `reachableAccounts`
      // count on a row where nothing about the accounts moved. Same write, same name, same
      // projection — including saying nothing about either end of the token.
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

// Rotate the deployment's admin token (the operator pasted a new one). Validated by a /profile probe
// before it persists. Affects every account under the deployment (they share it).
// The stored admin token as plaintext. Only ever compared, never returned to a caller and never
// projected.
//
// `decryptJson` is allowed to throw, by the rule every other reader of these columns already
// follows: a blob that will not decrypt is a key or integrity problem, not an empty value. Swallowing
// it here would be worse than the failure it hides, because it only fixes the comparison: the client
// loader, the webhook and the disconnect all decrypt this same column and all still throw, so connect
// would report success on a deployment that stays broken everywhere the operator actually uses it.
function readStoredToken(blob: string): string {
  const v = decryptJson(blob);
  if (typeof v !== "string") {
    throw new AppError("stored Chatwoot admin token is not a string", 500);
  }
  return v;
}

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
    // NOTE: THAT it moved, never what it moved to, and never what it moved from. A rotation's whole
    // point is that the old value stops being valid, and a row that kept either end would outlive
    // the rotation it records.
    //
    // Whether it moved is asked of the PLAINTEXT, because the ciphertext cannot answer: `encryptJson`
    // randomizes, so re-submitting the token already stored produces a different blob and a
    // comparison on it would report a rotation on every retry of a request that timed out.
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
    // NOTE: The DEPLOYMENT row first, outermost of the three (deployment, then account, then its
    // inboxes) so the whole module takes them in one order. It is also what makes the disconnect's
    // count honest: locking the accounts it is about to destroy cannot block a brand-new one from
    // being INSERTED under it, and this is the lock that can.
    await db.$queryRaw`SELECT id FROM chatwoot_deployments WHERE id = ${deploymentId} FOR NO KEY UPDATE`;
    const existing = await db.chatwootInstance.findFirst({
      where: { accountId },
      select: { id: true },
    });
    if (existing) {
      // NOTE: ONE conditional write, and it is what decides the row, the same way the disconnect
      // side decides it. Two overlapping requests both read this account as disconnected under
      // read-committed, so an unconditional `update` would let the second one through and record a
      // second `instance.connect` for an account already connected. With the condition in the
      // `where`, the second update re-evaluates it after the first commits, matches nothing, and
      // both writes nothing and records nothing.
      //
      // The metadata rides INSIDE that condition rather than beside it. Refreshing it
      // unconditionally would let the request that lost the race move `accountName` with no row
      // saying so — and the winner already wrote it, from a probe of the same deployment a moment
      // earlier, so there is nothing to lose by not writing it twice.
      const { count } = await db.chatwootInstance.updateMany({
        where: { id: existing.id, disconnectedAt: { not: null } },
        data: { disconnectedAt: null, deploymentId, accountName, serverKey },
      });
      if (count > 0) {
        // NOTE: In THIS transaction, not with the choice that asked for it. `setConnectedAccounts`
        // connects one account per iteration and syncs each, so a crash between two of them leaves an
        // account handled with the operator's choice not yet recorded. The disconnect side has had a
        // row per account since the MCP tools; this is the same fact in the other direction.
        await auditMutation(db, ctx, {
          action: "instance.connect",
          target: `chatwoot_instance:${existing.id}`,
          after: { id: String(existing.id), accountId, accountName },
        });
        return { id: existing.id, reconnected: true, changed: true };
      }
      // NOTE: Zero has TWO causes and only one of them is success. Either the row is still there and
      // already connected (another request won the race above, and reporting no change is right), or
      // `removeChatwootInstance` deleted it between the read and this write: it locks the INSTANCE
      // row while this transaction holds the DEPLOYMENT, so nothing serialises the two. Reading zero
      // as the first cause would answer the operator with the id of a row that no longer exists, and
      // `setConnectedAccounts` would then sync inboxes for it and report the account connected. Ask
      // again before deciding: still there means idempotent success, gone means this account is not
      // connected and the create below is what the caller asked for.
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
  return { id: result.id, changed: result.changed };
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
//
// It takes the WHOLE set rather than asking once per account: one `asSuperAdminOn` per element
// would be a privileged transaction per element, over an array the published
// `deployment_set_accounts` schema does not cap, and the preview would pay it before the apply paid
// it again.
//
// It also does not put the whole set in ONE `IN`, for the same reason read the other way. Each id is
// a bind parameter and Postgres takes at most 32767 of them, so a single query is fine until it is
// not: measured, 32760 ids answer in 56ms and 32770 raise "The query parameter limit supported by
// your database is exceeded" — a CRASH, not a refusal, for input the published schema accepts, on
// the preview as much as on the apply. Chunking makes the query count grow with the input instead
// of the query WIDTH, which is the axis with a hard ceiling. A realistic call is one chunk.
const CLAIM_CHECK_CHUNK = 1000;

async function assertAccountsNotTakenByAnotherTenant(
  base: PrismaClient,
  tenantId: bigint,
  serverKey: string,
  accountIds: number[],
): Promise<void> {
  if (accountIds.length === 0) return;
  // NOTE: the chunks share ONE transaction. Chunking to dodge the parameter ceiling would otherwise
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

// What `setConnectedAccounts` decides before it writes or calls anything: the tenant HAS a
// deployment, and every account it was handed is claimable — not already owned by another tenant,
// fleet-wide. Split out so the MCP preview can ask the same question the apply asks (#490).
//
// NOTE: both halves are here on purpose. An earlier version answered only the first, and the fence
// stayed green because its row for this tool passes no deployment at all — while a preview handed
// an account another tenant owns still said "will connect" and the apply answered "already
// connected to another tenant". A preflight that covers part of its core's judgement reads exactly
// like one that covers all of it.
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
  // NOTE: THE CHOICE, as one row, on top of whatever the accounts it dropped or connected recorded
  // for themselves. The three are not the same fact and none covers the others: an
  // `instance.connect`/`instance.disconnect` says one account started or stopped being handled, and
  // this says which set the operator asked for.
  //
  // And only when the set MOVED, decided by the WRITES and not by the snapshot that preceded them.
  // A re-submitted form (or an idempotent retry) skips both loops entirely and a row for it would be
  // the trail reporting a mutation that did not happen; two overlapping copies of the same change
  // both enter the loops with the same stale snapshot, and only the one whose conditional write
  // matched a row actually changed the fleet.
  if (moved) {
    // NOTE: BEST-EFFORT, and the only row in this family that is. Every other row rides inside the
    // transaction of the write it records, which is what #392 built the seam for; this one cannot,
    // because the writes it summarises are N transactions by design (each account commits its own,
    // so a crash between two leaves the accounts already handled with rows saying so). By the time
    // this runs, the operator's selection HAS been applied — failing the request over the summary
    // would report a change that happened as a failure, and the retry would be a no-op that never
    // writes the row anyway. The per-account rows are the durable record; this is the choice on top
    // of them, and its loss is logged rather than raised.
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
// Chatwoot so it STOPS delivering events to our webhook) and stamp disconnectedAt. The rows
// (conversations / inboxes / contacts / analytics) are KEPT so history and the dashboard stay intact;
// the webhook/runtime then ignore the account. Best-effort on the Chatwoot side: an unreachable
// deployment still gets the local unbind + the disconnect stamp.
//
// Returns whether THIS call is the one that stamped it. The endpoint is idempotent, so a retry and
// the loser of two overlapping requests both get `false`, which is what lets a caller say whether
// anything moved instead of assuming it did.
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
  // NOTE: ONE transaction for the three local writes: clearing the bindings, stamping the account as
  // disconnected, and the row that records it. Split, the unbind committed first and a failure on
  // either of the others left inboxes bound to nobody on an account still marked active, with
  // customer messages routed to no agent and no row saying why.
  const { stamped, detach } = await runScopedOn(base, ctx, async (db) => {
    // NOTE: The ACCOUNT row first, before any inbox of it. `syncInboxes` takes the same lock and
    // then upserts the inboxes; taking them in the other order here is an ABBA deadlock between two
    // ordinary operations (the page auto-syncs on load, and a disconnect is a click away).
    //
    // And NO KEY UPDATE rather than FOR UPDATE, which is the mode this whole module uses and the
    // reason is the same everywhere: an INSERT of a row whose foreign key points at this one takes
    // KEY SHARE on it, and FOR UPDATE conflicts with that. The webhook mirror holds an inbox and
    // then inserts a conversation keyed to this account, so a lock of that strength here waits for
    // the inbox while the mirror waits for the account, and Postgres aborts one of them — with
    // nothing about a key being changed anywhere in it. NO KEY UPDATE still excludes another of
    // itself and any ordinary UPDATE, which is all the serialisation these paths ask for.
    await db.$queryRaw`SELECT id FROM chatwoot_instances WHERE id = ${id} FOR NO KEY UPDATE`;
    // NOTE: `RETURNING`, so the bindings this call actually removed are the SAME set the detach
    // below walks, and the count is that set rather than every inbox of the account. Listed first
    // and cleared after, the two drift apart under a bind that lands in between: an inbox unbound
    // here whose bot is still attached in Chatwoot, delivering to a persona that no longer owns it.
    // `agent_id IS NOT NULL` makes the write its own filter.
    const unbound = await db.$queryRaw<{ chatwoot_inbox_id: number }[]>`
      UPDATE inboxes
         SET agent_id = NULL, updated_at = now()
       WHERE tenant_id = ${tenantId}
         AND chatwoot_instance_id = ${id}
         AND agent_id IS NOT NULL
      RETURNING chatwoot_inbox_id`;
    // NOTE: The stamp and the row only where the account was still ACTIVE, decided by the WRITE and
    // not by a reading before it. The endpoint is idempotent, so a retry changes nothing an operator
    // can see and re-stamping would move the moment it happened; and two overlapping requests both
    // read `null` under read-committed, so a check that is not the update itself lets the second one
    // through. `updateMany` with the condition in its `where` is that check and that write at once.
    const { count } = await db.chatwootInstance.updateMany({
      where: { id, disconnectedAt: null },
      data: { disconnectedAt: new Date() },
    });
    // NOTE: OR the unbind, because clearing a binding is a mutation whether or not the stamp moved.
    // A bind can pass its own active check while this disconnect is committing, which leaves an
    // inbox bound on an account already marked disconnected; the retry that clears it finds the
    // stamp already there and would otherwise finish the disconnect with nothing on the trail.
    // `stamped: false` is what tells a reader that this call completed a disconnect rather than
    // starting one.
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
  // The receiver caches "this route token resolves to a live bot" by hash. Invalidated the moment the
  // disconnect is DURABLE and before any network work: the detach below is best-effort and can take
  // as long as an unreachable Chatwoot takes to time out, and every warm entry keeps authenticating
  // and queueing webhooks for an account that is already disconnected for that whole span.
  invalidateRouteTokenCache();
  // NOTE: Chatwoot AFTER our commit, because no transaction of ours spans somebody else's system and
  // only one of the two orders survives a failure. Detaching first and then rolling back (an audit
  // row that cannot be written is enough) leaves the account active and bound HERE while Chatwoot
  // has already stopped delivering to it: an account that looks live, answers nothing, and whose
  // operator was told the disconnect failed. This way a failed transaction changes nothing anywhere
  // and the retry is a real retry, while a failed detach lands on the outcome this function already
  // declares acceptable — the same one an unreachable deployment gives below, where the account is
  // disconnected locally and the webhook ignores whatever still arrives.
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
        // NOTE: Re-asked immediately before each call, because this loop runs OUTSIDE any lock and
        // one unreachable inbox holds it for a whole network timeout. In that span an operator can
        // reconnect the account and bind an agent — two clicks on the page they are already looking
        // at — and the detach would then pull the bot that bind had just attached, leaving an inbox
        // bound here with no bot upstream. Nothing repairs that state: `reconcileInboxBots` asks
        // whether the BOT exists, not whether it is attached, so it reports `active`; and binding
        // the same agent again is a no-op, because the binding is already there.
        //
        // The BINDING is the question, and not whether the account is still disconnected. A bot is
        // on an inbox because something bound it, so the column that says a bot is there is the one
        // that must authorize pulling it; the flag is a proxy for that, and a fence on both says the
        // same thing twice, with the second copy unfalsifiable — `bindInbox` takes the account lock
        // and refuses on a disconnected account, so the two can never disagree in the direction the
        // flag would be needed for (measured: with either half alone the whole family still passes).
        //
        // And it narrows the window rather than closing it: no transaction of ours spans Chatwoot,
        // so a bind landing between this read and the call still loses its attachment. What it buys
        // is that we never issue a detach our own committed state has stopped authorizing.
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
    // The one-deployment invariant is structural now (the account already belongs to the tenant's
    // single deployment), so reconnecting just clears the flag.
    //
    // NOTE: Conditional, and the condition IS the test: under read-committed two overlapping
    // reconnects both read a non-null flag, and a check made before the write would let both record
    // a reconnection only one of them performed.
    const { count: cleared } = await db.chatwootInstance.updateMany({
      where: { id, disconnectedAt: { not: null } },
      data: { disconnectedAt: null },
    });
    const row = await db.chatwootInstance.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    const reconnected = toDto(row);
    // NOTE: No MCP twin: this action reaches the trail through this name and nothing else, because
    // the console is its only door.
    //
    // And only when the account WAS disconnected. The endpoint is idempotent, so a retry (or a
    // direct API client) reaching it on an active account changes nothing, and a row there would be
    // a reconnect event that never happened.
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
// The reading, WITH what it could not read. Every account this walks is asked over the network and
// each failure is absorbed per account (below), so the list alone cannot distinguish "no inbox
// answers out of hours" from "the server that would have said so is down" — and both come back as
// the same short list. The editor is content with that (a warning invented by an outage is worse
// than one that arrives a page load late), but a caller that reports its own coverage is not: it has
// to name the account it never heard from. Hence the count, and `listOutOfOfficeInboxes` right below
// as the projection for everyone who does not care.
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

  // One list call per distinct account, not per inbox: GET /inboxes is account-wide, and an agent
  // bound to six inboxes of one account must not cost six round trips.
  //
  // Concurrent, because the ceiling here is a timeout and not a duration. Every Chatwoot request
  // carries a 15s abort, so reading two accounts in sequence makes an unreachable server cost 30s of
  // an editor-load request that is producing a warning nobody is waiting on — and the second account
  // being healthy would not help, it would just be answered late. Unbounded on purpose: the fan-out
  // is the number of Chatwoot accounts the operator connected, a small number they chose, not
  // anything that grows with traffic.
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

  // Chatwoot's name, not the mirror's: this reading exists because the mirror can be stale, and the
  // inbox the operator has to go find is the one named on the other side.
  //
  // And the coverage is counted PER BOUND INBOX, over the same loop: an inbox whose account never
  // answered, whose entry never came back, or whose out-of-hours fields could not be read is one
  // this call cannot vouch for — while every inbox beside it is still reported normally.
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

// Everything `reconnectInbox` decides before it calls Chatwoot: the inbox exists, it is bound, and
// the agent it names is still there. Split out so the MCP preview can ask the same question the
// apply asks (#490) without performing the reconnection.
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
    const dto = toInboxDto(row);
    // NOTE: The local binding did not move: this re-points CHATWOOT at the bot the inbox already names,
    // which is why the row has no `before`. What it records is that somebody repaired the link.
    //
    // The agent is the one this call ACTED ON, captured before the Chatwoot round trip, and not the
    // one the row names now. A bind landing while those calls are in flight moves the binding, and
    // re-reading it here would file the repair under agent B when the bot that was attached is A's:
    // a row that names the wrong subject is worse than no row, because nothing else on the trail
    // contradicts it.
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
  //
  // NOTE: Chatwoot is ALREADY attached by the time this runs, and this transaction can still fail —
  // on the audit insert, or on the lock below. Rolled back, the bot is on the inbox upstream while
  // our row still names the previous agent (or none), and the message that arrives next is handled
  // by nobody. It is reported rather than compensated, for two reasons: a compensating detach is
  // another call into somebody else's system on an error path, with its own failure; and a RETRY of
  // this same request repairs it completely, because step 2 sees the local binding unchanged, calls
  // Chatwoot again (idempotent) and commits. That is the opposite of the disconnect, where the
  // equivalent retry is a no-op — which is why the two order their remote call differently.
  try {
    return await persistBinding();
  } catch (err) {
    logger.error(
      {
        err,
        tenantId: String(tenantId),
        inboxId: String(inboxId),
        agentId: agentId === null ? null : String(agentId),
      },
      "chatwoot: the bot was attached in Chatwoot and the binding was not saved — retry the bind",
    );
    throw err;
  }

  function persistBinding(): Promise<InboxDto> {
    return runScopedOn(base, ctx, async (db) => {
      // NOTE: The ACCOUNT row first, and the same question the read at the top already asked, because
      // that read predates the Chatwoot calls and a disconnect fits in the window. Without this lock
      // nothing serialises the two: the disconnect stamps the account and unbinds every inbox that was
      // bound AT THAT MOMENT, this one commits `agentId` just after, and the disconnect's own
      // best-effort detach then pulls the bot this call had just attached. What is left is an inbox
      // bound here, with no bot in Chatwoot, on an account that reconnects looking healthy — and
      // binding the same agent again is a no-op, because the binding is already there. Taken in the
      // module's one order (account, then inbox), so this cannot deadlock against `syncInboxes` or the
      // disconnect itself.
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
      // NOTE: Read INSIDE the transaction and with the row LOCKED, because it is what the audit
      // compares against. The reading taken at the top predates the Chatwoot calls, which are a window
      // a concurrent bind fits into; and an unlocked read here is the same hole one level down, where
      // two overlapping binds both see the old agent and the transition `null -> A -> B` reaches the
      // trail as two rows that both claim to have started from null.
      const locked = await db.$queryRaw<{ agent_id: bigint | null }[]>`
      SELECT agent_id
        FROM inboxes
       WHERE id = ${inboxId}
         FOR NO KEY UPDATE`;
      const beforeWrite = locked[0] ?? null;
      await db.inbox.update({ where: { id: inboxId }, data: { agentId } });
      const row = await db.inbox.findUniqueOrThrow({
        where: { id: inboxId },
        select: INBOX_SELECT,
      });
      const dto = toInboxDto(row);
      const wasBoundTo = beforeWrite?.agent_id ?? null;
      // NOTE: BOTH SIDES, because an unbind is the same call with a null and it is the one that silences an
      // inbox. The agent the inbox is losing is only knowable from the reading taken at the top.
      //
      // And only when the binding MOVED: re-submitting the editor with the same agent reaches the
      // network branch, which deliberately does nothing, so a row would report a change that is not
      // one. Compared against the reading that predates the write.
      if (wasBoundTo !== agentId) {
        await auditMutation(db, ctx, {
          action: "inbox.bind",
          target: `inbox:${inboxId}`,
          before: { agentId: wasBoundTo === null ? null : String(wasBoundTo) },
          after: { agentId: dto.agentId },
        });
      }
      return dto;
    });
  }
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
    // NOTE: Re-read under the row LOCK, and not from `inbox` above. That snapshot was taken before
    // the network question, and the window the comment above deliberately leaves open is exactly
    // the one a sync or a bind writes in: the row that gets deleted here can carry a name or an
    // agent the snapshot never saw, and the trail has to describe what was removed rather than what
    // was read.
    await db.$queryRaw`SELECT id FROM inboxes WHERE id = ${inboxId} FOR NO KEY UPDATE`;
    const current = await db.inbox.findUnique({
      where: { id: inboxId },
      select: {
        id: true,
        name: true,
        chatwootInboxId: true,
        agentId: true,
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

// Pure parse of the Chatwoot inbox-list response. Confirmed against the chatwoot-pro fork:
// `{ payload: [{ id, name, channel_type, … }] }`. Tolerant of a bare array and of
// missing name/channel_type; skips entries without a numeric id.
// DID WE READ THIS INBOX'S OUT-OF-HOURS STATE — asked per inbox, which is the unit the answer is
// actually about, and the reason this is a map rather than a flag on the account.
//
// It arrived as a flag first and four review rounds took it apart one spelling at a time: an account
// that threw, a body that was not a list, an entry with no id, and a field the parser defaults
// silently. Each was answered with another condition, and the fourth found the flag ALSO throwing
// away the inboxes it had read correctly — an account-wide verdict cannot help doing that.
//
// Per inbox there is no such trade. `parseInboxList` keeps dropping what it cannot read, which stays
// right for the caller that DRAWS the result; this says which ids it managed to decide, so a caller
// that reports its own coverage can name the ones it did not, and still use the ones it did.
//
// "Decided" means the two fields the rule reads (`chatwootAutoRepliesOutOfHours`) arrived in a shape
// the wire format promises: a boolean switch, and — when it is on — a string message. A default
// standing in for an unreadable value is exactly the silence this whole field exists to break.
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
      // An explicit `null` is a READ answer, not an unread one: the column is nullable and null is
      // its default, so "working hours on, no message configured" is the ordinary state of an inbox
      // nobody set copy for — measured against the fork, where six of six inboxes carry
      // `out_of_office_message: null`. Rejecting it would put `chatwootOutOfOffice` into `unchecked`
      // on almost every real install, which is the field crying wolf until nobody reads it.
      // `undefined` (the key absent) and any other type stay unreadable.
      item.out_of_office_message !== null &&
      typeof item.out_of_office_message !== "string"
    ) {
      continue;
    }
    decided.add(id);
  }
  return { inboxes: parseInboxList(raw), decided };
}

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
    // NOTE: The whole reconcile serialises on the ACCOUNT row, which is the one lock that covers an
    // inbox that does not exist yet: a row lock on an absent row locks nothing, so two first-time
    // syncs of the same account would both read `existing` as null and both claim the creation. The
    // Channels page auto-syncs on load while the operator can press the button, so those two overlap
    // in ordinary use. Syncs of DIFFERENT accounts never contend.
    await db.$queryRaw`SELECT id FROM chatwoot_instances WHERE id = ${instanceId} FOR NO KEY UPDATE`;
    // NOTE: The rename is its own conditional write, so a name Chatwoot did not change does not
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
      // NOTE: The comparison lives INSIDE the write, not in a read before it. It used to be a
      // `findUnique` followed by an upsert, and between those two statements a webhook's
      // `upsertInbox` (`mirror.ts`, which takes no lock on this account) can commit a rename: the
      // pre-read matched the snapshot, the upsert then overwrote the webhook's value, and `updated`
      // stayed zero, a change with no row, against the one invariant this family is built on. With
      // the condition on the conflict arm the write itself decides, so nothing can move under it.
      //
      // Raw rather than `db.inbox.upsert` for two reasons that both need the statement to be one:
      // a create-then-catch cannot work here at all (a P2002 aborts the whole scoped transaction, so
      // the catch's UPDATE can never run), and Prisma's upsert has no way to say "update only if it
      // differs". `xmax = 0` separates a row that was INSERTED from one that was UPDATED; a conflict
      // whose values already match returns NO row, which is the reconcile that moved nothing.
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
    // NOTE: `updated` counts the inboxes this sync CHANGED, not the ones that already existed. It
    // used to be the latter, and both readers were wrong for it: the toast said "3 updated" after
    // a reconcile that moved nothing, and the trail got a row on every page load, because the
    // Channels page auto-syncs every active account when it opens. A reconcile that found the
    // mirror already correct is a read, and reads do not get rows.
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
