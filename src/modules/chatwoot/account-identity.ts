import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { AppError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/pg-error";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { fetchChatwootAccount } from "./client";

// A Chatwoot account's identity across tenants: its id plus the instant Chatwoot created it, read
// from the account itself. Every address of one installation answers the same pair, so ownership
// keyed on it does not depend on which address a deployment uses (`127.0.0.1` and `localhost`, a
// private and a public name, a host with a trailing dot). Another installation's account with the
// same id was created at another instant. A copy restored from a backup carries the original's
// instants, so it reads as the same account and its claim is refused while the original is held.
// The unique index on (account_id, account_created_at) is what enforces it; see docs/chatwoot.md.

export interface AccountIdentityDeps {
  fetchAccount?: (p: {
    baseUrl: string;
    token: string;
    accountId: number;
  }) => Promise<unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The creation instant of the account the response describes, or null when the response is not
// that account or carries no readable instant.
export function parseAccountCreatedAt(
  raw: unknown,
  accountId: number,
): Date | null {
  if (!isRecord(raw)) return null;
  const id =
    typeof raw.id === "number"
      ? raw.id
      : typeof raw.id === "string" && /^\d+$/.test(raw.id)
        ? Number(raw.id)
        : null;
  if (id !== accountId || typeof raw.created_at !== "string") return null;
  const at = new Date(raw.created_at);
  return Number.isNaN(at.getTime()) ? null : at;
}

function identityUnreadable(): AppError {
  return new AppError(
    "could not reach Chatwoot with the provided URL/token",
    502,
    "errors.chatwootProfileFailed",
  );
}

// The identity of each account, read through the deployment's address and token. Fails closed: an
// account whose identity cannot be read cannot be proven free, so the claim is refused.
export async function readAccountIdentities(
  dep: { baseUrl: string; token: string },
  accountIds: number[],
  deps: AccountIdentityDeps = {},
): Promise<Map<number, Date>> {
  const fetchAccount = deps.fetchAccount ?? fetchChatwootAccount;
  const out = new Map<number, Date>();
  for (const accountId of accountIds) {
    let raw: unknown;
    try {
      raw = await fetchAccount({ ...dep, accountId });
    } catch {
      throw identityUnreadable();
    }
    const at = parseAccountCreatedAt(raw, accountId);
    if (at === null) throw identityUnreadable();
    out.set(accountId, at);
  }
  return out;
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface MarkIdentitiesResult {
  marked: number;
  unreadable: number;
  // Accounts another tenant already holds under the same identity: two tenants own one account,
  // which only a person can untangle. The row is left as it is and keeps working.
  heldElsewhere: number[];
}

// Reads the identity of every account of the tenant connected before it was recorded, active or
// paused. Runs on each reconcile pass, so a Chatwoot that is down now is read on a later one.
export async function markAccountIdentities(
  tenantId: bigint,
  deps: AccountIdentityDeps = {},
  base: PrismaClient = basePrisma,
): Promise<MarkIdentitiesResult> {
  const result: MarkIdentitiesResult = {
    marked: 0,
    unreadable: 0,
    heldElsewhere: [],
  };
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootInstance.findMany({
      where: { accountCreatedAt: null },
      select: {
        id: true,
        accountId: true,
        deployment: { select: { baseUrl: true, adminToken: true } },
      },
    }),
  );
  for (const row of rows) {
    let at: Date;
    try {
      const token = decryptJson<string>(row.deployment.adminToken);
      const ids = await readAccountIdentities(
        { baseUrl: row.deployment.baseUrl, token },
        [row.accountId],
        deps,
      );
      at = ids.get(row.accountId) as Date;
    } catch {
      result.unreadable += 1;
      continue;
    }
    try {
      const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.chatwootInstance.updateMany({
          where: { id: row.id, accountCreatedAt: null },
          data: { accountCreatedAt: at },
        }),
      );
      result.marked += count;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      result.heldElsewhere.push(row.accountId);
      logger.error(
        {
          tenantId: String(tenantId),
          instanceId: String(row.id),
          accountId: row.accountId,
        },
        "chatwoot: account %d is connected to another tenant too, through another address of the same Chatwoot; disconnect it from the tenant that should not own it",
        row.accountId,
      );
    }
  }
  return result;
}
