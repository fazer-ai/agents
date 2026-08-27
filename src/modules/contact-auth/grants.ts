import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type AuthContext, readAuthContext } from "./check";
import type { ContactAuthConfig } from "./settings";

// STORING A POSITIVE VERDICT, AND EVERY WAY BACK OUT OF IT (issue #189).
//
// The gate asks the operator's endpoint on every incoming message, which is what lets
// `docs/contact-auth.md` promise that a revocation there lands on the contact's next message. Under
// `contactAuth.mode = "once"` the first `authorized: true` is stored instead and reused, so an
// endpoint that is expensive or rate-limited is asked once per contact rather than once per message,
// and an unlock ("send your access code to be served") stays unlocked without the endpoint having to
// remember anybody.
//
// What is stored is a GRANT and never a refusal. A stored denial would make an unlock permanent: the
// customer sends the code, and the gate answers with a verdict from before they sent it.
//
// A grant is written under a policy and about an identity, and it stops holding the moment either
// moves. Neither is stored in the clear — the row keeps two fingerprints, so a table whose whole job
// is bookkeeping never becomes a second place the customer's phone number lives:
//
//   IDENTITY  the mirrored phone / email / identifier the endpoint answered about. The mirror
//             rewrites those, clears included, and a contact whose number changed is not necessarily
//             the person the verdict was about.
//   POLICY    the endpoint, the credential, the unlock opt-in and the TTL: who answered, what was
//             asked, and for how long the answer counts. Changing any of them invalidates every
//             stored grant at once, which is also the operator's lever for dropping them — there is
//             deliberately no new authenticated route for that (it would be a public surface with an
//             auth story of its own, for something the editor can already express).
//
// Both directions here are best-effort by construction: a grant is an optimization on top of a
// verdict that already stands, so a database that refuses the read costs an extra call to the
// endpoint, and one that refuses the write costs the same on the next message. Neither may turn an
// answered check into a failed one.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export interface GrantIdentity {
  phone: string | null;
  email: string | null;
  identifier: string | null;
}

// JSON rather than a delimiter, so no value can spell the separator: `["a|b", null]` and
// `["a", "b"]` have to stay different questions.
function sha256(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function contactAuthIdentityHash(identity: GrantIdentity): string {
  return sha256([identity.phone, identity.email, identity.identifier]);
}

// The fields that decide WHO answered and WHAT was asked. `enabled` is not one of them: with the
// gate off nothing reads a grant at all. `denyMessage`, the handoff and the notice cooldown are not
// either — they are what happens AFTER a refusal, and a grant is only ever written for an allow.
export function contactAuthPolicyHash(cfg: ContactAuthConfig): string {
  return sha256([
    cfg.url,
    cfg.credentialRef,
    cfg.includeMessageText,
    cfg.grantTtlSeconds,
  ]);
}

export interface GrantKey {
  tenantId: bigint;
  agentId: bigint;
  contactId: bigint;
}

function whereKey(key: GrantKey) {
  return {
    tenantId_agentId_contactId: {
      tenantId: key.tenantId,
      agentId: key.agentId,
      contactId: key.contactId,
    },
  };
}

// The bag as the row keeps it: the same flat object the endpoint sent, so what is stored is readable
// as what was received rather than as our internal pair list.
function contextToJson(context: AuthContext | null | undefined) {
  if (!context || context.length === 0) return Prisma.DbNull;
  return Object.fromEntries(
    context.map((f) => [f.key, f.value]),
  ) as Prisma.InputJsonValue;
}

// The stored verdict, or null when there is none that still holds.
//
// This half only READS. Deleting a row that does not hold would be the obvious thing to do here and
// is deliberately not done: the verdict path already owns the row (an allow replaces it, a refusal
// drops it), and adding a second remover made the first one unobservable — with the read deleting,
// every path that reaches an ask had already had its row taken away, so removing the drop-on-refusal
// broke no test while leaving a real hole open: a read that FAILS (a transient database blip) is
// followed by an ask, and a refusal there has to drop a row that is otherwise still perfectly valid.
// A row that does not hold cannot be used by anyone — the fingerprints or the expiry say so — and
// the contact's next verdict replaces or removes it.
export async function readContactAuthGrant(
  base: PrismaClient,
  key: GrantKey,
  fingerprints: { identityHash: string; policyHash: string },
  nowMs: number = Date.now(),
): Promise<{ context: AuthContext | null } | null> {
  try {
    const row = await runScopedOn(base, sysCtx(key.tenantId), (db) =>
      db.contactAuthGrant.findUnique({
        where: whereKey(key),
        select: {
          identityHash: true,
          policyHash: true,
          context: true,
          expiresAt: true,
        },
      }),
    );
    if (!row) return null;
    const holds =
      row.expiresAt.getTime() > nowMs &&
      row.identityHash === fingerprints.identityHash &&
      row.policyHash === fingerprints.policyHash;
    if (!holds) return null;
    // Read back through the SAME reader the endpoint's answer went through, so a cap tightened later
    // applies to what is already stored instead of only to what arrives next.
    return { context: readAuthContext(row.context) };
  } catch (err) {
    logger.warn(
      "contact-auth: reading the stored grant failed (agent=%s): %s",
      String(key.agentId),
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

export async function writeContactAuthGrant(
  base: PrismaClient,
  key: GrantKey,
  grant: {
    identityHash: string;
    policyHash: string;
    context: AuthContext | null | undefined;
    ttlSeconds: number;
  },
  nowMs: number = Date.now(),
): Promise<void> {
  const context = contextToJson(grant.context);
  const expiresAt = new Date(nowMs + grant.ttlSeconds * 1000);
  const data = {
    identityHash: grant.identityHash,
    policyHash: grant.policyHash,
    context,
    expiresAt,
  };
  try {
    await runScopedOn(base, sysCtx(key.tenantId), (db) =>
      db.contactAuthGrant.upsert({
        where: whereKey(key),
        create: { ...key, ...data },
        update: data,
      }),
    );
  } catch (err) {
    logger.warn(
      "contact-auth: storing the grant failed (agent=%s): %s",
      String(key.agentId),
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Used on a fresh refusal, so a re-ask can only ever take a grant AWAY — under EVERY mode, not only
// under `once` (see the call site). It runs for a contact that may well have none, which is why it
// deletes by key instead of reading first.
export async function dropContactAuthGrant(
  base: PrismaClient,
  key: GrantKey,
): Promise<void> {
  try {
    await runScopedOn(base, sysCtx(key.tenantId), (db) =>
      db.contactAuthGrant.deleteMany({
        where: {
          tenantId: key.tenantId,
          agentId: key.agentId,
          contactId: key.contactId,
        },
      }),
    );
  } catch (err) {
    logger.warn(
      "contact-auth: dropping the stored grant failed (agent=%s): %s",
      String(key.agentId),
      err instanceof Error ? err.message : String(err),
    );
  }
}
