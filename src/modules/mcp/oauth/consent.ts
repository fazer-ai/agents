import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  McpOAuthPendingAuthorization,
  Prisma,
} from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";

// The base client OR a scoped transaction. These tables are global (no RLS), so what a write needs
// from its client is not a role but a TRANSACTION: the consent decision and the row that records it
// commit together or not at all (#497), and `Prisma.TransactionClient` is the surface both a plain
// `PrismaClient` and the `ScopedDb` handed out by `runScopedOn` satisfy.
type Db = Prisma.TransactionClient;
// OAuth 2.1 consent state. A /authorize that is NOT auto-skipped (first-party client or a
// sufficient prior approval) parks a pending record here and redirects the user to the SPA consent
// screen; the screen reads the record and the user approves/denies. Security model mirrors the
// authorization code (grant.ts): the opaque request id is HASHED at rest, SINGLE-USE (CAS on
// consumed_at), 10-min TTL, bound to the user. The auth code is later minted from THIS record's
// fields — never from the consent POST body (anti-tamper). The mcp_oauth_* tables are GLOBAL (no
// RLS), accessed via the base client.

const PENDING_TTL_MS = 10 * 60_000;

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface CreatePendingParams {
  clientId: string;
  userId: bigint;
  tenantId: bigint | null;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string;
  codeChallengeMethod: string;
  resource?: string | null;
  state?: string | null;
  base?: Db;
}

// Parks a pending authorization; returns the opaque request id (in clear, once) that goes in the
// redirect to the consent screen. Stored hashed.
export async function createPendingAuthorization(
  params: CreatePendingParams,
): Promise<{ requestId: string }> {
  const base = params.base ?? basePrisma;
  const requestId = randomBytes(32).toString("base64url");
  await base.mcpOAuthPendingAuthorization.create({
    data: {
      requestHash: sha256(requestId),
      clientId: params.clientId,
      userId: params.userId,
      tenantId: params.tenantId,
      redirectUri: params.redirectUri,
      scopes: params.scopes,
      codeChallenge: params.codeChallenge,
      codeChallengeMethod: params.codeChallengeMethod,
      resource: params.resource ?? null,
      state: params.state ?? null,
      expiresAt: new Date(Date.now() + PENDING_TTL_MS),
    },
  });
  return { requestId };
}

// Looks up a still-valid pending record for THIS user. Returns null if unknown, consumed, expired,
// or owned by a different user. Does NOT consume.
export async function getPendingAuthorization(
  requestId: string,
  userId: bigint,
  base: Db = basePrisma,
): Promise<McpOAuthPendingAuthorization | null> {
  const row = await base.mcpOAuthPendingAuthorization.findUnique({
    where: { requestHash: sha256(requestId) },
  });
  if (!row) return null;
  if (row.userId !== userId) return null;
  if (row.consumedAt) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

// Mints a CSRF synchronizer token for the consent form and stores it hashed on the (still-valid)
// pending record. Returned in clear to the SPA via the consent GET body (unreadable cross-site by
// SOP); the consent POST must echo it back. Returns null if the record is no longer valid.
export async function issueConsentCsrf(
  requestId: string,
  userId: bigint,
  base: Db = basePrisma,
): Promise<string | null> {
  const row = await getPendingAuthorization(requestId, userId, base);
  if (!row) return null;
  const csrfToken = randomBytes(32).toString("base64url");
  const updated = await base.mcpOAuthPendingAuthorization.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { csrfTokenHash: sha256(csrfToken) },
  });
  if (updated.count === 0) return null;
  return csrfToken;
}

// Verifies the CSRF token and single-use-consumes the pending record (CAS). Returns the record only
// to the first consumer (a concurrent/replayed POST sees count 0 → null). The caller mints the auth
// code from the returned record's fields.
export async function consumePendingAuthorization(
  requestId: string,
  userId: bigint,
  csrfToken: string,
  base: Db = basePrisma,
): Promise<McpOAuthPendingAuthorization | null> {
  const row = await getPendingAuthorization(requestId, userId, base);
  if (!row) return null;
  if (
    !row.csrfTokenHash ||
    !constantTimeEqual(sha256(csrfToken), row.csrfTokenHash)
  ) {
    return null;
  }
  const consumed = await base.mcpOAuthPendingAuthorization.updateMany({
    where: { id: row.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (consumed.count === 0) return null;
  return row;
}

// ───────────────────────────── remembered approvals ──

export async function findApproval(
  userId: bigint,
  clientId: string,
  base: Db = basePrisma,
) {
  return base.mcpOAuthClientApproval.findUnique({
    where: { userId_clientId: { userId, clientId } },
  });
}

// Scope-aware: an approval lets /authorize skip consent only if every scope it would grant is
// already in the approved set (escalation re-prompts).
export function isApprovalSufficient(
  approved: string[],
  granted: string[],
): boolean {
  return granted.every((s) => approved.includes(s));
}

// Records (or widens) the user's approval for a client. Stores the UNION so a later narrower
// request stays covered; a wider one grows the set on the next approval.
//
// THE UNION IS COMPUTED BY THE DATABASE, INSIDE THE WRITE, and that is the whole point of the raw
// statement (#497). Read-then-merge-then-upsert closes over a value read before the write: two
// grants for the same (user, client) in flight together each merge against the set as it was BEFORE
// either landed, so the second write replaces the first's scopes instead of adding to them. Both
// calls return normally and the row is there, so the loss is silent — measured by blocking one
// read until the other grant committed (`tests/modules/mcp-oauth-consent.test.ts`).
//
// `ON CONFLICT DO UPDATE` evaluates its SET against the row as it exists AT THE WRITE, under the
// row lock the conflict takes, so there is nothing for a concurrent grant to slip between. No
// `SELECT … FOR UPDATE` and no transaction: one statement cannot be interleaved.
//
// Prisma has no expression for this — `upsert` takes scalars it computed in JS — so it is raw. The
// `ORDER BY 1` is not cosmetic: `DISTINCT unnest` has no defined order, and the stored order is
// what every reader and every audit projection of this row sees.
export async function upsertApproval(
  userId: bigint,
  clientId: string,
  scopes: string[],
  base: Db = basePrisma,
): Promise<void> {
  await base.$executeRaw`
    INSERT INTO mcp_oauth_client_approvals (user_id, client_id, scopes, created_at, updated_at)
         VALUES (${userId}, ${clientId}, ${scopes}, NOW(), NOW())
    ON CONFLICT (user_id, client_id) DO UPDATE
            SET scopes = ARRAY(
                  SELECT DISTINCT unnest(mcp_oauth_client_approvals.scopes || EXCLUDED.scopes)
                   ORDER BY 1
                ),
                updated_at = NOW()`;
}
