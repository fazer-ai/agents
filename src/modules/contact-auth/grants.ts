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
//             asked, and for how long the answer counts.
//
// The policy half is a MATCH rule and not a revocation, and the difference is worth being precise
// about because it is easy to sell as one. A grant counts while the policy it was given under is the
// policy in force; change a field and it stops counting, restore that field inside the TTL and it
// counts again, because it is once more the answer to the question being asked. Nothing here is
// monotonic, so "nudge the TTL to clear the grants" is NOT a lever — it clears them for exactly as
// long as the nudge stands. What actually ends reuse for good is the TTL elapsing, the identity
// moving, a refusal, or `mode: "perMessage"`, under which no grant is read at all.
//
// Both directions here are best-effort by construction: a grant is an optimization on top of a
// verdict that already stands, so a database that refuses the read costs an extra call to the
// endpoint, and one that refuses the write costs the same on the next message. Neither may turn an
// answered check into a failed one.
//
// THE WHOLE RULE, IN ONE PLACE, because it took four review rounds to stop stating it in pieces. A
// stored grant is served if and only if, at read time:
//
//   1. it has not expired                          — time, and the operator chose the budget;
//   2. it matches the identity in force             — a MATCH rule, not a revocation;
//   3. it matches the policy in force               — likewise;
//      The policy fingerprint carries the CREDENTIAL'S own revision, because `credentialRef` is a
//      stable id that survives a rotation and a deletion alike, and a gate whose key was removed
//      must not go on serving from a verdict obtained with it. That is the one rule that costs a
//      second read;
//   4. this process holds no unconfirmed write about that contact — fail-closed.
//
// And it is removed only by a refusal, or by the verdict that replaces it. Nothing else "drops" a
// grant: 2 and 3 are questions, so a fingerprint that stops matching stops SERVING, and a value put
// back matches again. Writing those as revocations is what produced two rounds of findings against
// claims the code never made.
//
// The DELETE is the one write that ENDS an authorization, so it alone is not best-effort: a failure
// is remembered, and while it stands nothing stored is served for that contact.
//
// WHAT THE DEADLINE COVERS, and why the bookkeeping is not in it. The caller's `timeoutMs` bounds
// everything that decides the ANSWER, the stored-verdict read included: a saturated pool holds the
// webhook exactly as a slow endpoint does. The write and the delete run AFTER the answer, and they
// are awaited without it — walking away from a Prisma statement does not stop it, so an abandoned
// upsert can commit after a later refusal deleted the row and revive an authorization the endpoint
// has withdrawn. A write nobody waits for is a write nobody can order. What they cost instead is one
// indexed single-statement transaction on the way out, and a failure or a timeout there marks the
// contact unconfirmed, which the next check settles by deleting first.
//
// THE ORDERING IS ASYMMETRIC ON PURPOSE. An allow never survives a refusal, and a refusal may cost a
// newer allow its row: the delete is unconditional, and the row carries no record of WHICH check
// produced it, so an older refusal landing after a newer allow takes that grant with it. Both halves
// are the same choice made twice — when two overlapping checks cannot be ordered from what is on
// disk, the side taken is the one that asks the endpoint again. What the asymmetry costs is one
// extra call after an overlap (an unlock that just succeeded is re-asked, and answered yes again);
// what the other direction would cost is a contact served after a refusal, for the whole TTL.
// Closing it symmetrically means storing the deciding check's instant on the row and making the
// delete conditional on it, which is a protocol rather than a guard, for a symptom measured in one
// endpoint call.
//
// The residual, stated rather than papered over: two checks that overlap in time can still interleave
// their writes, and the bound on that is the TTL the operator chose — the same bound the mode already
// carries for a revocation, and the same stance docs/contact-auth.md takes for verdicts themselves
// ("the runtime does not serialise").

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// WHAT THIS PROCESS KNOWS THAT THE TABLE CANNOT SAY. Memory only, like the notice cooldown in
// ./state.ts and for the same reason: what it protects is a decision the next check re-derives, and
// losing it on a restart costs a stale grant the TTL still bounds, never a wrong refusal. Two facts
// per contact, each closing a hole the other does not:
//
//   refusedAt    WHEN a refusal last landed. A check that started before it may still be in flight,
//                and an allow it comes back with is older than that refusal however late it arrives.
//                Two concurrent asks for one contact are ordinary — an unlock message and the next
//                one carry different request keys, so single-flight does not coalesce them.
//   unconfirmed  a bookkeeping write this process could not confirm: a DELETE that failed, or an
//                UPSERT that did. While it stands nothing stored is served for that contact, and the
//                next check of ANY mode deletes first (`perMessage` reads no grants, so a retry that
//                lived on the read path would never run for the mode where refusals usually happen).
//
// Bounded twice like the notice store: the entries are ids and timestamps, but a flood of failures
// must not grow memory without end. Insertion-ordered eviction drops the oldest, whose contact has
// been quiet longest.
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

// The cap protects against a flood of ORDINARY entries, and two kinds here are not ordinary:
//
//   - an UNCONFIRMED entry is a delete this process still owes, and dropping it silently drops the
//     only thing that stops a refused contact being served from the row its refusal failed to
//     remove;
//   - a RECENT refusal may still have an older check in flight against it. A check cannot outlive
//     its own budget, and that budget is clamped at CONTACT_AUTH_TIMEOUT_MAX_MS, so a refusal older
//     than that window can no longer be the one an unfinished allow has to lose to. Younger than it,
//     evicting the marker lets that allow pass `refusedSince` and store a grant for the full TTL.
//
// So eviction walks past both. What is left unbounded is a flood of ten thousand refusals inside ten
// seconds, which drains by itself as those entries age past the window.
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

// The fields that decide WHO answered and WHAT was asked. `enabled` is not one of them: with the
// gate off nothing reads a grant at all. `denyMessage`, the handoff and the notice cooldown are not
// either — they are what happens AFTER a refusal, and a grant is only ever written for an allow.
//
// `mode` is not one of them either, and that one is a decision rather than an omission: it decides
// who READS a grant, not who answered it, so grants survive a switch to `perMessage` (which is what
// makes the unconditional drop-on-refusal at the call site necessary).
//
// `credentialStamp` is the vault entry's own revision, read at the start of the check (see
// `readCredentialStamp`). It is IN the fingerprint rather than compared against the grant's write
// time, and the difference is a race: a rotation landing between the resolve and the upsert leaves
// the row written AFTER the rotation, so a comparison of instants reads it as current, while a
// fingerprint built from the stamp this check actually used simply stops matching the next one.
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

// The vault entry's revision, or the marker for one that is not there. Metadata only: deciding
// whether a stored verdict still counts must never refresh a managed-OAuth token, which resolving
// the credential would. A missing entry deliberately produces a stamp of its own rather than null,
// so a grant obtained with a credential that has since been deleted stops matching instead of
// matching the shape of an agent that never had one.
//
// UNREADABLE IS NOT A STAMP, and that is why this returns a result rather than a string. Any
// constant standing in for "the read failed" is a fingerprint that REPEATS: a grant stored during
// one blip matches a check made during the next, and a rotation between the two goes unnoticed. So
// unreadable means grants are not used at all on that check — neither read nor written.
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
  opts: {
    signal?: AbortSignal;
    nowMs?: number;
    credentialRef?: string | null;
  } = {},
): Promise<{ context: AuthContext | null } | null> {
  // NOT in the mutation queue, deliberately. A refusal that is IN FLIGHT is already covered — it is
  // remembered before its delete is attempted, and the check below sees that. What a queue would add
  // is ordering against a refusal that lands after this read started, and that is a different rule
  // from the one this module makes: a check in flight is not invalidated by a verdict that lands
  // during it (docs/contact-auth.md says as much about verdicts themselves), because "the read came
  // first" and "the refusal came first" are both true readings of the same overlap. Serializing does
  // not settle it, it only moves which side of the boundary the read falls on — measured, by
  // reverting the queue here and watching every test still pass.
  //
  // A write this process could not confirm outranks anything on disk. The retry belongs to the
  // caller (`retryUnconfirmedWrite`), which runs under both modes; what belongs here is refusing to
  // serve a row while one stands.
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

// EVERY MUTATION OF ONE CONTACT'S ROW RUNS ALONE. What made the ordering rule below leak was never
// the rule, it was that reading it and acting on it were two steps with an `await` between them: a
// refusal could be remembered in that gap, or its delete could land in it, and the allow that had
// already passed the check went on to write anyway. Inside one queue per contact the check and the
// write are one step, which is the only shape that makes "an older allow does not survive a newer
// refusal" true rather than usually true.
//
// One level only: the queued bodies below call the unqueued helpers, never each other's public
// entry points, because taking the same key twice would wait for a link that cannot resolve.
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
  // THE QUEUE HOLDS THE STATEMENT, THE CALLER HOLDS ONLY ITS WAIT. Walking away from a Prisma
  // statement does not stop it, so a delete abandoned on the deadline is still on its way to the
  // database. Released from the queue at that moment, the next message's allow can be stored and
  // then deleted by that straggler, which costs an endpoint call it should not have had to make.
  // The signal therefore bounds what the CALLER waits for, and nothing else: the slot stays taken
  // until the statement settles.
  // Remembered SYNCHRONOUSLY, before the queue is even entered. The mark is what an unqueued reader
  // (the stored-verdict read) consults, and a refusal that waits its turn behind another mutation is
  // a refusal nobody can see for as long as that turn takes — which is exactly the window a
  // concurrent check needs to serve the row this refusal is about to remove. The DELETE stays
  // serialized; only the fact of the refusal jumps the queue, and it is an assignment.
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
