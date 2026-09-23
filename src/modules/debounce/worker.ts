import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import { asSuperAdminOn } from "@/lib/tenancy";
import { emitCapacityWait } from "@/modules/flowlog/capacity";
import {
  claimDueDebounceJobs,
  findWaitingDebounceJobs,
  type WaitingDebounceJob,
} from "@/modules/scheduler/service";
import { runClaimed } from "@/modules/scheduler/worker";
import { debounceDedupeKey } from "./service";

// Dedicated FAST drain for DEBOUNCE jobs only (inbound message coalescing). Kept separate from the
// scheduler so the per-agent debounce window (seconds) is honored without running the reaper/sweep at
// that cadence; the scheduler's reaper still re-pends a stranded CLAIMED debounce job. Same single-
// replica discipline as the other workers (globalThis singleton survives `bun --hot`). The claim uses
// FOR UPDATE SKIP LOCKED, so it is still correct if briefly doubled.
//
// SLOTS, NOT BATCHES (issue #807). The lane holds at most `slots` jobs in flight, and every tick
// fills only the slots that are free, without waiting for any job it started. It used to claim a
// batch and await the whole of it before the next tick could claim, so the slowest job of a batch
// held every tenant's replies: measured, one model call that took 5 min 36 s left four other
// conversations due and unclaimed for up to 6 minutes, and a burst on one agent moved another
// agent's first reply from ~75 s to 291 s with 1 to 3 model calls in flight against a budget of 20.
//
// The lane is sized by the model semaphore (config.agent.modelConcurrency), which stays the only
// throttle on model calls: fewer slots would cap the lane below what the operator configured, and
// more would leave claimed rows waiting for a permit while the reaper's stale window runs on them.

// The rows this process is executing RIGHT NOW, kept out of the claim itself. Without the batch
// barrier a row can become claimable while its own run is still in flight, by two production
// roads: a message arriving during the flush re-arms the SAME row back to PENDING (armDebounce's
// upsert), and a run longer than the reaper's stale window is re-pended by the reaper. Either one
// claimed again would run the same flush twice at once. Per-process, which is what this worker is
// by construction (single replica, globalThis singleton).
const inFlight = new Set<bigint>();

// WHEN THE LANE IS FULL, WHO IS WAITING FOR IT (issue #812). A due flush with no free slot waits for
// the instance, not for its model, and nothing said so: replies got slower and the logs were silent.
// Every tick that ends with the lane full asks which due rows are still unclaimed, and a row that has
// waited past `config.agent.capacityWaitAlertMs` is announced once, while it is still waiting.
//
// The wait is counted from the later of the row's `run_at` and the moment this process saw the lane
// fill. A row that was already overdue when the lane filled waited on something else (a restart, a
// stopped worker, the deploy in between), and blaming the lane for it would page the operator about
// capacity on every deploy. A tick that finds room and claims less than it could ends the
// saturation: whatever is due fitted, so nothing is waiting, and the next one measures from scratch.
//
// Both are per process, like the in-flight set above.
const lane: {
  fullSince: number | null;
  announced: Set<bigint>;
  asking: boolean;
} = {
  fullSince: null,
  announced: new Set(),
  asking: false,
};

// A row announced as waiting for a slot. `waitedMs` is measured when it is announced, so it is at
// least the threshold and not the whole wait.
export interface LaneWait {
  jobId: bigint;
  tenantId: bigint;
  dedupeKey: string;
  waitedMs: number;
  thresholdMs: number;
}

// `claim`/`run` are injectable so the drain can be tested without a DB or Chatwoot, and so are the
// clock, the question "who is waiting" and the announcement; production uses the defaults.
export interface DebounceTickDeps {
  claim?: typeof claimDueDebounceJobs;
  run?: typeof runClaimed;
  now?: () => Date;
  waiting?: (
    dueBefore: Date,
    excludeIds: bigint[],
    base: PrismaClient,
  ) => Promise<WaitingDebounceJob[]>;
  announce?: (wait: LaneWait, base: PrismaClient) => void | Promise<void>;
}

// The production announcement: the `capacity` line on the conversation the row flushes, so it lands
// on the delayed customer's own tenant and conversation, not on whoever holds the slot.
async function announceLaneWait(
  wait: LaneWait,
  base: PrismaClient,
): Promise<void> {
  const prefix = debounceDedupeKey("");
  const threadId = wait.dedupeKey.startsWith(prefix)
    ? wait.dedupeKey.slice(prefix.length)
    : null;
  const conversation = threadId
    ? await asSuperAdminOn(base, (db) =>
        db.conversation.findFirst({
          where: { tenantId: wait.tenantId, threadId },
          select: {
            id: true,
            inboxId: true,
            inbox: { select: { agentId: true } },
          },
        }),
      )
    : null;
  emitCapacityWait(
    {
      tenantId: wait.tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: conversation?.id ?? null,
      inboxId: conversation?.inboxId ?? null,
      agentId: conversation?.inbox?.agentId ?? null,
      threadId,
      base,
    },
    "debounce_lane",
    wait,
    { jobId: String(wait.jobId) },
  );
}

async function announceWaiting(
  base: PrismaClient,
  now: number,
  deps: DebounceTickDeps,
): Promise<void> {
  const fullSince = lane.fullSince;
  const thresholdMs = config.agent.capacityWaitAlertMs;
  if (fullSince === null || now - fullSince < thresholdMs) return;
  const waiting = deps.waiting ?? findWaitingDebounceJobs;
  const announce = deps.announce ?? announceLaneWait;
  const rows = await waiting(
    new Date(now - thresholdMs),
    [...inFlight, ...lane.announced],
    base,
  );
  const announcements: Array<void | Promise<void>> = [];
  for (const row of rows) {
    const waitedMs = now - Math.max(row.runAt.getTime(), fullSince);
    if (waitedMs < thresholdMs || lane.announced.has(row.id)) continue;
    lane.announced.add(row.id);
    announcements.push(
      (async () =>
        announce(
          {
            jobId: row.id,
            tenantId: row.tenantId,
            dedupeKey: row.dedupeKey,
            waitedMs,
            thresholdMs,
          },
          base,
        ))(),
    );
  }
  for (const result of await Promise.allSettled(announcements)) {
    if (result.status === "rejected")
      logger.warn(
        { err: result.reason },
        "debounce lane: announcing a capacity wait failed",
      );
  }
}

// Claims up to the free slots and starts the jobs, and returns as soon as they are STARTED.
// `settled` resolves when every job this tick started has finished; the worker never waits on it,
// tests do.
export async function runDebounceTick(
  base: PrismaClient,
  slots: number,
  deps: DebounceTickDeps = {},
): Promise<{
  claimed: number;
  settled: Promise<void>;
  reported: Promise<void>;
}> {
  const claim = deps.claim ?? claimDueDebounceJobs;
  const run = deps.run ?? runClaimed;
  const now = deps.now?.() ?? new Date();
  const free = slots - inFlight.size;
  // NOTE: not a claim of zero. claimWhere clamps its limit to at least 1, so asking with a full
  // lane would take one job past the slots on every tick.
  if (free <= 0) {
    return {
      claimed: 0,
      settled: Promise.resolve(),
      reported: noteFullLane(base, now, deps),
    };
  }
  const jobs = await claim(free, base, now, undefined, [...inFlight]);
  for (const job of jobs) {
    inFlight.add(job.id);
    lane.announced.delete(job.id);
  }
  // allSettled: runClaimed never re-throws (it fails the job internally), but a stray throw must not
  // strand a slot. The async wrapper turns a synchronous throw into a rejection, so `finally` runs.
  const settled = Promise.allSettled(
    jobs.map((job) =>
      (async () => run(job, base))().finally(() => {
        inFlight.delete(job.id);
      }),
    ),
  ).then(() => {});
  // NOTE: fewer than the free slots means everything due fitted, so nothing waits and the saturation
  // (if there was one) is over. Exactly as many leaves the lane full, with maybe more behind it.
  let reported = Promise.resolve();
  if (jobs.length < free) {
    lane.fullSince = null;
    lane.announced.clear();
  } else {
    reported = noteFullLane(base, now, deps);
  }
  return { claimed: jobs.length, settled, reported };
}

// The lane is full at `now`: start its clock if it just filled, and announce whoever has waited too
// long. OFF the drain's path: the tick returns without waiting for it, so a slow question never
// delays the jobs just claimed nor the next claim, which is when a saturated lane can least afford
// it. `reported` is how a test waits for it. One question at a time: a tick that finds the previous
// one still running skips its own, and the next tick asks again. Never rejects.
function noteFullLane(
  base: PrismaClient,
  now: Date,
  deps: DebounceTickDeps,
): Promise<void> {
  lane.fullSince ??= now.getTime();
  if (lane.asking) return Promise.resolve();
  lane.asking = true;
  return announceWaiting(base, now.getTime(), deps)
    .catch((err) => {
      logger.warn({ err }, "debounce lane: asking who is waiting failed");
    })
    .finally(() => {
      lane.asking = false;
    });
}

interface Holder {
  timer?: ReturnType<typeof setInterval>;
  running: boolean;
}

const KEY = Symbol.for("fazerai.debounce.worker");

function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  g[KEY] ??= { running: false };
  return g[KEY];
}

export interface StartOptions {
  base?: PrismaClient;
  intervalMs?: number;
  slots?: number;
  deps?: DebounceTickDeps;
}

export function startDebounceWorker(opts: StartOptions = {}): () => void {
  const h = holder();
  if (h.timer) return stopDebounceWorker;
  const base = opts.base ?? basePrisma;
  const intervalMs = opts.intervalMs ?? config.debounceWorker.intervalMs;
  h.timer = setInterval(() => {
    // NOTE: `running` covers the CLAIM only, so two claims never overlap. The tick resolves once its
    // jobs have started, and the next tick fills whatever slots have freed by then.
    if (h.running) return;
    h.running = true;
    void runDebounceTick(
      base,
      opts.slots ?? config.agent.modelConcurrency,
      opts.deps,
    )
      .catch((e) => logger.error({ err: e }, "debounce tick failed"))
      .finally(() => {
        h.running = false;
      });
  }, intervalMs);
  logger.info("debounce worker started (interval=%dms)", intervalMs);
  return stopDebounceWorker;
}

export function stopDebounceWorker(): void {
  const h = holder();
  if (h.timer) {
    clearInterval(h.timer);
    h.timer = undefined;
  }
}
