import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readVaultRefId } from "@/modules/vault/service";
import { type AuthContext, readAuthContext, underSignal } from "./check";
import {
  CONTACT_AUTH_TIMEOUT_MAX_MS,
  type ContactAuthConfig,
} from "./settings";

// Stored positive verdicts for `contactAuth.mode = "once"`, and every way back out of them; the full
// rule is in docs/contact-auth.md ("Reusing a verdict"). Only a GRANT is stored, never a refusal (a
// stored denial would make an unlock permanent). A grant is served only while it has not expired and
// its identity and policy fingerprints (policy includes the credential's revision) match what is in
// force, and no unconfirmed write stands for the contact; mismatches are match rules, not revocations.
// Only a refusal or a replacing verdict removes one. Read and write are best-effort and never turn an
// answered check into a failed one; the DELETE ends an authorization, so its failure is remembered.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// What this process knows that the table cannot say, per contact, memory only (a restart costs a
// stale grant the TTL still bounds, never a wrong refusal). `refusedAt`: when a refusal last landed,
// so an allow from a check that started before it loses however late it arrives. `unconfirmed`: a
// DELETE or UPSERT this process could not confirm; while it stands nothing stored is served, and the
// next check of ANY mode deletes first (`perMessage` reads no grants, so a read-path retry would never
// run there). Bounded by count with insertion-ordered eviction.
let maxTrackedContacts = 10_000;

// How long a refusal marker is protected from eviction: no check can outlive its own budget, and the
// budget is clamped here (./settings.ts).
let refusalProtectionMs: number = CONTACT_AUTH_TIMEOUT_MAX_MS;
let sweepTimer: ReturnType<typeof setTimeout> | undefined;

// NOTE: Test-only, so the eviction rule can be exercised without ten thousand contacts and without
// waiting out the protection window. Production never calls these.
export function setMaxTrackedContactsForTest(n: number): void {
  maxTrackedContacts = n;
}
export function setRefusalProtectionForTest(ms: number): void {
  refusalProtectionMs = ms;
}
export function knownContactCount(): number {
  return known.size;
}
const known = new Map<string, { refusedAt?: number; unconfirmed: boolean }>();

function contactKey(key: GrantKey): string {
  return `${key.tenantId}:${key.agentId}:${key.contactId}`;
}

function remember(
  key: GrantKey,
  patch: { refusedAt?: number; unconfirmed?: boolean },
): void {
  const k = contactKey(key);
  const prev = known.get(k);
  // The NEWEST refusal wins, and a retry that finally lands keeps the ORIGINAL instant. Both halves
  // are the same rule read from two sides: what is kept is the latest refusal this process knows
  // about. Taking the incoming value instead lets an older refusal finishing late overwrite a newer
  // one, and an allow asked between them would then pass; stamping a retry with its own clock makes
  // a months-old refusal look newer than the check retrying it, and that check's own yes is thrown
  // away.
  const refusedAt =
    prev?.refusedAt !== undefined && patch.refusedAt !== undefined
      ? Math.max(prev.refusedAt, patch.refusedAt)
      : (patch.refusedAt ?? prev?.refusedAt);
  const next = {
    refusedAt,
    unconfirmed: patch.unconfirmed ?? prev?.unconfirmed ?? false,
  };
  known.delete(k);
  known.set(k, next);
  // The wall clock, never the patch: a retry carries the ORIGINAL refusal instant, and measuring the
  // in-flight window from that would age every other entry by however long the retry took.
  evictOldestConfirmed(Date.now());
}

// The cap protects against a flood of ORDINARY entries, and eviction walks past two kinds: an
// UNCONFIRMED entry (a delete still owed, the only thing stopping a refused contact being served), and
// a refusal younger than CONTACT_AUTH_TIMEOUT_MAX_MS (an unfinished allow may still have to lose to
// it). A burst of protected refusals drains as they age past that window.
function evictOldestConfirmed(nowMs: number): void {
  while (known.size > maxTrackedContacts) {
    let evicted = false;
    for (const [k, entry] of known) {
      if (entry.unconfirmed) continue;
      if (
        entry.refusedAt !== undefined &&
        entry.refusedAt > nowMs - refusalProtectionMs
      ) {
        continue;
      }
      known.delete(k);
      evicted = true;
      break;
    }
    // Everything left is protected. The overflow is real memory, and it does not drain on its own
    // unless something wakes up to look at it again: eviction otherwise runs only when a refusal
    // arrives, and a spike that stops refusing is exactly the case where none does. Same idiom as
    // the notice cooldown next door — one unref'd timer, armed for the earliest marker's release.
    if (!evicted) {
      scheduleEvictionSweep(nowMs);
      return;
    }
  }
}

function scheduleEvictionSweep(nowMs: number): void {
  if (sweepTimer || known.size <= maxTrackedContacts) return;
  let earliest: number | null = null;
  for (const entry of known.values()) {
    if (entry.unconfirmed || entry.refusedAt === undefined) continue;
    if (earliest === null || entry.refusedAt < earliest)
      earliest = entry.refusedAt;
  }
  if (earliest === null) return;
  const delay = Math.max(0, earliest + refusalProtectionMs - nowMs) + 1;
  sweepTimer = setTimeout(() => {
    sweepTimer = undefined;
    evictOldestConfirmed(Date.now());
  }, delay);
  sweepTimer.unref?.();
}

// A refusal landed at or after `since`, so an allow from a check that started then is not newer than
// it. `>=` and not `>`: two events in the same millisecond cannot be ordered by this clock, and the
// side to take when they cannot is the refusal.
function refusedSince(key: GrantKey, since: number): boolean {
  const at = known.get(contactKey(key))?.refusedAt;
  return at !== undefined && at >= since;
}

export function hasUnconfirmedWrite(key: GrantKey): boolean {
  return known.get(contactKey(key))?.unconfirmed === true;
}

// Called by the gate on every check, under either mode. A no-op unless this process owes a delete
// for that contact.
export async function retryUnconfirmedWrite(
  base: PrismaClient,
  key: GrantKey,
  signal?: AbortSignal,
): Promise<void> {
  if (!hasUnconfirmedWrite(key)) return;
  // Under the caller's deadline, unlike the bookkeeping that follows a verdict: this one runs BEFORE
  // the answer, so a pool in trouble would otherwise hold the webhook for the scoped transaction's
  // own maxWait plus timeout on top of the gate's budget. Abandoning the wait leaves the contact
  // unconfirmed, which is where it already was.
  await dropContactAuthGrant(base, key, { signal });
}

// NOTE: Test isolation only; production clears an entry by finally landing the delete, or by the
// eviction above.
export function clearContactAuthGrantState(): void {
  known.clear();
  maxTrackedContacts = 10_000;
  refusalProtectionMs = CONTACT_AUTH_TIMEOUT_MAX_MS;
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = undefined;
}

export function unconfirmedWriteCount(): number {
  let n = 0;
  for (const entry of known.values()) if (entry.unconfirmed) n += 1;
  return n;
}

// `underSignal` where there is a deadline, the bare promise where there is not (a direct caller, a
// test). Only the READ takes one: it decides the answer, so the webhook has to be protected from a
// slow pool the same way it is protected from a slow endpoint. The statement itself keeps running
// when the wait is abandoned, which is why the two WRITES do not take one — see the header.
function underSignalMaybe<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  return signal ? underSignal(p, signal) : p;
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

// The fields that decide WHO answered and WHAT was asked. Not `enabled`, `denyMessage`, the handoff or
// the notice cooldown (nothing reads a grant with the gate off, and the rest act after a refusal). Not
// `mode` either: it decides who READS a grant, so grants survive a switch to `perMessage`, which is
// why a refusal drops them unconditionally. `credentialStamp` is IN the fingerprint rather than
// compared to the write time: a rotation between resolve and upsert would otherwise read as current.
export function contactAuthPolicyHash(
  cfg: ContactAuthConfig,
  credentialStamp?: string | null,
): string {
  return sha256([
    cfg.url,
    cfg.credentialRef,
    cfg.includeMessageText,
    cfg.grantTtlSeconds,
    credentialStamp ?? null,
  ]);
}

// The vault entry's revision, or a marker for a missing entry. Metadata only: this must never refresh
// a managed-OAuth token, which resolving would. A deleted credential gets its own stamp, not null, so
// its grants stop matching. Unreadable is a result, not a stamp: any constant for "the read failed"
// would repeat across blips and hide a rotation, so on that check grants are neither read nor written.
export type CredentialStamp =
  | { ok: true; stamp: string | null }
  | { ok: false };

export async function readCredentialStamp(
  base: PrismaClient,
  tenantId: bigint,
  ref: string | null,
  signal?: AbortSignal,
): Promise<CredentialStamp> {
  if (!ref) return { ok: true, stamp: null };
  // NOTE: the reader's parse, shared with every other resolver (readVaultRefId). It keeps the
  // lenient spellings a stored ref may already carry and refuses the one this `try` could not see:
  // an id past 2^63-1 CONVERTS, so the catch never ran and the value reached the `findUnique`
  // below as a bind error. A ref that names no entry stands as its own stamp, as before.
  const id = readVaultRefId(ref);
  if (id === null) return { ok: true, stamp: ref };
  try {
    const entry = await underSignalMaybe(
      runScopedOn(base, sysCtx(tenantId), (db) =>
        db.vaultEntry.findUnique({
          where: { id },
          select: { updatedAt: true },
        }),
      ),
      signal,
    );
    return {
      ok: true,
      stamp: entry ? String(entry.updatedAt.getTime()) : "missing",
    };
  } catch (err) {
    logger.warn(
      "contact-auth: the credential's revision could not be read, so no stored verdict is used on this check (tenant=%s): %s",
      String(tenantId),
      err instanceof Error ? err.message : String(err),
    );
    return { ok: false };
  }
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

// The stored verdict, or null when none still holds. Only READS: a row that does not hold is unusable
// anyway, and the verdict path owns removal. A second remover here would hide a missing
// drop-on-refusal, which is needed after a failed read is followed by an ask that refuses.
export async function readContactAuthGrant(
  base: PrismaClient,
  key: GrantKey,
  fingerprints: { identityHash: string; policyHash: string },
  opts: {
    signal?: AbortSignal;
    nowMs?: number;
    credentialRef?: string | null;
  } = {},
): Promise<{ context: AuthContext | null } | null> {
  // NOTE: not in the mutation queue. A refusal in flight is remembered before its delete and is seen
  // below; one landing after this read started is a true overlap either way, as for verdicts
  // themselves (docs/contact-auth.md). An unconfirmed write outranks anything on disk; the retry
  // belongs to the caller (`retryUnconfirmedWrite`), which runs under both modes.
  if (hasUnconfirmedWrite(key)) return null;
  try {
    const row = await underSignalMaybe(
      runScopedOn(base, sysCtx(key.tenantId), (db) =>
        db.contactAuthGrant.findUnique({
          where: whereKey(key),
          select: {
            identityHash: true,
            policyHash: true,
            context: true,
            expiresAt: true,
          },
        }),
      ),
      opts.signal,
    );
    if (!row) return null;
    // The clock is read AFTER the query, not before it: a row fetched just before its expiry and
    // handed back after it has expired, and the TTL is a promise about the moment the verdict is
    // SERVED. A test may pin the instant instead.
    const nowMs = opts.nowMs ?? Date.now();
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

// Every mutation of one contact's row runs alone, so checking the ordering rule and acting on it is one
// step: with an `await` between them, an allow that passed the check could still write after a newer
// refusal. One level only: queued bodies call the unqueued helpers, never each other's entry points,
// since taking the same key twice would wait forever.
function queuedForContact<T>(key: GrantKey, fn: () => Promise<T>): Promise<T> {
  return withKeyedQueue(`contact-auth-grant:${contactKey(key)}`, fn);
}

async function deleteRow(
  base: PrismaClient,
  key: GrantKey,
  signal?: AbortSignal,
): Promise<void> {
  await underSignalMaybe(
    runScopedOn(base, sysCtx(key.tenantId), (db) =>
      db.contactAuthGrant.deleteMany({
        where: {
          tenantId: key.tenantId,
          agentId: key.agentId,
          contactId: key.contactId,
        },
      }),
    ),
    signal,
  );
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
  opts: { nowMs?: number; askedAt?: number } = {},
): Promise<void> {
  await queuedForContact(key, async () => {
    const nowMs = opts.nowMs ?? Date.now();
    // An allow from a check that started before a refusal is not newer than that refusal, no matter
    // which of the two answers arrived last. Storing it would leave the contact served after the
    // endpoint said no, for the whole TTL. Nothing is written, and the row goes.
    if (opts.askedAt !== undefined && refusedSince(key, opts.askedAt)) {
      try {
        await deleteRow(base, key);
      } catch (err) {
        remember(key, { unconfirmed: true });
        logger.warn(
          "contact-auth: clearing a superseded grant failed (agent=%s): %s",
          String(key.agentId),
          err instanceof Error ? err.message : String(err),
        );
      }
      return;
    }
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
      // A write whose outcome this process does not know is not a write that did not happen: the
      // statement may have committed. Serving nothing for that contact until a delete lands is the
      // only honest reading of it.
      remember(key, { unconfirmed: true });
      logger.warn(
        "contact-auth: storing the grant failed, so nothing stored will be served for this contact until it is cleared (agent=%s): %s",
        String(key.agentId),
        err instanceof Error ? err.message : String(err),
      );
    }
  });
}

// Used on a fresh refusal, so a re-ask can only ever take a grant AWAY — under EVERY mode, not only
// under `once` (see the call site). It runs for a contact that may well have none, which is why it
// deletes by key instead of reading first.
export async function dropContactAuthGrant(
  base: PrismaClient,
  key: GrantKey,
  opts: { refusedAt?: number; signal?: AbortSignal } = {},
): Promise<void> {
  // NOTE: the queue holds the statement, the caller holds only its wait. An abandoned Prisma statement
  // still runs, so the slot stays taken until it settles, or a straggler could delete the next allow.
  // The refusal is remembered SYNCHRONOUSLY before queueing, since the unqueued stored-verdict read
  // consults the mark; only the DELETE waits its turn.
  remember(key, { refusedAt: opts.refusedAt, unconfirmed: true });
  const settled = queuedForContact(key, async () => {
    try {
      await deleteRow(base, key);
      remember(key, { unconfirmed: false });
    } catch (err) {
      // NOT swallowed, unlike the write above: this is the one that ENDS an authorization, so what
      // fails here stays remembered until it lands. `error` rather than `warn` for the same reason.
      logger.error(
        "contact-auth: a refusal could not be written down, so no stored verdict will be served for this contact until it is (agent=%s): %s",
        String(key.agentId),
        err instanceof Error ? err.message : String(err),
      );
    }
  });
  try {
    await underSignalMaybe(settled, opts.signal);
  } catch {
    // The deadline ran out while waiting. The contact stays unconfirmed until the statement settles,
    // which is the state the next check already knows how to handle, and the queue still holds the
    // slot — so nothing this caller does next can be undone by the straggler.
    logger.warn(
      "contact-auth: stopped waiting for a refusal's delete on the gate deadline (agent=%s)",
      String(key.agentId),
    );
  }
}
