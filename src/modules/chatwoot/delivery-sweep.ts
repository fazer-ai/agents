import type {
  InboundDeliveryStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId } from "@/graph/checkpointer";
import { isTurnInFlight } from "@/graph/inflight";
import type { RuntimeDeps } from "@/graph/runtime";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { flushDebounceJob } from "@/modules/debounce/handler";
import { debounceDedupeKey } from "@/modules/debounce/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "./stranded-delivery";

// Recovers Chatwoot deliveries stranded on PROCESSING (issue #228). One DELIVERY_SWEEP job per
// tenant, armed at boot and when a Chatwoot account is connected, self-rearming, on the shared
// scheduler lane.
//
// The recovery is NOT a replay of the delivery. The event body is gone with the process that held
// it, and it is not stored: `coalesceAndRunTurn` opens by re-reading the conversation's messages
// from Chatwoot, so the flush already has the only copy that matters. What the sweep does is RUN
// that flush and let it decide, against the handled watermark, whether anything is still owed an
// answer. That is why the ledger grew two ids (the conversation, and the message the delivery
// carried) rather than an encrypted payload column with a retention window.
//
// The flush is run HERE rather than armed as a DEBOUNCE job, and both halves of that matter:
//
//   * DEBOUNCE is drained only by the debounce lane, which an install can switch off
//     (DEBOUNCE_WORKER_ENABLED). A recovery parked there would never run on exactly the installs
//     that do not use debounce — which is the same trap `scheduler/lanes.ts` documents for
//     INGEST_MESSAGE, and the sweep walks into it harder, because it flushes for agents whose own
//     debounce switch is OFF;
//   * arming is not recovering. A row marked PROCESSED because a job was enqueued reports a success
//     that has not happened yet, and the whole operator-facing value of this sweep is that the two
//     terminal states mean what they say.
//
// Running the flush inline is also what makes the sweep provider-spending work, and it is declared
// as such in `scheduler/lanes.ts` so the shared lane bounds how many run at once.

// Longer than any legitimate delivery. There is no number to derive it from — the direct path runs
// the agent turn INSIDE `processChatwootDelivery` and neither the model call nor the tools have a
// timeout — so this is a policy choice, and the in-flight fence below is what carries the weight a
// tighter threshold could not.
const STALE_AFTER_MS = 10 * 60 * 1000;
// Cadence of the sweep itself. A stranded delivery is a customer waiting on a reply, so recovery is
// measured in minutes; the scan is one indexed read per tenant.
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// Bounds a row whose recovery keeps failing, so a poisoned delivery cannot cycle forever. A turn
// deferred because one is already running does NOT spend one: that is not a failure.
const MAX_RECOVERY_ATTEMPTS = 3;
// How many stranded rows one pass handles. Small on purpose now that a row can cost a whole agent
// turn: strands come from process deaths, so a pass normally finds none, and a backlog is drained
// over consecutive passes rather than inside one job.
const BATCH = 25;
// The job id handed to a recovery flush when this thread has no DEBOUNCE row. Negative on purpose:
// `scheduler_jobs.id` is a positive autoincrement, so this matches nothing and the retirement probe
// answers "not retired", which is the truth when there is no row that could have been retired.
const NO_SCHEDULER_ROW = -1n;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface StrandedRow {
  id: bigint;
  // Narrowed by the query, not by the type: the column's enum has terminal values this never sees.
  status: InboundDeliveryStatus;
  chatwootInstanceId: bigint;
  deliveryId: string;
  event: string;
  receivedAt: Date;
  attempts: number;
  conversationId: number | null;
  messageId: number | null;
}

// What one stale row's recovery did. Separate from the row's classification because these are
// answers about the WORLD (is a turn running, does the mirror know this conversation) and the
// classification is an answer about the row.
type RecoveryOutcome =
  // The flush ran. Whether it answered anything is the flush's own decision, against the watermark.
  | "flushed"
  // A turn is executing on that thread right now. Left for the next pass, no attempt spent.
  | "turn-running"
  // The mirror cannot say who the bot is on that conversation, so the flush has nothing to run as.
  | "no-mirror"
  // The flush threw. Retried on the next pass until the attempt bound.
  | "failed";

export interface SweepCounts {
  // Row claimed too recently to call abandoned.
  tooFresh: number;
  // Flush ran for the stranded conversation.
  recovered: number;
  // Deferred: a turn is already executing on that thread.
  turnRunning: number;
  // Terminal with nothing outstanding: the event named no conversation.
  closed: number;
  // Terminal with a message lost: no mirror, or the attempt bound was reached.
  lost: number;
}

// Runs the flush the dead delivery's conversation is owed, as the delivery itself would have.
//
// `agentBotId` is derived from the mirror rather than stored because the flush uses it for ONE thing
// — telling OUR bot from another persona's on an AgentBot assignee — and the mirror plus the bot
// registry answer that as well as the spent delivery would have.
async function recoverConversation(
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<RecoveryOutcome> {
  const instanceId = row.chatwootInstanceId;
  const conversationId = row.conversationId as number;
  const agentBotId = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: { inboxId: true },
    });
    if (!conv?.inboxId) return undefined;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return undefined;
    const bot = await db.chatwootAgentBot.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        agentId: inbox.agentId,
      },
      select: { chatwootAgentBotId: true },
    });
    return bot?.chatwootAgentBotId ?? undefined;
  });
  if (agentBotId === undefined) return "no-mirror";

  const threadId = chatwootThreadId(tenantId, instanceId, conversationId);
  // The identity the flush's retirement probe reads, and it has to be a REAL one. `flushDebounceJob`
  // hands the job it was given to `stillWanted`, which re-reads `scheduler_jobs` BY ITS ID and
  // compares `claimSeq` — so a synthesized id is not inert, it is a question asked about whatever
  // row happens to carry that number. Pointing it at this thread's own DEBOUNCE row asks the right
  // question about the right row: `/reset` retires that row by dedupe key, stamping `cancelledAt`
  // and bumping `claim_seq`, and a recovery that lands after a reset must stand down exactly as a
  // live flush would.
  //
  // No row means nothing could have retired it, and `isRetired` answers false for a missing row —
  // the correct answer, reached for the right reason. NO_SCHEDULER_ROW is what guarantees the miss:
  // ids are a positive autoincrement, so a negative one matches nothing, whereas the delivery row's
  // own id is a live number in a different sequence that will eventually collide.
  const flushRow = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "DEBOUNCE",
        dedupeKey: debounceDedupeKey(threadId),
      },
      select: { id: true, claimSeq: true },
    }),
  );
  // The fence a concurrently-fired follow-up already uses (../../graph/inflight.ts), asked here for
  // the same reason and against the case the wall-clock threshold cannot see: a legitimate turn
  // that has been running longer than the threshold. Without it the flush would start a SECOND turn
  // beside the live one, and while the handled-watermark CAS keeps only one reply from being
  // posted, the tools of both turns have already run by then — a message sent, a card moved, an
  // outbound call made, twice.
  //
  // The fence is in-process and cleared by a restart, which is exactly right here: a delivery is
  // stranded BECAUSE its process died, so the turn it was running died with the mark. What the
  // fence does not cover is a turn live on a DIFFERENT replica, which is issue #203's gap and not
  // one this sweep can close.
  if (isTurnInFlight(threadId)) return "turn-running";

  const job: ClaimedJob = {
    id: flushRow?.id ?? NO_SCHEDULER_ROW,
    claimSeq: flushRow?.claimSeq ?? 0,
    tenantId,
    kind: "DEBOUNCE",
    payload: {
      threadId,
      agentBotId,
      // The burst's high-water mark. Its one consumer is the flush's gate-closed exit, which uses
      // it to mark the burst handled without a fetch; a recovery that omitted it would leave the
      // stranded message below the watermark, and the first flush after a human hands the
      // conversation back would re-answer the whole pre-handoff backlog (issue #8's shape).
      ...(row.messageId !== null ? { lastMessageId: row.messageId } : {}),
    },
    attempts: 0,
  };
  await flushDebounceJob({ job, base, deps });
  return "flushed";
}

// Takes a stale PENDING row with the delivery path's own CAS, so a redelivery landing at this
// moment cannot process the same event beside the recovery. False means somebody else got it.
//
// PENDING is the only state that needs this, and that is not an oversight: a redelivery's own CAS
// matches `PENDING` too, so it is the one state where two writers can both believe the event is
// theirs. A row already PROCESSING is invisible to a redelivery (the CAS matches nothing, the call
// returns "skipped"), and two sweep passes cannot overlap — the scheduler is single-replica, claims
// with FOR UPDATE SKIP LOCKED, and does not re-enter a tick.
//
// Exported for the test: the false branch is a race, and a test that tries to construct one is the
// kind that goes green for the wrong reason. Asked directly, it is one deterministic assertion.
export async function claimStrandedRow(
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
): Promise<boolean> {
  const claimed = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "PROCESSING" },
    }),
  );
  return claimed.count > 0;
}

export interface SweepStrandedDeliveriesParams {
  tenantId: bigint;
  base: PrismaClient;
  now?: Date;
  deps?: RuntimeDeps;
}

// One pass for one tenant. Exported for the tests, which drive it directly rather than through the
// scheduler tick.
export async function sweepStrandedDeliveries(
  params: SweepStrandedDeliveriesParams,
): Promise<SweepCounts> {
  const { tenantId, base } = params;
  const now = params.now ?? new Date();
  const counts: SweepCounts = {
    tooFresh: 0,
    recovered: 0,
    turnRunning: 0,
    closed: 0,
    lost: 0,
  };
  // BOTH non-terminal states, because both strand and for the same reason. The ack is spent before
  // the ledger row is even written, so a process that dies between the insert and the CAS leaves
  // PENDING with nothing running — and #226's answer to that ("a redelivery goes on to the CAS
  // instead of being dropped") only helps when a redelivery actually arrives. Chatwoot holds a 200,
  // so usually none does. The PENDING window is much narrower than the PROCESSING one (microseconds
  // between the insert and the CAS, against the whole length of a turn), but the row already
  // carries everything the recovery needs.
  const rows = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findMany({
      where: { status: { in: ["PENDING", "PROCESSING"] } },
      orderBy: { receivedAt: "asc" },
      take: BATCH,
      select: {
        id: true,
        status: true,
        chatwootInstanceId: true,
        deliveryId: true,
        event: true,
        receivedAt: true,
        attempts: true,
        conversationId: true,
        messageId: true,
      },
    }),
  );
  for (const row of rows) {
    const verdict: StrandedVerdict = classifyStrandedDelivery(row, {
      now,
      staleAfterMs: STALE_AFTER_MS,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
    });
    if (verdict === "in-flight") {
      counts.tooFresh += 1;
      continue;
    }
    // A stale PENDING row is still claimable by a redelivery arriving right now, so take it with
    // the same CAS the delivery path uses before doing anything with it. Losing the race is not a
    // failure: whoever won is processing the event, which is the outcome this sweep exists to
    // produce. A PROCESSING row needs no such claim — its CAS already ran.
    if (
      row.status === "PENDING" &&
      !(await claimStrandedRow(row, tenantId, base))
    ) {
      continue;
    }
    await applyVerdict(verdict, row, tenantId, base, counts, params.deps);
  }
  return counts;
}

// Applies one verdict, and leaves the row saying WHICH of the two terminal things happened:
//
//   PROCESSED — nothing is outstanding on this row. Either the flush ran (and decided against the
//               watermark whether anything was owed), or the event named no conversation.
//   DEAD      — a message was lost. The flush could not be run at all (the mirror does not know the
//               conversation) or was run and kept failing until the attempt bound.
//
// The distinction is the whole operator-facing value of the sweep: `WHERE status = 'DEAD'` is the
// list of customers who wrote and were never answered, and collapsing it into PROCESSED would make
// a lost message and a recovered one look identical in the only place either is recorded.
//
// A row is left PROCESSING by exactly two outcomes, and both are bounded: a turn already running on
// that thread (no attempt spent, retried next pass) and a flush that threw (attempt spent, so the
// bound is reached).
async function applyVerdict(
  verdict: Exclude<StrandedVerdict, "in-flight">,
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
  counts: SweepCounts,
  deps?: RuntimeDeps,
): Promise<void> {
  const label = `${row.deliveryId} (${row.event})`;
  const finish = (
    status: "PROCESSED" | "DEAD" | "PROCESSING",
    spendAttempt = true,
  ) =>
    runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootWebhookDelivery.update({
        where: { id: row.id },
        data: {
          status,
          ...(spendAttempt ? { attempts: { increment: 1 } } : {}),
          ...(status === "PROCESSING" ? {} : { processedAt: new Date() }),
        },
      }),
    );

  if (verdict === "unrecoverable") {
    logger.info(
      "chatwoot delivery sweep: %s stranded with no conversation to recover; closing",
      label,
    );
    counts.closed += 1;
    await finish("PROCESSED");
    return;
  }
  if (verdict === "exhausted") {
    logger.error(
      "chatwoot delivery sweep: %s could not be recovered in %d attempts; giving up (the customer's message on conversation %s is unanswered)",
      label,
      row.attempts,
      String(row.conversationId),
    );
    counts.lost += 1;
    await finish("DEAD");
    return;
  }

  let outcome: RecoveryOutcome;
  try {
    outcome = await recoverConversation(row, tenantId, base, deps);
  } catch (err) {
    logger.warn(
      "chatwoot delivery sweep: the recovery flush for %s (conv=%s) failed: %s — leaving it for the next pass",
      label,
      String(row.conversationId),
      err instanceof Error ? err.message : String(err),
    );
    await finish("PROCESSING");
    return;
  }

  if (outcome === "turn-running") {
    logger.info(
      "chatwoot delivery sweep: %s stranded on conversation %s, but a turn is running there; deferring",
      label,
      String(row.conversationId),
    );
    counts.turnRunning += 1;
    // No attempt spent: a live turn is not a failed recovery, and spending the budget on it would
    // let a busy conversation exhaust the row before it was ever tried.
    await finish("PROCESSING", false);
    return;
  }
  if (outcome === "no-mirror") {
    // The one window this design does not close: the process died between the CAS and the mirror
    // write, so there is no row to read the inbox and the bot's identity from, and the flush has
    // nothing to run as. Recorded as a loss rather than swallowed.
    logger.error(
      "chatwoot delivery sweep: %s stranded on conversation %s the mirror does not know; the customer's message is lost",
      label,
      String(row.conversationId),
    );
    counts.lost += 1;
    await finish("DEAD");
    return;
  }
  logger.info(
    "chatwoot delivery sweep: %s stranded on PROCESSING; flushed conversation %s",
    label,
    String(row.conversationId),
  );
  counts.recovered += 1;
  await finish("PROCESSED");
}

// Exported for the test that pins the reschedule's `resetAttempts`, which is the half of the
// perpetual-job budget that `ensureDeliverySweep` cannot cover.
export async function deliverySweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  await sweepStrandedDeliveries({ tenantId: job.tenantId, base });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    // A pass that completed is proof the sweep works, so the next failure starts a fresh budget.
    // Without it `attempts` counts this row's WHOLE LIFETIME — `rescheduleJob` deliberately leaves
    // it alone — and five transient failures spread over weeks of successful passes dead-letter a
    // job that is supposed to run forever. Opt-in, so nothing changes for the kinds whose attempts
    // are about one finite unit of work; issue #287 is the general case.
    resetAttempts: true,
  };
}

let registered = false;
export function registerDeliverySweepHandler(): void {
  if (registered) return;
  registerJobHandler("DELIVERY_SWEEP", deliverySweepHandler);
  registered = true;
}

// Arms the per-tenant sweep (idempotent — enqueueJob upserts one live row per (tenant, kind,
// dedupeKey), re-arming run_at). The first pass is a sweep interval out: a boot is exactly when a
// deploy has just stranded rows, and they are not stale yet.
export async function ensureDeliverySweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "DELIVERY_SWEEP",
    dedupeKey: "delivery-sweep",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    // Revives a row that was already dead-lettered: without this it comes back with `attempts` at
    // the cap and dies on the very next failure. The handler resets the budget on every successful
    // pass, so this covers the one case that cannot — a row that reached the cap before this
    // release, or while the sweep was failing.
    //
    // Both halves diverge from `ensureFlowlogSweep` / `ensureTenantSweep`, which have the same shape
    // and neither resets. That is issue #287, not something to fix from here.
    resetAttempts: true,
    base,
  });
}

// Arms the sweep for every existing tenant (called once at boot). Same best-effort discipline as
// ensureAllFlowlogSweeps: one tenant failing must not deprive every later tenant of its re-arm.
//
// NOT sufficient on its own: a first-run install has no tenants when this runs, and the one `/setup`
// creates would wait for a restart. `connectChatwootInstance` arms it too, which is the moment a
// tenant acquires the only thing that can produce a delivery in the first place.
export async function ensureAllDeliverySweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      await ensureDeliverySweep(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "delivery sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
