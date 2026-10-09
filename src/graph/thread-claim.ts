import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { retryWhileTransactionNeverStarted } from "@/lib/pool-retry";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  clearTurnInFlight,
  isTurnInFlight,
  isTurnRunning,
  markTurnInFlight,
} from "./inflight";

// The DURABLE half of ./inflight.ts, for the thread key that has a row (`agent_threads`) to hang on.
// A LangGraph invoke saves the WHOLE message channel it loaded, erasing what landed meanwhile, and
// the `Map` in ./inflight.ts only excludes writers inside one process, while on the docs/deploy.md §4
// topology the turn and continuous ingestion run in different processes. Ingestion's loss is the
// irreversible one (the append is undone AND the row marks it ingested), so appends and turns claim
// the same row against each other. Keys with no row stay in the Map. Both leases renew while the
// holder lives, so expiry means a crash and lands on the Map's behaviour. Model: docs/graph.md, "Why the durable claim lives on `agent_threads`".

// What a turn got when it took the thread, and must hand back to release it. The epoch is null only
// when the claim could not be read back, which no path produces today; a null hold releases nothing,
// which is the safe direction.
export interface ThreadOwner {
  tenantId: bigint;
  instanceId: bigint;
  contactInboxId: number;
  // The graph thread id, needed only to CREATE the row: a turn can be the first thing that ever
  // touches this thread, and the claim cannot wait for the first append to make it a home.
  graphThreadId: string;
}

// Long enough for a model turn with tools, and the same order as the scheduler's own stale-claim
// window. Overshooting costs a deferred append (owed, then drained by the next reader); undershooting
// costs the Map's behaviour (the writer proceeds).
const TURN_LEASE_SECONDS = 300;
// One append: a checkpointer write and a short transaction. Nothing here waits on a model.
const WRITE_LEASE_SECONDS = 30;
// How long a starting turn waits out an append in flight. It is the WRITE LEASE plus slack, and not
// a shorter comfort bound, because of what the two outcomes are: an append whose claim is still live
// is still going to write, so starting the turn beside it is the erased-message case this module
// exists to stop, not a latency tradeoff. A claim that stops being renewed expires on its own, so
// the wait is finite without anyone forcing it; past that ceiling the append is neither alive nor
// expiring, which is a broken invariant rather than a slow turn, and the turn refuses instead of
// proceeding under it.
const WRITE_WAIT_MS = (WRITE_LEASE_SECONDS + 5) * 1_000;
const WRITE_POLL_MS = 25;

// A turn that waited the thread out and still landed on an occupancy: it gave the hold back and has
// to leave the `ingest:` queue before waiting again, which is a thing the section cannot say by
// returning its own result or null. Lives HERE, next to `waitForTurnToClear` and `turnWaitDeadline`,
// because the two callers that run this loop (the reactive turn and the proactive nudge) have to be
// provably the same vocabulary: a second sentinel meaning the same thing is how the two loops drift.
export const WAIT_AGAIN = Symbol("wait for the thread and try again");

// How long a second invoke waits out the first. ABSOLUTE from when the wait starts, unlike the
// bounds above: those wait on one checkpointer write, but a hung model call keeps its process
// renewing the lease, so a deadline reset on each renewal would never fire. One full lease plus
// slack, so a holder that stops renewing expires (and is taken over) before this runs out. PAST THE
// CEILING THE TURN JOINS rather than refusing: a direct turn that throws is settled with no retry
// (../modules/chatwoot/webhook.ts), so refusing means no answer at all. The ceiling stops the wait
// and logs it.
export const TURN_WAIT_MS = (TURN_LEASE_SECONDS + 5) * 1_000;
const TURN_POLL_MS = 50;

export interface TurnHold {
  epoch: bigint | null;
  // Whether another invoke was ALREADY reading this thread when this one acquired, answered by the
  // acquiring statement itself rather than by a read beside it.
  heldBefore: boolean;
  // Stops the lease renewal below. Set for every hold this module hands out.
  stopRenewal?: () => void;
}

// A LEASE THAT DOES NOT OUTLIVE THE WORK IT FENCES. 300 seconds is generous for one model call and
// far too short as a hard ceiling: a tool-heavy turn makes several, and the moment the lease lapses
// an append reads the thread as free, lands, and is erased by the invoke that never stopped running.
// Renewing while the invoke is alive is what makes the lease a CRASH recovery (the renewal stops
// with the process) instead of a timeout on legitimate work.
const RENEW_EVERY_MS = (TURN_LEASE_SECONDS / 3) * 1_000;

function renewing(
  owner: ThreadOwner,
  base: PrismaClient,
  hold: { epoch: bigint; heldBefore: boolean },
): TurnHold {
  const timer = setInterval(() => {
    void runScopedOn(
      base,
      sysCtx(owner.tenantId),
      (db) => db.$executeRaw`
        UPDATE agent_threads
           SET turn_held_until = now() + make_interval(secs => ${TURN_LEASE_SECONDS}),
               updated_at = now()
         WHERE tenant_id = ${owner.tenantId}
           AND chatwoot_instance_id = ${owner.instanceId}
           AND contact_inbox_id = ${owner.contactInboxId}
           AND turn_epoch = ${hold.epoch}
           AND turn_holders > 0`,
    )
      .then((rows) => {
        // NOTE: renewing nothing means this occupancy is over, by a release that already happened or
        // by an expiry that let someone else take the thread. Stop, rather than keep a timer and a
        // query running for a claim nobody holds: the release is the normal way out, and this is the
        // one that covers a caller who never reached it.
        if (rows === 0) clearInterval(timer);
      })
      .catch(() => {
        // NOTE: a renewal that fails is not worth failing the turn over. The next tick tries again,
        // and if none succeeds the lease expires, which is the crash-recovery path.
      });
  }, RENEW_EVERY_MS);
  // NOTE: never keep the process alive for a lease.
  timer.unref?.();
  return { ...hold, stopRenewal: () => clearInterval(timer) };
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Every predicate below reads the clock from POSTGRES, never from the process. The whole point of
// these columns is that the two sides run in different processes, and two hosts' clocks are exactly
// the thing that cannot be assumed equal.
// `held_before` answers "was another invoke ALREADY reading this thread", from the statement that
// took the claim rather than from a read beside it: two replicas starting together both read
// "nobody" before either acquires, and then both act as though they were alone on the channel.
// turn_holders is post-increment here, so > 1 means this acquisition JOINED an occupancy.
async function bumpTurnHolders(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<{ epoch: bigint; heldBefore: boolean } | null> {
  const rows = await runScopedOn(
    base,
    sysCtx(owner.tenantId),
    (db) => db.$queryRaw<{ turn_epoch: bigint; held_before: boolean }[]>`
      UPDATE agent_threads
         SET turn_holders = CASE
               WHEN turn_held_until IS NULL OR turn_held_until <= now() THEN 1
               ELSE turn_holders + 1
             END,
             turn_epoch = CASE
               WHEN turn_held_until IS NULL OR turn_held_until <= now() THEN turn_epoch + 1
               ELSE turn_epoch
             END,
             turn_held_until = now() + make_interval(secs => ${TURN_LEASE_SECONDS}),
             updated_at = now()
       WHERE tenant_id = ${owner.tenantId}
         AND chatwoot_instance_id = ${owner.instanceId}
         AND contact_inbox_id = ${owner.contactInboxId}
         AND (ingest_write_until IS NULL OR ingest_write_until <= now())
      RETURNING turn_epoch, turn_holders > 1 AS held_before`,
  );
  const row = rows[0];
  return row ? { epoch: row.turn_epoch, heldBefore: row.held_before } : null;
}

// The row may not exist yet, and "no row" is not "busy": nothing can own a thread nothing has
// touched. Written as an insert that yields to a concurrent one rather than as a read-then-insert,
// which would have the same cross-process hole this module exists to close.
async function insertHeldByTurn(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<bigint | null> {
  const rows = await runScopedOn(
    base,
    sysCtx(owner.tenantId),
    (db) => db.$queryRaw<{ turn_epoch: bigint }[]>`
      INSERT INTO agent_threads
        (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id,
         turn_holders, turn_epoch, turn_held_until, created_at, updated_at)
      VALUES
        (${owner.tenantId}, ${owner.instanceId}, ${owner.contactInboxId}, ${owner.graphThreadId},
         1, 1, now() + make_interval(secs => ${TURN_LEASE_SECONDS}), now(), now())
      ON CONFLICT (tenant_id, chatwoot_instance_id, contact_inbox_id) DO NOTHING
      RETURNING turn_epoch`,
  );
  return rows[0]?.turn_epoch ?? null;
}

// IS THE TURN LEASE STILL LIVE, ANSWERED BY POSTGRES. The lease is minted as `now() + interval` by
// the database, so a replica whose clock runs ahead would read a live lease as expired, acquire,
// and (since `bumpTurnHolders` renews unconditionally) push the lease of the holder it waits for:
// a two-second skew keeps a crashed holder alive indefinitely. `readTurnClaimOn` asks the same way.
async function turnLeaseIsLive(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<boolean> {
  const rows = await runScopedOn(
    base,
    sysCtx(owner.tenantId),
    (db) => db.$queryRaw<{ live: boolean }[]>`
      SELECT (turn_held_until IS NOT NULL AND turn_held_until > now()) AS live
        FROM agent_threads
       WHERE tenant_id = ${owner.tenantId}
         AND chatwoot_instance_id = ${owner.instanceId}
         AND contact_inbox_id = ${owner.contactInboxId}`,
  );
  // No row is not "busy": nothing can own a thread nothing has ever touched.
  return rows[0]?.live ?? false;
}

async function readWriteLease(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<number | null> {
  const rows = await runScopedOn(
    base,
    sysCtx(owner.tenantId),
    (db) => db.$queryRaw<{ ingest_write_until: Date | null }[]>`
      SELECT ingest_write_until
        FROM agent_threads
       WHERE tenant_id = ${owner.tenantId}
         AND chatwoot_instance_id = ${owner.instanceId}
         AND contact_inbox_id = ${owner.contactInboxId}`,
  );
  const until = rows[0]?.ingest_write_until ?? null;
  return until === null ? null : until.getTime();
}

// Take the thread for this turn, durably, and mark the Map with it so a same-process reader of the
// Map (the conversation key, ./inflight.ts) is never told less than the truth.
//
// IT ALWAYS JOINS: `clearTurnOwning` releases one holder at a time for the callers that legitimately
// overlap (an append beside a turn, a compaction reservation). A caller that DELIVERS to a customer
// must not join: it waits with `waitForTurnToClear` first, and gives the hold back to wait again if
// it still lands on an occupancy. That is BOTH turns: nobody waits on the proactive nudge, but either
// finishing order still erases a message the customer already saw or sent (docs/graph.md).
export async function markTurnOwning(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<TurnHold> {
  return acquireTurnHold(owner, base);
}

// WHEN A TURN THAT MUST NOT JOIN AN OCCUPANCY GIVES UP WAITING. The caller holds the deadline because
// the wait is not one call: the acquisition runs under the `ingest:` queue, this wait runs OUTSIDE
// it, and a caller that loses the acquiring race comes back here. One deadline across all attempts
// is the only bound that means anything.
export function turnWaitDeadline(): number {
  return Date.now() + TURN_WAIT_MS;
}

// WAIT FOR THE THREAD TO READ FREE, TAKING NOTHING. True when nobody is on it, false when `deadline`
// ran out and the caller should proceed beside whoever is (see TURN_WAIT_MS); never throws.
//
// IT ONLY READS. Acquiring to find out would RENEW the lease of the holder being waited for
// (`bumpTurnHolders` extends `turn_held_until` unconditionally), so a CRASHED holder would never
// expire and the thread would be stranded for good. Taking nothing also lets the caller wait outside
// the `ingest:` queue: holding it across the wait starves the previous turn's own rollback, which
// needs the same key after it releases the thread.
export async function waitForTurnToClear(
  owner: ThreadOwner,
  base: PrismaClient,
  deadline: number,
): Promise<boolean> {
  for (;;) {
    if (
      !isTurnRunning(owner.graphThreadId) &&
      !(await turnLeaseIsLive(owner, base))
    )
      return true;
    if (Date.now() >= deadline) {
      // NOTE: loud, because the only thing that reaches this line is a holder that goes on renewing
      // and never finishes, and nothing else in the system reports it.
      logger.warn(
        { thread: owner.graphThreadId, waitedMs: TURN_WAIT_MS },
        "a turn has held this thread past its lease without finishing; starting beside it rather than leaving the message unanswered",
      );
      return false;
    }
    await Bun.sleep(TURN_POLL_MS);
  }
}

async function acquireTurnHold(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<TurnHold> {
  // Asked BEFORE this turn marks itself, or the answer is about this turn. The Map half still
  // counts: an invoke in THIS process may hold a key that has no row (./inflight.ts). INVOKES only,
  // not reservations: a reservation is this very caller before it starts (a delivery recovery on its
  // way here), and counting it would defer the attendance divider and marker for its own turn.
  const alreadyHere = isTurnRunning(owner.graphThreadId);
  markTurnInFlight(owner.graphThreadId);
  // The wait runs against the CLAIM, not a fixed span: the append renews its lease while alive,
  // so a fixed deadline would fail a customer's turn over a legitimately slow append. The deadline
  // restarts whenever the lease moves, and only a lease that stopped moving ends the wait.
  let seenLease: number | null = null;
  let deadline = Date.now() + WRITE_WAIT_MS;
  try {
    for (;;) {
      const bumped = await bumpTurnHolders(owner, base);
      if (bumped !== null) {
        return renewing(owner, base, {
          epoch: bumped.epoch,
          heldBefore: alreadyHere || bumped.heldBefore,
        });
      }
      const inserted = await insertHeldByTurn(owner, base);
      // NOTE: a row this call created cannot have had a previous holder.
      if (inserted !== null) {
        return renewing(owner, base, {
          epoch: inserted,
          heldBefore: alreadyHere,
        });
      }
      // The row exists and the update was refused, so an append is in flight. It holds the claim
      // for one checkpointer write, and says so by pushing the lease forward.
      const lease = await readWriteLease(owner, base);
      if (lease !== null && lease !== seenLease) {
        seenLease = lease;
        deadline = Date.now() + WRITE_WAIT_MS;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `an append has held the write claim on ${owner.graphThreadId} past its lease without renewing it; refusing to start a turn under it`,
        );
      }
      await Bun.sleep(WRITE_POLL_MS);
    }
  } catch (err) {
    // NOTE: the local mark is taken FIRST and must not outlive a failed acquisition. Callers assign
    // their `graphOwner` only after this resolves, so their `finally` never runs for a throw in
    // here: the Map entry would then be permanent, and every Map-first reader (ingestion,
    // compaction) would defer on this thread until the process restarts. Strictly worse than the
    // registry this replaces, and from a path that never held anything.
    clearTurnInFlight(owner.graphThreadId);
    throw err;
  }
}

// Release ONE hold. Callers release exactly what they took, for the reason ./inflight.ts states: an
// unbalanced release hands the thread to a writer while another invoke is still reading it. The
// lease is cleared only at zero, so an overlapping turn keeps the thread held.
export async function clearTurnOwning(
  owner: ThreadOwner,
  base: PrismaClient,
  hold: TurnHold,
): Promise<void> {
  hold.stopRenewal?.();
  clearTurnInFlight(owner.graphThreadId);
  // NOTE: ONLY THE OCCUPANCY THIS TURN JOINED. A lease expires under a turn that is merely slow, and
  // that turn still reaches here: without the epoch it decrements a count that now belongs to a
  // DIFFERENT turn, zeroes it, and hands the thread to an append the newer invoke goes on to erase. A
  // stale release matching nothing is correct: its occupancy was already ended by expiry.
  // A pool momentarily full is retried: an UPDATE that never started decremented nothing, and a
  // lease left behind reads as a turn still running to every fence, for as long as it lasts.
  await retryWhileTransactionNeverStarted(
    () =>
      runScopedOn(
        base,
        sysCtx(owner.tenantId),
        (db) => db.$executeRaw`
      UPDATE agent_threads
         SET turn_holders = GREATEST(turn_holders - 1, 0),
             turn_held_until = CASE WHEN turn_holders - 1 <= 0 THEN NULL ELSE turn_held_until END,
             updated_at = now()
       WHERE tenant_id = ${owner.tenantId}
         AND chatwoot_instance_id = ${owner.instanceId}
         AND contact_inbox_id = ${owner.contactInboxId}
         AND turn_epoch = ${hold.epoch}`,
      ),
    { label: `turn claim release (${owner.graphThreadId})` },
  );
}

// Does ANY process have an invoke reading this thread's channel right now? The Map first (free for a
// turn in this process), the row second, for the replica that does not share it.
//
// AN UNREADABLE ANSWER IS "HELD", decided here rather than at each call site so a new caller cannot
// arrive without the guard. Every caller acts on FALSE (/reset takes a conversation off a human,
// compaction rewrites the channel, ingestion writes the divider) and none may run on a guess; TRUE
// costs a deferral the next attempt retries. `turnOwnsThreadOn` propagates instead: it runs on the
// caller's transaction inside a step that reports its own failure, so there the throw is the report.
export async function turnOwnsThread(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<boolean> {
  return (await readTurnClaim(owner, base)).held;
}

// WHAT THE ROW SAYS ABOUT THE CLAIM, one question more than `turnOwnsThread` projects. A caller that
// can RECOVER from a dead holder must tell "nobody has this" from "somebody's lease lapsed", which
// look identical through the boolean, so that the recovery can be logged. Expiry lands on the Map's
// behaviour (the writer proceeds), so the recovery grants no new permission.
export interface TurnClaimState {
  // Is an invoke reading this thread's channel right now, here or on another replica.
  held: boolean;
  // Holders the row still carries under a lease that has ALREADY lapsed: a process that died mid
  // turn. Zero whenever the claim is live, because then the holders are real and `held` reports them.
  staleHolders: number;
}

// The same read `turnOwnsThread` does, projected whole, and fail-closed the same way: an unreadable
// row answers "held" (see `turnOwnsThread`) and reports no stale holders, since a read that failed
// saw no lapsed lease either.
export async function readTurnClaim(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<TurnClaimState> {
  if (isTurnInFlight(owner.graphThreadId))
    return { held: true, staleHolders: 0 };
  try {
    return await runScopedOn(base, sysCtx(owner.tenantId), (db) =>
      readTurnClaimOn(db, owner),
    );
  } catch (err) {
    logger.warn(
      { err, thread: owner.graphThreadId },
      "could not read the durable turn claim; treating the thread as held",
    );
    return { held: true, staleHolders: 0 };
  }
}

// The same question, asked on a transaction the caller ALREADY holds. A helper that opens its own
// transaction from inside one waits for a connection the outer one cannot release, and under the
// supported `DB_POOL_MAX=1` the nested one fails ("Unable to start a transaction in the given
// time"). `revokeJobsByKeyPrefixOn` follows the same rule.
export async function turnOwnsThreadOn(
  db: ScopedDb,
  owner: ThreadOwner,
): Promise<boolean> {
  return (await readTurnClaimOn(db, owner)).held;
}

// ONE query behind both projections, so the liveness predicate cannot drift between the question
// "does anyone hold this" and the question "did somebody die holding it". The clock is Postgres's,
// like every other predicate here.
export async function readTurnClaimOn(
  db: ScopedDb,
  owner: ThreadOwner,
): Promise<TurnClaimState> {
  if (isTurnInFlight(owner.graphThreadId))
    return { held: true, staleHolders: 0 };
  const rows = await db.$queryRaw<{ holders: number; live: boolean }[]>`
    SELECT turn_holders AS holders,
           (turn_held_until IS NOT NULL AND turn_held_until > now()) AS live
      FROM agent_threads
     WHERE tenant_id = ${owner.tenantId}
       AND chatwoot_instance_id = ${owner.instanceId}
       AND contact_inbox_id = ${owner.contactInboxId}`;
  const row = rows[0];
  // No row is not "busy": nothing can own a thread nothing has ever touched.
  if (!row) return { held: false, staleHolders: 0 };
  const holders = Number(row.holders);
  return row.live
    ? { held: holders > 0, staleHolders: 0 }
    : { held: false, staleHolders: holders };
}

// A row to lock, even when the thread has none. `SELECT ... FOR UPDATE` locks the rows it MATCHES,
// so on a thread that was never touched it locks nothing and another replica is free to insert a
// claim while the caller believes it holds the thread. Inserting first gives the lock something to
// take, and the unique constraint is what a concurrent `insertHeldByTurn` then collides with. The
// row carries nothing but its identity: `/reset` deletes it moments later along with everything
// else.
async function ensureRowToLock(
  db: ScopedDb,
  owner: ThreadOwner,
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO agent_threads
      (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id, created_at, updated_at)
    VALUES
      (${owner.tenantId}, ${owner.instanceId}, ${owner.contactInboxId}, ${owner.graphThreadId},
       now(), now())
    ON CONFLICT (tenant_id, chatwoot_instance_id, contact_inbox_id) DO NOTHING`;
}

// IS ANYONE AT ALL MID-WRITE ON THIS THREAD, asked only by `/reset`. An append asks whether a TURN
// holds the channel (counting its own write claim would make it refuse itself); a reset deletes the
// row and the checkpoint, so an append in flight disqualifies it as much as an invoke does. On the
// docs/deploy.md §4 topology the append runs on the leader and the reset on a web replica, so a turn
// check alone says nothing about the append.
// Locks the row for the rest of the caller's transaction, creating one first when the thread has
// none (see `ensureRowToLock`).
export async function threadBusyForResetOn(
  db: ScopedDb,
  owner: ThreadOwner,
): Promise<boolean> {
  if (isTurnInFlight(owner.graphThreadId)) return true;
  await ensureRowToLock(db, owner);
  const rows = await db.$queryRaw<{ busy: boolean }[]>`
    SELECT (turn_holders > 0 AND turn_held_until > now())
        OR (ingest_write_until IS NOT NULL AND ingest_write_until > now()) AS busy
      FROM agent_threads
     WHERE tenant_id = ${owner.tenantId}
       AND chatwoot_instance_id = ${owner.instanceId}
       AND contact_inbox_id = ${owner.contactInboxId}
       FOR UPDATE`;
  return rows.some((r) => r.busy);
}

// Take the thread for ONE append.
//   "busy"     a turn owns it or another append is mid-flight. Nothing is written and the message
//              stays OWED, since recording it as handled without having it is the loss this closes.
//   "claimed"  held on a row that already existed.
//   "created"  held on a row this call created; the release deletes it if nothing went on to write
//              (see `releaseIngestWrite`).
export type IngestWriteState = "claimed" | "created" | "busy";

// The claim, plus the token that proves it. Same reason the turn side carries an epoch: a write
// lease can expire under an append that is merely slow, a second process renews it, and the first
// one then reaches its release and clears a claim it no longer owns, letting a turn start inside the
// newer append. `null` on "busy", where nothing was taken.
export interface IngestWriteClaim {
  state: IngestWriteState;
  token: string | null;
  // Stops the write-lease renewal, exactly as `TurnHold.stopRenewal` does for a turn.
  stopRenewal?: () => void;
}

// The write lease renews for the same reason the turn lease does: 30 seconds is generous for one
// checkpointer write and is not a ceiling anyone can promise. A database that stalls past it would
// otherwise let a turn start beside an append that is still going to write, which is the erased
// message this module exists to stop. Renewal stops with the process, so the lease keeps meaning
// "the holder is gone" rather than "the holder was slow".
const RENEW_WRITE_EVERY_MS = (WRITE_LEASE_SECONDS / 3) * 1_000;

function renewingWrite(
  owner: ThreadOwner,
  base: PrismaClient,
  claim: { state: IngestWriteState; token: string },
): IngestWriteClaim {
  const timer = setInterval(() => {
    void runScopedOn(
      base,
      sysCtx(owner.tenantId),
      (db) => db.$executeRaw`
        UPDATE agent_threads
           SET ingest_write_until = now() + make_interval(secs => ${WRITE_LEASE_SECONDS}),
               updated_at = now()
         WHERE tenant_id = ${owner.tenantId}
           AND chatwoot_instance_id = ${owner.instanceId}
           AND contact_inbox_id = ${owner.contactInboxId}
           AND ingest_write_token = ${claim.token}`,
    )
      .then((rows) => {
        // NOTE: renewing nothing means this claim is over, by a release or by an expiry that let
        // someone else take it. Stop, instead of leaving a timer and a query behind.
        if (rows === 0) clearInterval(timer);
      })
      .catch(() => {
        // NOTE: same as the turn lease: a failed renewal is not worth failing the append over.
      });
  }, RENEW_WRITE_EVERY_MS);
  timer.unref?.();
  return { ...claim, stopRenewal: () => clearInterval(timer) };
}

export async function claimIngestWrite(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<IngestWriteClaim> {
  if (isTurnInFlight(owner.graphThreadId))
    return { state: "busy", token: null };
  const token = crypto.randomUUID();
  const updated = await runScopedOn(
    base,
    sysCtx(owner.tenantId),
    (db) => db.$executeRaw`
      UPDATE agent_threads
         SET ingest_write_until = now() + make_interval(secs => ${WRITE_LEASE_SECONDS}),
             ingest_write_token = ${token},
             updated_at = now()
       WHERE tenant_id = ${owner.tenantId}
         AND chatwoot_instance_id = ${owner.instanceId}
         AND contact_inbox_id = ${owner.contactInboxId}
         AND (turn_holders = 0 OR turn_held_until IS NULL OR turn_held_until <= now())
         AND (ingest_write_until IS NULL OR ingest_write_until <= now())`,
  );
  if (updated > 0)
    return renewingWrite(owner, base, { state: "claimed", token });
  // No row yet is not protected: a turn on another replica could insert its claim right after
  // this read and load the channel under the append (the FIRST message on a thread). So the claim is
  // taken by CREATING the row, held by this append alone (`ON CONFLICT DO NOTHING` yields to the
  // first inserter, read as busy). The row carries only the claim, so `releaseIngestWrite` can delete
  // it when the append ends up writing nothing (a job /reset revoked while it waited).
  const created = await runScopedOn(
    base,
    sysCtx(owner.tenantId),
    (db) => db.$executeRaw`
      INSERT INTO agent_threads
        (tenant_id, chatwoot_instance_id, contact_inbox_id, thread_id,
         ingest_write_until, ingest_write_token, created_at, updated_at)
      VALUES
        (${owner.tenantId}, ${owner.instanceId}, ${owner.contactInboxId}, ${owner.graphThreadId},
         now() + make_interval(secs => ${WRITE_LEASE_SECONDS}), ${token}, now(), now())
      ON CONFLICT (tenant_id, chatwoot_instance_id, contact_inbox_id) DO NOTHING`,
  );
  return created > 0
    ? renewingWrite(owner, base, { state: "created", token })
    : { state: "busy", token: null };
}

export async function releaseIngestWrite(
  owner: ThreadOwner,
  base: PrismaClient,
  claim: IngestWriteClaim,
): Promise<void> {
  claim.stopRenewal?.();
  if (claim.token === null) return;
  if (claim.state === "created") {
    // The row exists only because the claim needed something to hold. If the append wrote, the
    // row carries that write and stays; if it stood down (message already known, or `/reset` revoked
    // the job), deleting it keeps "an append that writes nothing leaves nothing" true. Gated on the
    // row's emptiness AND this claim's token, so a late release throws away neither a concurrent
    // writer's data nor a renewed claim.
    const deleted = await runScopedOn(
      base,
      sysCtx(owner.tenantId),
      (db) => db.$executeRaw`
        DELETE FROM agent_threads
         WHERE tenant_id = ${owner.tenantId}
           AND chatwoot_instance_id = ${owner.instanceId}
           AND contact_inbox_id = ${owner.contactInboxId}
           AND ingest_write_token = ${claim.token}
           AND turn_holders = 0
           AND last_conversation_id IS NULL
           AND last_synced_message_id IS NULL
           AND last_agent_message_id IS NULL
           AND cardinality(recent_synced_message_ids) = 0
           AND cardinality(recent_agent_message_ids) = 0`,
    );
    if (deleted > 0) return;
  }
  await runScopedOn(
    base,
    sysCtx(owner.tenantId),
    (db) => db.$executeRaw`
      UPDATE agent_threads
         SET ingest_write_until = NULL, ingest_write_token = NULL, updated_at = now()
       WHERE tenant_id = ${owner.tenantId}
         AND chatwoot_instance_id = ${owner.instanceId}
         AND contact_inbox_id = ${owner.contactInboxId}
         AND ingest_write_token = ${claim.token}`,
  );
}
