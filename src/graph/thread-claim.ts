import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "./inflight";

// The DURABLE half of ./inflight.ts, for the one thread key that has a row to hang on.
//
// A LangGraph invoke is a read-modify-write of the WHOLE message channel: it saves the state it
// loaded plus its own messages, erasing anything that landed meanwhile. ./inflight.ts is what makes
// a turn and the three writers of that channel exclusive, and it is a `Map` in one process. On the
// topology docs/deploy.md §4 sanctions, extra web replicas with the workers off, one leader with
// them on, the turn runs wherever the webhook landed and continuous ingestion runs on the leader,
// so they hold different Maps and every writer reads a busy thread as free (issue #203).
//
// Of the three writers only ingestion's failure is irreversible: the append is undone AND the row
// records the message as ingested, so it is gone and marked handled. That is what this covers.
//
// WHY THE ROW IS `agent_threads` AND NOT A TABLE OF ITS OWN. Continuous ingestion only exists for a
// thread keyed by contact inbox (its params carry one), so the race that loses a message always has
// a row already. Both sides of it, the turn in ../graph/runtime.ts and the append in ./ingest.ts,
// already read that row inside the same critical section, so the durable read costs no query at all.
// The keys that have no such row (a thread resolved by CONVERSATION when the contact inbox is
// unknown, and the per-conversation key the follow-up nudge uses) stay in the Map, and their cost
// stays what issue #203 measured it to be: a nudge races one reply, a compaction is undone and
// re-armed at the next attendance boundary. Neither loses a message.
//
// THE LEASE IS NOT OPTIONAL. A crashed holder would otherwise strand the thread and every later
// append would defer forever, which is worse than the Map it replaces, a restart clears that one.
// Expiry lands on exactly the Map's behaviour (the writer proceeds), so this is never worse than
// today and better whenever the turn finishes inside the lease.
//
// AND NEITHER IS THE WRITE CLAIM. Marking alone only NARROWS the window, it does not close it: the
// append's check and its write are not one atomic step across processes, so an ingestion that read
// "free" can still land inside an invoke that marked itself and loaded the channel in between. The
// two sides therefore claim the same row against each other, and a starting turn waits out an append
// in flight. That wait is bounded by one `graph.updateState`, not by a model turn, which is what
// separates it from holding a lock for the length of a turn (the shape issue #203 rejects on cost).

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
// costs exactly today's behaviour.
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
        // and if none succeeds the lease expires, which is exactly the pre-renewal behaviour.
      });
  }, RENEW_EVERY_MS);
  // Never keep the process alive for a lease.
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

// The append's lease as milliseconds, or null when nothing holds it. Read so the wait above can tell
// a holder that is still working (the lease keeps moving) from one that stopped without releasing.
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

// Take the thread for this turn, durably, and mark the Map with it so a same-process reader that
// still asks the Map (the conversation key, ./inflight.ts) is never told less than the truth.
export async function markTurnOwning(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<TurnHold> {
  // Asked BEFORE this turn marks itself, or the answer is about this turn. The Map half still counts:
  // an invoke in THIS process may hold a key that has no row to hold (./inflight.ts), so a claim that
  // only reported what the row knew would report less than the registry it replaces.
  const alreadyHere = isTurnInFlight(owner.graphThreadId);
  markTurnInFlight(owner.graphThreadId);
  // WHAT THE WAIT IS MEASURED AGAINST. Not a fixed span from the moment this call started: the
  // append renews its own lease while it is alive, so a legitimate slow append would blow a fixed
  // deadline and fail a customer's turn for something that is not a failure. What has to run out is
  // the CLAIM, so the deadline restarts every time the lease moves forward, and only a lease that
  // stopped moving (a holder that is neither finishing nor renewing) ends the wait.
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
      // A row this call created cannot have had a previous holder.
      if (inserted !== null) {
        return renewing(owner, base, {
          epoch: inserted,
          heldBefore: alreadyHere,
        });
      }
      // The row exists and the update was refused, so an append is in flight. It holds the claim for
      // one checkpointer write, and says so by pushing the lease forward.
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
  // ONLY THE OCCUPANCY THIS TURN JOINED. A lease expires under a turn that is merely slow, and that
  // turn still reaches here: without the epoch it decrements a count that now belongs to a DIFFERENT
  // turn, zeroes it, and hands the thread to an append the newer invoke goes on to erase, which is
  // the exact loss this module exists to stop. A stale release matching nothing is the correct
  // outcome: the occupancy it belonged to was already ended by expiry.
  await runScopedOn(
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
  );
}

// Does ANY process have an invoke reading this thread's channel right now? The Map first, because a
// turn in this process is already known here and the answer costs nothing; the row second, for the
// replica that does not share it.
//
// AN UNREADABLE ANSWER IS "HELD", and that belongs here rather than at each call site. What this
// replaces was `isTurnInFlight`, a Map lookup that could not fail; every caller was written against
// a question that always answered, and each one uses the FALSE to act: /reset takes a conversation
// off a human with it, compaction rewrites the channel with it, and ingestion writes the divider
// with it. None of those may run on a guess. The true side costs a deferral the next attempt
// retries, and /reset is a command the operator can simply type again.
//
// Caught here and not at four call sites because the next caller is the one that would arrive
// without the guard. `turnOwnsThreadOn` keeps propagating: it runs on a transaction the caller
// already holds and inside a step that reports its own failure, so there the throw is the report.
export async function turnOwnsThread(
  owner: ThreadOwner,
  base: PrismaClient,
): Promise<boolean> {
  if (isTurnInFlight(owner.graphThreadId)) return true;
  try {
    return await runScopedOn(base, sysCtx(owner.tenantId), (db) =>
      turnOwnsThreadOn(db, owner),
    );
  } catch (err) {
    logger.warn(
      { err, thread: owner.graphThreadId },
      "could not read the durable turn claim; treating the thread as held",
    );
    return true;
  }
}

// The same question, asked on a transaction the caller ALREADY holds. A helper that opens its own
// transaction from inside one waits for a connection the outer one cannot release until it returns,
// and `DB_POOL_MAX=1` is a supported setting: measured, the nested transaction fails after 2047ms
// with "Unable to start a transaction in the given time". The rule is the one
// `revokeJobsByKeyPrefixOn` already follows.
export async function turnOwnsThreadOn(
  db: ScopedDb,
  owner: ThreadOwner,
): Promise<boolean> {
  if (isTurnInFlight(owner.graphThreadId)) return true;
  const rows = await db.$queryRaw<{ held: boolean }[]>`
    SELECT true AS held
      FROM agent_threads
     WHERE tenant_id = ${owner.tenantId}
       AND chatwoot_instance_id = ${owner.instanceId}
       AND contact_inbox_id = ${owner.contactInboxId}
       AND turn_holders > 0
       AND turn_held_until > now()`;
  return rows.length > 0;
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

// IS ANYONE AT ALL MID-WRITE ON THIS THREAD, asked by `/reset` and by nobody else. The two claims
// answer different questions and only this caller wants both: an append asks whether a TURN holds
// the channel (counting its own write claim would make it refuse itself), while a reset is about to
// delete the row and the checkpoint, so an append in flight is just as disqualifying as an invoke.
// Measured from the topology docs/deploy.md §4 sanctions: the append runs on the leader and the
// reset arrives on a web replica, so "no turn" said nothing about the append at all, and the reset
// went on to delete a checkpoint that a live append then wrote a watermark for.
//
// Locks the row for the rest of the caller's transaction, and creates one first when the thread has
// none, for the reason `ensureRowToLock` states.
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
//
//   "busy"      a turn owns it, or another append is mid-flight. The caller stands down with nothing
//               written: the message stays OWED, which is the whole point, because recording it as
//               handled and not having it is the loss this closes.
//   "claimed"   held on a row that already existed. Release it.
//   "created"   held on a row this call created, because the thread had none. Release it the same
//               way; the difference is what release does with a row nothing went on to write, which
//               is delete it (see `releaseIngestWrite`).
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
  // NO ROW YET, and that is not the same as protected. Leaving it unclaimed was the hole: a turn on
  // another replica inserts its own claim right after this read, loads the channel, and the append
  // lands inside the invoke exactly as it would have with no fence at all. It is the FIRST message
  // on a thread, which is the one case where the row does not exist yet.
  //
  // So the claim is taken by CREATING the row, held by this append alone (`ON CONFLICT DO NOTHING`
  // yields to whoever inserted first, and the caller reads that as busy). The row this creates
  // carries nothing but the claim: no watermark, no conversation, no remembered ids. That matters
  // because of what has to stay true afterwards, and `releaseIngestWrite` is where it is made true:
  // an append that ends up writing nothing (a job the operator revoked with /reset while it waited)
  // must leave no row behind either.
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
    // The row exists only because the claim needed something to hold. If the append went on to
    // write, the row now carries that write and stays; if it stood down (the message was already
    // known, or `/reset` revoked the job while it waited), deleting it is what keeps "an append that
    // writes nothing leaves nothing" true, including for the operator who was just told the thread
    // was cleared. Gated on the row's own emptiness AND on this claim's token, so neither a
    // concurrent writer's data nor a renewed claim is thrown away by a release that arrived late.
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
