import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
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
// timeout — so it is a policy choice, and generous on purpose.
//
// What being early costs is one false ALERT, not a second turn: nothing here acts on the
// conversation. A turn still running past this mark has its row marked DEAD and its loss
// dispatched, and then the turn finishes and `processChatwootDelivery`'s tx2 writes PROCESSED over
// it — by id, deliberately, so the row ends up saying the true thing (see the note there). The
// alert is what cannot be recalled. Thirty minutes puts that outside anything but a pathological
// turn; closing it properly needs the processor to heartbeat, which is machinery this does not
// carry.
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

// Retire the ledger rows of the messages a turn just ran over.
//
// This is the half that makes the sweep's question answerable. A delivery row records ONE message,
// and the question the sweep asks is about that message: did anything ever process it? Answering it
// by comparing the conversation's watermarks cannot work, and three review rounds of this PR each
// found a different way it fails — the watermark is a per-CONVERSATION high-water mark and the
// question is per-MESSAGE, so any scalar reading of it either closes real losses (a later
// deliberate skip moves it past an unanswered message) or reports answered ones.
//
// So the turn says so directly. A burst re-fetched from Chatwoot may contain messages whose own
// delivery DIED before finishing — that is exactly what the flush rescues, since it re-reads every
// message above the watermark rather than the one that armed it — and those rows are the ones this
// retires. In the ordinary case it updates nothing: a delivery that completed already reached
// PROCESSED on its own.
//
// It runs AFTER the turn, never at the post gate: the gate claims before the reply is sent, and
// retiring there would erase the evidence of precisely the crash window the sweep exists to catch.
// Which messages the decision covered, in the shape the caller can actually state it — and the two
// shapes are EXCLUSIVE, spelled as a union so the third combination cannot be written.
//
// It is not a stylistic union. Every field was optional once, and dropping all three left a filter
// with no message bound at all: `{ chatwootInstanceId, conversationId }`, which retires every
// non-terminal row on the conversation and closes whatever loss was sitting there. A `not: null`
// alarm was what stood between that call and the damage, on a filter whose whole job is to be
// narrow. There is now no such call to write.
//
//   The third is ONE ROW, and it exists because one of the callers does not speak for the
//   conversation. Chatwoot fans a message to up to TWO bot routes — `agent_bots_for` returns the
//   conversation's assignee bot AND the inbox's active bot, each with its own `delivery_id` — so a
//   message can hold two ledger rows that differ only by which bot received it. A gate exit taken
//   because the conversation is held by ANOTHER PARTY is not a statement that the message was
//   handled; it is a statement that WE are not handling it. Keyed by conversation and message, that
//   exit retires the other route's row, and if that route's process then dies the loss is invisible.
//   `deliveryRowId` is the caller saying "only the delivery I am".
type CoveredMessages =
  // The burst a turn ran over, known exactly because the thread was re-fetched.
  | {
      messageIds: number[];
      afterMessageId?: never;
      upToMessageId?: never;
      deliveryRowId?: never;
    }
  // The gate exits, which decide before any fetch and can only say what the watermark they advance
  // says. That is a RANGE, and it is bounded at BOTH ends: the burst they consume is everything
  // after the watermark as it stood, up to the payload's newest id. Open at the bottom, it reaches
  // back past its own burst and retires a strand some earlier message left behind — the gate never
  // decided about that one, and closing it hides a real loss for good. (Message 1 strands; message 2
  // arrives on a human-owned conversation and advances the watermark past both; a gated flush for
  // message 3 then swallows message 1.)
  //
  // A range is sound HERE, where it is a write at the moment of the decision, and would not be as a
  // read afterwards — that difference is the whole reason the sweep no longer reads watermarks at
  // all. `afterMessageId` null means nothing had been handled yet, so the burst genuinely starts at
  // the beginning. `upToMessageId` is required: it is the message the gate just decided about, and
  // the bound is inclusive because that message is the one most in need of retiring.
  | {
      messageIds?: never;
      afterMessageId: number | null;
      upToMessageId: number;
      deliveryRowId?: never;
    }
  | {
      deliveryRowId: bigint;
      messageIds?: never;
      afterMessageId?: never;
      upToMessageId?: never;
    };

export async function retireCoveredDeliveries(
  params: CoveredMessages & {
    tenantId: bigint;
    // The Chatwoot ACCOUNT, and it is part of the key rather than context. Display ids and message ids
    // are numbered per account, so a tenant with two connected accounts has two conversation 41s — the
    // mirror says as much, keying conversations on `[tenantId, chatwootInstanceId,
    // chatwootConversationId]`. Left out, a burst on one account retires a genuine strand on the
    // other and hides that loss for good.
    instanceId: bigint;
    // Chatwoot display id, which is what the ledger column holds.
    conversationId: number;
    // The mirror's own row id, for filing the correction line below against the conversation. Null
    // only where the mirror does not know it, which is the same reading the sweep's own line uses.
    conversationRowId: bigint | null;
    // What actually happened to the customer, and it has to come from the caller because only the
    // caller knows. "answered" is a reply that posted; "consumed" is every deliberate silence — a gate
    // that took the message, a model that produced nothing, a human who took the conversation
    // mid-turn. Assuming the first would tell an operator their customer was answered when nobody
    // replied, which is the same class of lie this whole sweep exists to remove.
    settlement: "answered" | "consumed";
    base: PrismaClient;
  },
): Promise<number> {
  // The account and the conversation fence every shape, including the single-row one: an id alone
  // would be enough to find the row, and carrying the other two keeps every write on this path
  // narrowed the same way, so a wrong id cannot reach across a tenant's other account.
  const scope = {
    chatwootInstanceId: params.instanceId,
    conversationId: params.conversationId,
  };
  const where =
    params.deliveryRowId !== undefined
      ? { ...scope, id: params.deliveryRowId }
      : {
          ...scope,
          inboundMessageId:
            params.messageIds !== undefined
              ? { in: params.messageIds }
              : {
                  lte: params.upToMessageId,
                  ...(params.afterMessageId !== null
                    ? { gt: params.afterMessageId }
                    : {}),
                },
        };

  // TWO writes, and the split is what makes the correction exact rather than nearly exact.
  //
  // NOTE: the pair is not a transaction, and neither is the watermark advance that precedes every
  // caller of this. Every window between those writes leaves a state that is WRONG AND VISIBLE — a
  // row still in the worklist for a message something did handle, a correction with no closing line
  // — never a loss that goes quiet, which is the one failure this whole sweep exists to prevent.
  // Alert dispatch happens inside `writeFlowEvent`, so a transaction spanning it would hold a
  // database write open across somebody else's HTTP endpoint. They are named in the PR's validation
  // scope instead, next to the sibling window this design already accepts on purpose (a delivery
  // that dies between its insert and its CAS).
  //
  // THE ORDINARY CASE FIRST, and the order is the fix for a race rather than a preference.
  //
  // The sweep's own write turns a covered row PROCESSING -> DEAD. Run the DEAD statement first and
  // that transition lands BETWEEN the two: the DEAD read finds nothing (the row was still
  // PROCESSING), the sweep marks it DEAD and dispatches the loss, and the PROCESSING statement then
  // finds nothing either. The row stays DEAD for good, reported as a customer nobody answered, with
  // no owner left to run tx2 over it — permanent, and exactly backwards.
  //
  // This way round, the same interleaving is harmless in both directions. Landing after this
  // statement, the sweep's terminal CAS is on the status it READ (`PROCESSING`) and matches nothing,
  // so it counts the row as raced and writes no line. Landing before it, this statement finds
  // nothing and the DEAD statement below catches the row and writes the correction.
  //
  // PROCESSING only, and never PENDING: that is the state whose owner has not
  // arrived yet, and this write cannot tell "abandoned before the claim" from "claimed a millisecond
  // from now". The ack is spent before the row is even inserted, so a burst re-read from Chatwoot
  // legitimately contains a message whose own delivery sits between its insert and its CAS —
  // retiring it makes that CAS match nothing and the delivery return "skipped", so the mirror write
  // never runs and `lastInboundAt`, the contact and the attribute bags stay behind. That is
  // preempting a delivery rather than rescuing one. A PROCESSING row is already claimed, so retiring
  // it preempts nothing: its own tx2 writes PROCESSED over this a moment later. What it leaves out
  // is a delivery that died in the sliver between its insert and its CAS, reported as a loss even
  // though a later burst answered it — two statements wide, against a whole turn for PROCESSING.
  const { count } = await runScopedOn(
    params.base,
    sysCtx(params.tenantId),
    (db) =>
      db.chatwootWebhookDelivery.updateMany({
        where: { ...where, status: "PROCESSING" },
        data: { status: "PROCESSED", processedAt: new Date() },
      }),
  );

  // AND THE ROWS THAT NEED A CLOSING LINE, which are the ones that were DEAD.
  //
  // READING them first would race the sweep in both directions: a row turning DEAD between the read
  // and the write loses its correction, and two retirees reading the same DEAD row both write one.
  // An UPDATE that names DEAD in its own predicate and returns what it moved answers both at once —
  // only one statement can move a given row out of DEAD, and it is the one holding the rows.
  //
  // DEAD is a correction rather than a contradiction. The sweep reaches its verdict by INFERENCE —
  // nothing has moved this row — while a turn that ran over the message is direct evidence, and it
  // wins. Nothing is erased: `WHERE status = 'DEAD'` is what is STILL unanswered, and the line that
  // reported the loss stays where it was written, joined by the one below saying how it ended.
  const corrected = await runScopedOn(
    params.base,
    sysCtx(params.tenantId),
    (db) =>
      db.chatwootWebhookDelivery.updateManyAndReturn({
        where: { ...where, status: "DEAD" },
        data: { status: "PROCESSED", processedAt: new Date() },
        select: { deliveryId: true, inboundMessageId: true },
      }),
  );

  const answered = params.settlement === "answered";
  const total = count + corrected.length;
  if (total > 0) {
    logger.info(
      "chatwoot: a turn %s %d stranded deliver%s on conversation %d",
      answered ? "answered" : "consumed",
      total,
      total === 1 ? "y" : "ies",
      params.conversationId,
    );
  }

  // A loss that was ALREADY reported ends with a line of its own. The alert for it has been
  // dispatched and cannot be recalled, so the only honest close is a second line saying how it
  // ended — without it the row simply leaves the list and an operator is left holding a page about
  // a customer nobody can find any more. A rescue nobody had reported yet writes nothing: a
  // correction for an alert that never fired is noise.
  for (const row of corrected) {
    logger.warn(
      "chatwoot: %s was reported as a lost message and has now been %s on conversation %d",
      row.deliveryId,
      answered ? "answered" : "consumed deliberately",
      params.conversationId,
    );
    const written = await writeFlowEvent(
      {
        tenantId: params.tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: params.conversationRowId,
        base: params.base,
      },
      {
        stage: "delivery",
        level: "warn",
        // A "warn", and it does NOT page the channel the loss paged. That is a real gap and it is
        // deliberately not closed here: a channel's `minLevel` defaults to "error", so an operator
        // who was paged about this customer learns of the answer from the Logs page or from the DEAD
        // worklist, not from the channel.
        //
        // Routing it as an "error" instead was tried and is worse. `dispatchAlertsForEvent`
        // coalesces a pending delivery by (channel, stage, level), so a correction landing inside
        // the loss alert's window would not close it — it would INCREMENT it, and the operator would
        // get a bigger loss alert carrying the original's summary. The alerting subsystem has levels
        // and stages and no concept of a resolution, for any event; inventing half of one here buys
        // a wrong notification instead of a missing one. `WHERE status = 'DEAD'` stays the list that
        // answers "who is still unanswered", and it is correct the instant this write lands.
        status: "ok",
        detail: {
          outcome: answered ? "answered_late" : "consumed_late",
          messageId: row.inboundMessageId,
          conversationId: params.conversationId,
        },
      },
    );
    if (!written.delivered) {
      // The row has already left the worklist, so this line was the only thing left that could
      // close the alert an operator is holding. Loud, because nothing retries it: unlike the loss
      // itself, which the DEAD row keeps stating until something corrects it, a correction that
      // fails to write leaves no trace of its own anywhere.
      logger.error(
        "chatwoot delivery sweep: %s was corrected out of the loss list but its closing line could not be written; the alert for it stands with nothing to close it",
        row.deliveryId,
      );
    }
  }
  return total;
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

export interface SweepCounts {
  // Terminal, nothing lost: the delivery carried no inbound message at all.
  closed: number;
  // Terminal, a customer message lost.
  lost: number;
  // The row moved under the sweep (a redelivery claimed it) between the scan and the write.
  raced: number;
}

// The conversation's mirror row, for the ids the flow line is filed under. Null when the mirror does
// not know this conversation — a delivery that died before the mirror write — in which case the line
// is filed without one, because it is still worth writing.
//
// It no longer reads any watermark, and that is the point of the retirement above: the question
// "did anything cover this message" is answered by the row's own status, not inferred here.
async function mirrorOf(
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
): Promise<{
  conversationRowId: bigint;
  inboxId: bigint | null;
  agentId: bigint | null;
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
      select: { id: true, inboxId: true },
    });
    if (!conv) return null;
    const inbox = conv.inboxId
      ? await db.inbox.findUnique({
          where: { id: conv.inboxId },
          select: { agentId: true },
        })
      : null;
    return {
      conversationRowId: conv.id,
      inboxId: conv.inboxId,
      agentId: inbox?.agentId ?? null,
    };
  });
}

// Writes the row's terminal state, CASing on the status the scan read. Losing that CAS means a
// redelivery claimed the row in between and is processing the event right now — the outcome this
// sweep exists to report the absence of — so it is not a failure and nothing is recorded.
//
// NOTE: The other ordering is not symmetric and is left as it stands. On a PENDING row this CAS
// races the delivery's own `PENDING -> PROCESSING` claim, and winning it means that claim then
// matches nothing and returns "skipped" — a redelivery arriving in that instant is discarded, and
// with it the one path that could still have answered the customer through the real gates. The
// report is still true (nothing had processed the message), and the window needs a manual replay to
// land inside the sweep's write, since Chatwoot holds a 200 and does not redeliver on its own.
// Closing it means letting a claim take a row back from a terminal state, which is recovery, and
// recovery is issue #295 rather than something to smuggle in here.
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
  // One pass's ceiling, overridable so the batch's fairness can be asked with a handful of rows.
  batch?: number;
}

// One pass for one tenant. Exported for the tests, which drive it directly rather than through the
// scheduler tick.
export async function sweepStrandedDeliveries(
  params: SweepStrandedDeliveriesParams,
): Promise<SweepCounts> {
  const { tenantId, base } = params;
  const now = params.now ?? new Date();
  // Overridable so the batch's FAIRNESS can be asked with three rows instead of five hundred. A test
  // that has to build a real backlog to reach the boundary is a test nobody writes.
  const batch = params.batch ?? BATCH;
  const counts: SweepCounts = { closed: 0, lost: 0, raced: 0 };

  // BOTH non-terminal states, because both strand and for the same reason. The ack is spent before
  // the ledger row is even written, so a death between the insert and the CAS leaves PENDING — and
  // #226's answer to that ("a redelivery goes on to the CAS instead of being dropped") only helps
  // when a redelivery actually arrives, which it usually does not, because Chatwoot holds a 200.
  // The staleness cutoff belongs in the QUERY, not only in the classifier, because the batch is
  // capped. Ordered and capped by `received_at` alone, a backlog of BATCH rows with old receipts
  // that were RECENTLY reclaimed fills every slot with live attempts, and a genuinely stranded row
  // with a newer receipt is skipped pass after pass — starved by rows the classifier then discards
  // as in-flight. Filtered here, every row in the batch is one the sweep will actually decide.
  //
  // The two arms are the same `claimedAt ?? receivedAt` the classifier uses, written the way a
  // nullable column has to be compared. The classifier still asks its own question afterwards: this
  // is which rows to look at, that is what they mean, and the boundary belongs to the pure rule.
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const rows = (await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findMany({
      where: {
        status: { in: ["PENDING", "PROCESSING"] },
        OR: [
          { claimedAt: { not: null, lt: cutoff } },
          { claimedAt: null, receivedAt: { lt: cutoff } },
        ],
      },
      // Neither of these decides a verdict, and a mutation of either leaves the suite green: the
      // cutoff above already excluded every row a live attempt could be working, so ORDER is
      // fairness under a backlog deeper than one batch, and the CAP is a bound on one pass's cost.
      // Both are policy about how the work is spread, not about what any row means, and the passes
      // are five minutes apart.
      orderBy: { receivedAt: "asc" },
      take: batch,
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
    const verdict = classifyStrandedDelivery(row, {
      now,
      staleAfterMs: STALE_AFTER_MS,
    });
    // Unreachable through the query above, which already excluded every row a live attempt could
    // still be working. Kept because the RULE is the classifier's, not the query's: they are two
    // statements of one threshold, and this is where they would be caught disagreeing rather than
    // where a fresh row would be marked terminal.
    if (verdict === "in-flight") continue;
    // Read the mirror only for a row that is going in the loss list: it is where the line is filed,
    // and a row that carried no message writes no line. A saved query per benign row, not a rule —
    // `record` returns before the line for any other verdict, so reading it anyway changes no
    // outcome and no test can hold this.
    const mirror =
      verdict === "no-message" ? null : await mirrorOf(row, tenantId, base);
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

  // NOTE: a rescue landing between this CAS and the line below writes its own correction (the row
  // was DEAD when it looked), so both lines end up on the conversation — the loss and the
  // `answered_late` closing it, out of order but complete. What is not possible is the loss going
  // unreported.
  //
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

async function deliverySweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  await sweepStrandedDeliveries({ tenantId: job.tenantId, base });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
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
    // NOTE: One perpetual row per tenant, same shape as the flow-log sweep and the heartbeat: a
    // completed pass clears the budget on its own (#287/#337), and a boot or a newly connected
    // account re-arming this row is the SAME unit of work, not a new one. Clearing here would hand a
    // sweep that keeps failing five fresh attempts every time an account is connected, which is the
    // cap doing nothing (#339).
    rearm: "same-work",
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
