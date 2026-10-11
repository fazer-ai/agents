import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";

// Whether a server process is alive, said so another process can read it: one `process_leases` row
// per process, renewed on a short cadence, named by the claims it makes (`claimed_by`). A lapsed or
// missing lease is a process that will not finish what it claimed. The time is the database's on both
// sides (`now()`), so clock skew between hosts plays no part. Model: docs/chatwoot.md, "Webhook
// receiver".

// The holder lives on globalThis, like the shutdown registry, so `bun --hot` keeps one identity.

// How often the lease is renewed.
export const LEASE_RENEW_MS = 10_000;
// How long a lease outlives its last renewal. Six renewals: one missed renewal (a full pool, a GC
// pause) is not a death, and what a false death costs is a recovery armed beside a live turn, which
// the recovery's own thread fence defers but cannot always stop (docs/chatwoot.md, "Webhook
// receiver"). What it bounds is how long a dead process's claims wait.
export const LEASE_TTL_MS = 60_000;
// A claim is stamped only while the last renewal is younger than this. A process whose renewals
// have been failing may already be read as dead by another one, and a claim it stamps then could be
// taken while it works on it; unstamped, the claim keeps the 30-minute window instead.
const STAMP_FRESHNESS_MS = LEASE_TTL_MS / 2;
// Lapsed leases are deleted after this. A claim naming a deleted lease reads as dead, the same answer
// a lapsed one gives, so the deletion changes nothing but the table's size.
const LEASE_RETENTION_MS = 60 * 60 * 1000;

interface Holder {
  id: string;
  base: PrismaClient | null;
  timer: ReturnType<typeof setInterval> | null;
  // `performance.now()` of the last renewal that committed; null until the first one.
  lastRenewedAt: number | null;
  // The renewal on the wire, if any: one at a time, and the release waits for it before deleting.
  inflight: Promise<void> | null;
}

const KEY = Symbol.for("fazerai.processLease");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= {
    id: randomUUID(),
    base: null,
    timer: null,
    lastRenewedAt: null,
    inflight: null,
  };
  return g[KEY];
}

// What a claim made right now records as its claimer: this process's lease id while the lease is
// established and fresh, null otherwise. Null is the safe direction: an unstamped claim is never taken
// early, it waits for the stranded sweep like every claim an older build made.
export function claimingProcessId(
  now: number = performance.now(),
): string | null {
  const h = holder();
  if (h.timer === null || h.lastRenewedAt === null) return null;
  return now - h.lastRenewedAt < STAMP_FRESHNESS_MS ? h.id : null;
}

// This process's lease id, whether or not it is established: the dead-claim pass never takes its own
// process's claims, which are alive by definition while it runs.
export function processLeaseId(): string {
  return holder().id;
}

async function renew(base: PrismaClient, id: string): Promise<void> {
  await base.$executeRaw`
    INSERT INTO process_leases (id, started_at, heartbeat_at, host, pid)
    VALUES (${id}::uuid, now(), now(), ${hostname()}, ${process.pid})
    ON CONFLICT (id) DO UPDATE SET heartbeat_at = now()`;
}

function renewAndRecord(h: Holder): Promise<void> {
  if (h.inflight !== null) return h.inflight;
  const p = renewOnce(h).finally(() => {
    if (h.inflight === p) h.inflight = null;
  });
  h.inflight = p;
  return p;
}

async function renewOnce(h: Holder): Promise<void> {
  if (h.base === null) return;
  const before = h.lastRenewedAt;
  try {
    await renew(h.base, h.id);
  } catch (err) {
    logger.warn(
      { err },
      "process lease: renewal failed; deliveries claimed from now on are left to the 30-minute stranded sweep until a renewal commits",
    );
    return;
  }
  const at = performance.now();
  if (before !== null && at - before >= LEASE_TTL_MS) {
    // NOTE: `error`: for that long another process may have read this one as dead and handed the
    // deliveries it was working to the recovery, which can then answer a customer this process is
    // still answering.
    logger.error(
      "process lease: no renewal committed for %ds, past the %ds lease; another process may have settled deliveries this one was still processing",
      Math.round((at - before) / 1000),
      LEASE_TTL_MS / 1000,
    );
  }
  h.lastRenewedAt = at;
}

// Writes this process's lease and keeps renewing it. Resolves after the first attempt, committed or
// not; until one commits, claims are not stamped. Idempotent.
export async function startProcessLease(
  base: PrismaClient,
  renewMs: number = LEASE_RENEW_MS,
): Promise<void> {
  const h = holder();
  if (h.timer !== null) return;
  h.base = base;
  h.timer = setInterval(() => void renewAndRecord(h), renewMs);
  h.timer.unref?.();
  await renewAndRecord(h);
}

// Stops renewing and deletes the lease, so the claims this process leaves behind are settled by the
// next pass of any other process instead of a lease's lifetime later. Called last on the way out,
// after the drain: from here nothing this process claimed will finish. Bounded, because the exit
// must not wait on a database that is gone; a deletion that does not land leaves the lease to lapse.
export async function releaseProcessLease(boundMs = 1_000): Promise<void> {
  const h = holder();
  if (h.timer !== null) clearInterval(h.timer);
  h.timer = null;
  const base = h.base;
  h.base = null;
  h.lastRenewedAt = null;
  if (base === null) return;
  const id = h.id;
  // A renewal already on the wire would otherwise land after the deletion and write the lease back,
  // and every other process would wait out its whole lifetime for what this one leaves behind.
  const pending = h.inflight ?? Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    pending
      .then(
        () =>
          base.$executeRaw`DELETE FROM process_leases WHERE id = ${id}::uuid`,
      )
      .catch((err: unknown) => {
        logger.warn(
          { err },
          "process lease: could not delete the lease on exit; it lapses on its own",
        );
      }),
    new Promise((resolve) => {
      timer = setTimeout(resolve, boundMs);
    }),
  ]);
  clearTimeout(timer);
}

// Deletes leases lapsed longer than the retention. Best-effort housekeeping for the dead-claim pass.
export async function pruneProcessLeases(base: PrismaClient): Promise<void> {
  await base.$executeRaw`
    DELETE FROM process_leases
     WHERE heartbeat_at < now() - make_interval(secs => ${LEASE_RETENTION_MS / 1000})`;
}

// Tests: back to a process that never started a lease, with a new identity.
export function resetProcessLeaseForTest(): void {
  const h = holder();
  if (h.timer !== null) clearInterval(h.timer);
  h.id = randomUUID();
  h.base = null;
  h.timer = null;
  h.lastRenewedAt = null;
  h.inflight = null;
}
