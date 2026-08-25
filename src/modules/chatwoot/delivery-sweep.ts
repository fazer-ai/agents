import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readDebounceConfig } from "@/modules/debounce/settings";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "./stranded-delivery";

// Finds Chatwoot deliveries stranded by a process death and says so (issue #228). One DELIVERY_SWEEP
// job per tenant, armed at boot and when a Chatwoot account is connected, self-rearming.
//
// IT DOES NOT ANSWER THE CUSTOMER, and that is the design rather than a shortcut. Recovering the
// turn means running one, and a turn run from here is not the turn the delivery would have run: the
// flush machinery re-checks ownership and contact authorization itself, but the test-mode gate, the
// availability window and the redirect gate are applied by the delivery path and are gone with the
// process that died. A recovery that skips them answers out of hours, or on a conversation whose
// test mode was never activated — a reply the original delivery would have suppressed. Two earlier
// designs here (arming the flush, running it inline) were both wrong for that same reason, and the
// recovery half is issue #295.
//
// What is left is worth having on its own. The issue's harm has two halves — the message is gone,
// and it is gone SILENTLY — and this closes the second completely: every stranded row becomes
// terminal, `WHERE status = 'DEAD'` is the list of customers who wrote and were never answered, and
// each one leaves an error-level line on the conversation, which is what the console reads and what
// the alert channels dispatch.

// Longer than any legitimate delivery. There is no number to derive it from — the direct path runs
// the agent turn INSIDE `processChatwootDelivery` and neither the model call nor the tools have a
// timeout — so it is a policy choice, and it is cheap to be generous with: nothing here acts on the
// conversation, so judging a live delivery early costs a row marked terminal a few minutes too
// soon, not a second turn.
const STALE_AFTER_MS = 30 * 60 * 1000;
// Cadence of the sweep. Recovery is not on the table, so what this buys is how fast an operator
// learns; minutes rather than hours because the answer is "go read this conversation".
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// One pass's ceiling. Generous because a row costs two indexed reads and one write, with no network
// and no model: the bound is against a pathological backlog, not against per-row cost.
const BATCH = 500;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface StrandedRow {
  id: bigint;
  status: "PENDING" | "PROCESSING";
  chatwootInstanceId: bigint;
  deliveryId: string;
  event: string;
  receivedAt: Date;
  claimedAt: Date | null;
  conversationId: number | null;
  inboundMessageId: number | null;
}

// The clock this row is judged by: when the CURRENT attempt started. A redelivery is allowed to
// claim a row stranded on PENDING, so a live attempt can begin long after the receipt — dated to the
// receipt it looks abandoned the instant it starts, and the sweep would report a lost message while
// the process answering it is still running.
function attemptStartedAt(row: StrandedRow): Date {
  return row.claimedAt ?? row.receivedAt;
}

export interface SweepCounts {
  // Received too recently to call abandoned.
  tooFresh: number;
  // Terminal, nothing lost: the delivery carried no inbound message, or a later turn posted a reply
  // that covered the one it carried.
  closed: number;
  // Terminal, a customer message lost.
  lost: number;
  // The row moved under the sweep (a redelivery claimed it) between the scan and the write.
  raced: number;
}

// The conversation's mirror row, for the answered mark and for the ids the flow line is filed under.
// Null when the mirror does not know this conversation — a delivery that died before the mirror
// write — which the classifier reads as "not answered", because it is the reading that puts the row
// in front of an operator rather than closing it quietly.
async function mirrorOf(
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
): Promise<{
  conversationRowId: bigint;
  inboxId: bigint | null;
  agentId: bigint | null;
  answeredMessageId: number | null;
  coalesces: boolean;
} | null> {
  if (row.conversationId === null) return null;
  const conversationId = row.conversationId;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: row.chatwootInstanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: { id: true, inboxId: true, lastAnsweredMessageId: true },
    });
    if (!conv) return null;
    const inbox = conv.inboxId
      ? await db.inbox.findUnique({
          where: { id: conv.inboxId },
          select: { agentId: true },
        })
      : null;
    const agent = inbox?.agentId
      ? await db.agent.findUnique({
          where: { id: inbox.agentId },
          select: { settings: true },
        })
      : null;
    return {
      conversationRowId: conv.id,
      inboxId: conv.inboxId,
      agentId: inbox?.agentId ?? null,
      // The ANSWERED mark, never the handled watermark. That one means "never re-ANSWER this" and
      // most of its writers advance it because no answer is coming, so reading it here closes real
      // losses quietly — see the field's own note in ./stranded-delivery.ts.
      answeredMessageId: conv.lastAnsweredMessageId,
      // Read NOW, not recorded THEN, and this is the one inexactness left in the sweep. It can be
      // wrong in both directions, and only one of them is harmless:
      //
      //   * debouncing on at the strand, off now → reads the stricter way and reports a loss that
      //     was answered. A false line in the list, which costs an operator one look;
      //   * debouncing OFF at the strand, on now → reads the looser way and closes a row that
      //     really did lose a message. A false silence, which is the failure this whole sweep
      //     exists to remove.
      //
      // Recording the path on the row at delivery time is what would close it, and it is a column
      // plus a write on the ack-adjacent path. Left undone deliberately: the second direction needs
      // an operator to have enabled debouncing in the half hour between a strand and the sweep, and
      // the strict comparison above already catches the case where the stranded row is the one that
      // claimed the mark.
      coalesces: readDebounceConfig(agent?.settings).enabled,
    };
  });
}

// Writes the row's terminal state, CASing on the status the scan read. Losing that CAS means a
// redelivery claimed the row in between and is processing the event right now — the outcome this
// sweep exists to report the absence of — so it is not a failure and nothing is recorded.
// Exported for the test: the false branch is a race between the scan and the write, and a test that
// tries to construct one goes green for the wrong reason more often than it detects.
export async function finish(
  row: StrandedRow,
  tenantId: bigint,
  status: "PROCESSED" | "DEAD",
  base: PrismaClient,
): Promise<boolean> {
  const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: { id: row.id, status: row.status },
      data: { status, processedAt: new Date() },
    }),
  );
  return count > 0;
}

export interface SweepStrandedDeliveriesParams {
  tenantId: bigint;
  base: PrismaClient;
  now?: Date;
}

// One pass for one tenant. Exported for the tests, which drive it directly rather than through the
// scheduler tick.
export async function sweepStrandedDeliveries(
  params: SweepStrandedDeliveriesParams,
): Promise<SweepCounts> {
  const { tenantId, base } = params;
  const now = params.now ?? new Date();
  const counts: SweepCounts = { tooFresh: 0, closed: 0, lost: 0, raced: 0 };

  // BOTH non-terminal states, because both strand and for the same reason. The ack is spent before
  // the ledger row is even written, so a death between the insert and the CAS leaves PENDING — and
  // #226's answer to that ("a redelivery goes on to the CAS instead of being dropped") only helps
  // when a redelivery actually arrives, which it usually does not, because Chatwoot holds a 200.
  const rows = (await runScopedOn(base, sysCtx(tenantId), (db) =>
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
        claimedAt: true,
        conversationId: true,
        inboundMessageId: true,
      },
    }),
  )) as StrandedRow[];

  for (const row of rows) {
    // Read the mirror only for a row that is actually stale, and only when it carried a message:
    // the fresh rows are the common case and the whole point of the age fence is not to touch them.
    const preliminary = classifyStrandedDelivery(
      {
        attemptStartedAt: attemptStartedAt(row),
        inboundMessageId: row.inboundMessageId,
      },
      {
        now,
        staleAfterMs: STALE_AFTER_MS,
        answeredMessageId: null,
        coalesces: false,
      },
    );
    if (preliminary === "in-flight") {
      counts.tooFresh += 1;
      continue;
    }
    const mirror =
      preliminary === "no-message" ? null : await mirrorOf(row, tenantId, base);
    const verdict = classifyStrandedDelivery(
      {
        attemptStartedAt: attemptStartedAt(row),
        inboundMessageId: row.inboundMessageId,
      },
      {
        now,
        staleAfterMs: STALE_AFTER_MS,
        answeredMessageId: mirror?.answeredMessageId ?? null,
        coalesces: mirror?.coalesces ?? false,
      },
    );
    // Not reachable: the same row already answered "not in-flight" a few lines up, against the same
    // clock and the same threshold — the second call only adds the answered mark, which no branch
    // above the age fence reads. Narrowed rather than asserted because the alternative is a throw on
    // a path that cannot be taken.
    if (verdict === "in-flight") {
      counts.tooFresh += 1;
      continue;
    }
    await record(verdict, row, tenantId, mirror, counts, base);
  }
  return counts;
}

async function record(
  verdict: Exclude<StrandedVerdict, "in-flight">,
  row: StrandedRow,
  tenantId: bigint,
  mirror: Awaited<ReturnType<typeof mirrorOf>>,
  counts: SweepCounts,
  base: PrismaClient,
): Promise<void> {
  const label = `${row.deliveryId} (${row.event})`;
  if (verdict !== "lost") {
    if (!(await finish(row, tenantId, "PROCESSED", base))) {
      counts.raced += 1;
      return;
    }
    counts.closed += 1;
    logger.info(
      "chatwoot delivery sweep: %s stranded on %s with nothing outstanding (%s); closing",
      label,
      row.status,
      verdict,
    );
    return;
  }

  // The CAS goes FIRST, and the line only if it wins. Ordering it the other way (an earlier round of
  // this PR did) trades a real failure for a worse one: `writeFlowEvent` DISPATCHES the alert as it
  // writes — Discord, webhook, an operator's phone — and nothing can retract that, so a line written
  // before the CAS pages someone about a lost message every time a redelivery claimed the row in
  // between. That race is a designed path here, not an infrastructure failure; the row moving under
  // the sweep is precisely the outcome `finish` exists to detect.
  //
  // What the old ordering was protecting against is real but smaller: if the write fails after the
  // CAS won, the row is DEAD with no line and no later pass revisits it. It is not a silence, though
  // — the DEAD row is itself the record, and `WHERE status = 'DEAD'` is the list this sweep exists
  // to produce. A failing write here is the tenant's own database refusing an insert one statement
  // after accepting an update, which is an outage, not a race.
  if (!(await finish(row, tenantId, "DEAD", base))) {
    counts.raced += 1;
    return;
  }
  const written = await writeFlowEvent(
    {
      tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      // Filed WITHOUT a conversation when the mirror does not know it. The line is worth writing
      // unattached: the DEAD row carries the delivery id, this carries everything else about it.
      conversationId: mirror?.conversationRowId ?? null,
      agentId: mirror?.agentId ?? null,
      inboxId: mirror?.inboxId ?? null,
      base,
    },
    {
      stage: "delivery",
      level: "error",
      status: "error",
      detail: {
        outcome: "stranded",
        deliveryEvent: row.event,
        strandedOn: row.status,
        messageId: row.inboundMessageId,
        conversationId: row.conversationId,
        knownToMirror: mirror !== null,
      },
    },
  );
  if (!written.delivered) {
    // The row is already DEAD and stays in the list; what was lost is the conversation-level line
    // and the alert. Loud, because nothing will retry it.
    logger.error(
      "chatwoot delivery sweep: %s is DEAD but its loss line could not be written; the row is in the DEAD list and nothing was alerted",
      label,
    );
  }
  counts.lost += 1;
  logger.error(
    "chatwoot delivery sweep: %s stranded on %s; the customer's message %s on conversation %s was never answered",
    label,
    row.status,
    String(row.inboundMessageId),
    String(row.conversationId),
  );
}

// Exported for the test that pins the reschedule's `resetAttempts`.
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
    // pass, so this covers the one case that cannot — a row that reached the cap while the sweep
    // was failing.
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
