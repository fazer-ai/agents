import type { PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  LEASE_TTL_MS,
  processLeaseId,
  pruneProcessLeases,
} from "@/lib/process-lease";
import { isDraining, trackWork } from "@/lib/shutdown";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { ChatwootApiError, type ChatwootClient } from "./client";
import {
  drainStoredChatwootDeliveries,
  heldDeliveryRowIds,
} from "./delivery-queue";
import { loadChatwootClient } from "./instance";
import { parseLiveConversation, TURN_BEARING_EVENT } from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
import { armDeliveryRecoveryOn, isRecoverableStrand } from "./recover-delivery";
import {
  armHumanReplyRecovery,
  namesRecoverableHumanReply,
} from "./recover-human-reply";
import { armTakeoverRecovery } from "./recover-takeover";
import {
  classifyStrandedDelivery,
  type StrandedVerdict,
} from "./stranded-delivery";

// Finds Chatwoot deliveries stranded by a process death and says so. One DELIVERY_SWEEP job per
// tenant, armed at boot and when a Chatwoot account is connected, self-rearming. It does not answer
// the customer itself: a turn run from here would skip the test-mode, availability and redirect
// gates the delivery path applies. It arms one DELIVERY_RECOVERY per row it declares lost, which
// re-runs the delivery path (a kind of its own because it spends a turn and this job is sized for
// queries, see lanes.ts). The report stands on its own: every stranded row becomes terminal,
// `WHERE status = 'DEAD'` lists the customers never answered, and each leaves an error-level line.
// See docs/chatwoot.md, "Webhook receiver".

// Longer than any legitimate delivery, a policy choice with no number to derive it from (the direct
// path runs the turn inside `processChatwootDelivery`, and neither the model call nor the tools have
// a timeout). Early costs one false alert, not a second turn: a turn still running has its row
// marked DEAD and its loss dispatched, then tx2 writes PROCESSED over it by id. The alert cannot be
// recalled. A claim that names its process (`claimed_by`) does not wait for this when
// that process is dead: `sweepDeadClaims` below settles it once its lease lapses. This window is what
// is left for a claim whose process is alive, and for one an older build made.
export const STALE_AFTER_MS = 30 * 60 * 1000;
// Cadence of the sweep. Recovery is not on the table, so what this buys is how fast an operator
// learns; minutes rather than hours because the answer is "go read this conversation".
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// One pass's ceiling. Generous because a row costs two indexed reads and one write, with no network
// and no model: the bound is against a pathological backlog, not against per-row cost.
const BATCH = 500;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Which messages the decision covered, as the caller can state it. The shapes are exclusive, as a
// union, because a filter with no message bound (`{ chatwootInstanceId, conversationId }`) would
// retire every non-terminal row on the conversation and close whatever loss sat there.
//
// The single-row shape exists because Chatwoot fans a message to up to two bot routes
// (`agent_bots_for`), each with its own ledger row; a gate exit taken because another party holds
// the conversation says only "we are not handling it", so `deliveryRowId` limits it to itself, and
// `covered` is `?: never` there, since only a caller speaking for the message may state coverage.
type CoveredMessages =
  // The burst a turn ran over, known exactly because the thread was re-fetched.
  | {
      messageIds: number[];
      covered: boolean;
      afterMessageId?: never;
      upToMessageId?: never;
      deliveryRowId?: never;
    }
  // The gate exits, which decide before any fetch and can only state the range their watermark
  // advance consumes: after the watermark as it stood, up to the payload's newest id (inclusive, the
  // message just decided about). Bounded at both ends: open at the bottom it would retire an earlier
  // strand the gate never decided about. A range is sound as a write at the decision, not as a read
  // afterwards. `afterMessageId` null means nothing had been handled yet.
  | {
      messageIds?: never;
      covered: boolean;
      afterMessageId: number | null;
      upToMessageId: number;
      deliveryRowId?: never;
    }
  | {
      deliveryRowId: bigint;
      covered?: never;
      messageIds?: never;
      afterMessageId?: never;
      upToMessageId?: never;
    };

// Whether a turn folded these messages into the thread, written on its own and settling nothing:
// `graph.invoke` persists the channel long before anyone knows whether a reply reaches the customer,
// and settling from there would close a row mid-turn and hide it from the sweep.
// Monotonic: only `false -> true` moves, since `false` is the absence of a turn (a later manual
// re-engagement can cover the same tail). On a PENDING row `true` is written (a re-fetching flush
// legitimately covers a not-yet-claimed message, and nothing later repairs that null) but `false`
// is not, since that row's own delivery is about to decide it. This touches only the column, so,
// unlike the settlement, it preempts no CAS.
export async function recordTurnCoverage(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  covered: boolean;
  // The rows this speaks for. Callers outside this module name their messages; the settlement passes
  // the filter it already built.
  where?: Record<string, unknown>;
  messageIds?: number[];
  base: PrismaClient;
}): Promise<void> {
  const scope = params.where ?? {
    chatwootInstanceId: params.instanceId,
    conversationId: params.conversationId,
    ...(params.messageIds === undefined
      ? {}
      : { inboundMessageId: { in: params.messageIds } }),
  };
  const covered = params.covered;
  await runScopedOn(params.base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.updateMany({
      // NOTE: `AND` rather than a spread, because the settlement's filter carries its own `OR` on the
      // wide scope. The coverage clause is an explicit list, not `not: true`: the column is nullable
      // and `NOT (col = true)` is NULL for a NULL row, exactly the rows this exists to write.
      where: {
        AND: [
          scope,
          ...(covered ? [] : [{ status: { not: "PENDING" as const } }]),
          covered
            ? { OR: [{ turnCovered: null }, { turnCovered: false }] }
            : { turnCovered: null },
        ],
      },
      data: { turnCovered: covered },
    }),
  ).catch((e) => {
    // Best-effort, like every other write on this path: a miss leaves the null the reader falls back
    // on, never a wrong answer.
    logger.warn(
      "chatwoot: could not record whether a turn folded the message in on conversation %d: %s",
      params.conversationId,
      e instanceof Error ? e.message : String(e),
    );
  });
}

// Retires the ledger rows of the messages a turn just ran over. A delivery row records one message
// and the sweep asks about that message; a per-conversation watermark cannot answer a per-message
// question, so the turn states it directly. A re-fetched burst can hold messages whose own delivery
// died (the flush re-reads everything above the watermark); ordinarily this updates nothing. Runs
// after the turn, never at the post gate, which claims before sending: retiring there would erase
// the evidence of the crash window the sweep exists to catch.
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
          // NOTE: an observer's row is never another route's to close. The wide scope exists because a
          // human, command or gate answers the message on any route that could have; the observer
          // owes the memory instead, and a failed ingestion leaves its row for the sweep. Closed from
          // here, the row turns terminal before the observer is done and the loss goes silent. The
          // observer settles its own row, `this-delivery` scoped. An explicit list, not `not: true`:
          // `NOT (col = true)` is NULL for a NULL row and would settle nothing.
          OR: [{ routeObserved: null }, { routeObserved: false }],
          // NOTE: nor a row that owes words rather than an answer (the transcribed `message_updated`):
          // matched by the wide scope, the creation's settlement would close it before its ingestion
          // is armed, hiding a later failure from the sweep. It settles its own row through the branch
          // above. On older rows `inboundMessageId` was only written for creations, so this excludes
          // nothing they held.
          event: TURN_BEARING_EVENT,
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

  // Two writes, not a transaction (nor with the preceding watermark advance): every window
  // between them leaves a state that is wrong and visible, never a quiet loss, and a transaction
  // would span `writeFlowEvent`'s alert dispatch to somebody else's endpoint. PROCESSING first: the
  // other order lets the sweep's PROCESSING -> DEAD land between them and leaves the row DEAD for
  // good. PROCESSING only, never PENDING: a burst can contain a message between its insert and its
  // CAS, and retiring it would make that delivery skip its mirror write. Every settlement passes
  // here, so the "turn folded the message in" fact for continuous ingestion is written here too.
  const answered = params.settlement === "answered";
  const { count } = await runScopedOn(
    params.base,
    sysCtx(params.tenantId),
    (db) =>
      db.chatwootWebhookDelivery.updateMany({
        // NOTE: a role not yet stated is not `false`. The receiver writes the role just after the
        // claim, so settling a PROCESSING row that has said nothing could close an observer's row
        // before its ingestion. Nothing strands: the migration stamped `false` on every worklist row,
        // so a null one is a live delivery whose own tx2 closes it. The DEAD statement is unaffected.
        where: {
          ...where,
          // NOTE: only on the wide scope. A single-row settlement already names its row, and the
          // observer's own settlement is that shape: requiring `false` there would match nothing and
          // leave a handled delivery for the sweep to report and replay.
          ...(params.deliveryRowId === undefined
            ? { routeObserved: false }
            : {}),
          status: "PROCESSING",
        },
        data: { status: "PROCESSED", processedAt: new Date() },
      }),
  );

  // AND, IN A STATEMENT OF ITS OWN, WHETHER A TURN FOLDED THESE MESSAGES INTO THE THREAD — only
  // where the scope speaks for the message, which the union above is what says: a single-row
  // settlement is a route reporting about ITSELF, and "I am not handling this" is not evidence about
  // the route that is.
  if (params.covered !== undefined) {
    await recordTurnCoverage({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      conversationId: params.conversationId,
      covered: params.covered,
      where,
      base: params.base,
    });
  }

  // And the rows that need a closing line, the ones that were DEAD. One UPDATE naming DEAD in
  // its predicate and returning what it moved, because a read first would race the sweep both ways
  // (a correction lost, or written twice). DEAD is corrected, not contradicted: the sweep's verdict
  // is an inference and a turn over the message is direct evidence. The loss line stays; the one
  // below says how it ended.
  const corrected = await runScopedOn(
    params.base,
    sysCtx(params.tenantId),
    (db) =>
      db.chatwootWebhookDelivery.updateManyAndReturn({
        where: { ...where, status: "DEAD" },
        data: { status: "PROCESSED", processedAt: new Date() },
        select: {
          deliveryId: true,
          inboundMessageId: true,
          receivedAt: true,
          chatwootInstanceId: true,
          conversationId: true,
          routeObserved: true,
          routeAgentBotId: true,
        },
      }),
  );

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
    // Filed under the inbox and the agent the delivery was for, read off its recorded route the way
    // the loss line it closes was (an observer's route is the observer's): a channel's excluded
    // agents filter the correction by these, and a line filed under nobody passes every exclusion.
    // Null when the mirror cannot be read; the line is still written.
    const mirror = await mirrorOf(row, params.tenantId, params.base).catch(
      (error) => {
        logger.warn(
          { error, deliveryId: row.deliveryId },
          "chatwoot: could not read the agent a stranded-delivery correction is filed under; filing it under none",
        );
        return null;
      },
    );
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
        agentId: mirror?.lineAgentId ?? null,
        inboxId: mirror?.inboxId ?? null,
        base: params.base,
      },
      {
        stage: "delivery",
        level: "warn",
        // NOTE: a "warn" that pages nobody alone: it counts toward the recovery rate, one alert per
        // window (`recoverySubjectOf`, flowlog/alerts.ts), unless the answer came late enough to keep
        // its own. Routing it as "error" is worse: alert dispatch coalesces by (channel, stage,
        // level), so the correction would increment the loss alert instead of closing it. The DEAD
        // worklist is correct the instant this lands.
        status: "ok",
        detail: {
          outcome: answered ? "answered_late" : "consumed_late",
          messageId: row.inboundMessageId,
          // How long after the message arrived it was settled: an answer that came late enough keeps an
          // alert of its own, where every other recovery only counts toward the recovery rate.
          ageMs: Date.now() - row.receivedAt.getTime(),
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
  // How many passes have tried to read a stranded conversation event's state back from Chatwoot.
  attempts?: number;
  // Read only by the dead-claim pass, which takes the row from the claim it judged dead and no other:
  // a recovery that claimed it since stamps its own process, and the CAS then matches nothing.
  claimedBy?: string | null;
  conversationId: number | null;
  inboundMessageId: number | null;
  humanReplyShape: string | null;
  // The reply's own id, written at insert. It lets the words be read back and folded into memory
  // (see `armReplyMemory`).
  humanReplyMessageId: number | null;
  routeObserved: boolean | null;
  routeAgentBotId: number | null;
  routeRemembers: boolean | null;
}

export interface SweepCounts {
  // Terminal, a conversation event whose state was read back from Chatwoot and given to the mirror
  // (or found gone there). Apart from `closed`: the row owed the mirror something, and got it now.
  conversationState: number;
  // Terminal, nothing lost: the delivery carried no inbound message at all.
  closed: number;
  // Terminal, a customer message lost.
  lost: number;
  // Terminal and nothing lost, but a side effect was owed and never ran: a colleague's reply whose
  // takeover is armed for recovery. Apart from `closed`: a row that needed something and got it late.
  owed: number;
  // Terminal, nothing a customer sent at stake, but an observer's route lost the ingestion of a
  // colleague's reply. Neither `closed` nor `owed`: nothing can replay it, so the count and the line
  // beside it are the whole record.
  observerStrands: number;
  // Terminal, no customer waiting, and a customer message's transcription owed to memory. Apart from
  // `lost` (the DEAD worklist is customers never answered, and no reply was coming here) and from
  // `owed` (recovered by the ordinary delivery replay).
  owedTranscription: number;
  // Terminal, a colleague's reply, and a route no build ever named: the process died between the
  // INSERT and the claim. Apart from `owed` (the takeover is armed on a guess) and from
  // `observerStrands` (the gap may not exist): only one of the two stories happened.
  roleUnstated: number;
  // The row moved under the sweep (a redelivery claimed it) between the scan and the write.
  raced: number;
}

// The conversation's mirror row, for the ids the flow line is filed under. Null when the mirror does
// not know this conversation (a delivery that died before the mirror write); the line is still
// filed. It reads no watermark: whether anything covered the message is the row's own status.
async function mirrorOf(
  row: Pick<
    StrandedRow,
    | "chatwootInstanceId"
    | "conversationId"
    | "routeObserved"
    | "routeAgentBotId"
  >,
  tenantId: bigint,
  base: PrismaClient,
  // Asked only by the verdict that reports it, and here, before the terminal transition: after
  // `finish` the row is never scanned again, so a lookup that threw there would take the only record
  // of an unrecoverable gap with it.
  withResponderRoute = false,
): Promise<{
  conversationRowId: bigint;
  inboxId: bigint | null;
  agentId: bigint | null;
  // The agent the delivery was FOR, which the flow line is filed under: the responder, except on an
  // observer's route, where it is the agent behind the route's bot (null when no persona carries it).
  lineAgentId: bigint | null;
  // Whether that responder has a ROUTE of its own — a bot row the fork could have delivered to.
  // Null when it was not asked (the loss verdict does not need it) or could not be read.
  responderHasRoute: boolean | null;
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
    const agentId = inbox?.agentId ?? null;
    const observerBotId =
      row.routeObserved === true ? row.routeAgentBotId : null;
    const lineAgentId =
      row.routeObserved !== true
        ? agentId
        : observerBotId === null
          ? null
          : ((
              await db.chatwootAgentBot.findFirst({
                where: {
                  tenantId,
                  chatwootInstanceId: row.chatwootInstanceId,
                  chatwootAgentBotId: observerBotId,
                },
                select: { agentId: true },
              })
            )?.agentId ?? null);
    return {
      conversationRowId: conv.id,
      inboxId: conv.inboxId,
      agentId,
      lineAgentId,
      responderHasRoute:
        !withResponderRoute || agentId === null
          ? null
          : (await db.chatwootAgentBot.count({
              where: {
                tenantId,
                chatwootInstanceId: row.chatwootInstanceId,
                agentId,
              },
            })) > 0,
    };
  });
}

// The terminal write's guard: the attempt the scan read, not just the status. Every claim writes a
// new `claimedAt`, so a row claimed again since the read (a recovery from DEAD, even by the same
// process under the same lease) no longer matches; and, for a row the dead-claim pass read, the
// claimer it judged dead.
function casOn(row: StrandedRow) {
  return {
    id: row.id,
    status: row.status,
    claimedAt: row.claimedAt,
    ...(row.claimedBy == null ? {} : { claimedBy: row.claimedBy }),
  };
}

// Writes the row's terminal state, CASing on the status the scan read. Losing the CAS means a
// redelivery claimed the row and is processing it now, so nothing is recorded. On a PENDING row,
// winning races the delivery's own claim and discards a redelivery arriving that instant; the report
// is still true, and taking a row back from a terminal state is the DELIVERY_RECOVERY's job, not a
// wider write here. Exported for the test: a constructed race goes green for the wrong reason.
export async function finish(
  row: StrandedRow,
  tenantId: bigint,
  status: "PROCESSED" | "DEAD",
  base: PrismaClient,
): Promise<boolean> {
  const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.updateMany({
      where: casOn(row),
      data: { status, processedAt: new Date() },
    }),
  );
  return count > 0;
}

// The DEAD verdict and the recovery it owes, committed together: a DEAD row with no job is invisible to
// every later sweep (they read PENDING and PROCESSING), so arming after the CAS, as its own write,
// left the customer on the worklist with nothing retrying them whenever that write failed. A failure
// here rolls both back and the row stays where the next sweep finds it again.
async function finishDead(
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
  armRecovery: boolean,
  label: string,
): Promise<"won" | "lost" | "failed"> {
  try {
    return await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const { count } = await db.chatwootWebhookDelivery.updateMany({
        where: casOn(row),
        data: { status: "DEAD", processedAt: new Date() },
      });
      if (count === 0) return "lost";
      if (armRecovery) await armDeliveryRecoveryOn(db, tenantId, row.id);
      return "won";
    });
  } catch (error) {
    logger.error(
      { error },
      `chatwoot delivery sweep: ${label} could not be declared DEAD with its recovery; left for the next sweep`,
    );
    return "failed";
  }
}

export interface SweepStrandedDeliveriesParams {
  tenantId: bigint;
  base: PrismaClient;
  deps?: ConversationStateDeps;
  now?: Date;
  // One pass's ceiling, overridable so the batch's fairness can be asked with a handful of rows.
  batch?: number;
  // The wall-clock time the pass may spend reading conversations back (see `settleConversationEvents`).
  readBudgetMs?: number;
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
  const counts: SweepCounts = {
    closed: 0,
    lost: 0,
    owed: 0,
    observerStrands: 0,
    conversationState: 0,
    owedTranscription: 0,
    roleUnstated: 0,
    raced: 0,
  };

  // Both non-terminal states strand: a death between insert and CAS leaves PENDING, and a
  // redelivery rarely comes since Chatwoot holds a 200. The staleness cutoff is in the query, not
  // only the classifier, because the batch is capped: ordered by `received_at` alone, recently
  // reclaimed old rows would fill every slot and starve a real strand. Both arms are the
  // classifier's `claimedAt ?? receivedAt`, spelled for a nullable column.
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const held = heldDeliveryRowIds();
  // Two queries, each with its own cap: the conversation events this pass reads back from Chatwoot,
  // and every other row. Selected together, a backlog of conversation events older than a customer's
  // message fills the oldest-first batch, and with the read budget settling only some of them per
  // pass, the message would wait pass after pass before its recovery is even armed.
  const stateEvents = [...CONVERSATION_STATE_EVENTS];
  const strandedOf = (readBack: boolean) =>
    runScopedOn(base, sysCtx(tenantId), (db) =>
      db.chatwootWebhookDelivery.findMany({
        where: {
          status: { in: ["PENDING", "PROCESSING"] },
          OR: [
            { claimedAt: { not: null, lt: cutoff } },
            { claimedAt: null, receivedAt: { lt: cutoff } },
          ],
          // A PENDING row that still holds its body is the drain's (delivery-queue.ts), which the
          // handler ran just before this pass and which drops the body of every row it gives up on;
          // and one this process holds in its admission queue is waiting, not stranded.
          AND: [
            { NOT: { status: "PENDING", payload: { not: null } } },
            ...(held.length > 0
              ? [{ NOT: { status: "PENDING" as const, id: { in: held } } }]
              : []),
            readBack
              ? { event: { in: stateEvents }, conversationId: { not: null } }
              : {
                  NOT: {
                    event: { in: stateEvents },
                    conversationId: { not: null },
                  },
                },
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
          attempts: true,
          conversationId: true,
          inboundMessageId: true,
          humanReplyShape: true,
          humanReplyMessageId: true,
          routeObserved: true,
          routeAgentBotId: true,
          routeRemembers: true,
        },
      }),
    ) as Promise<StrandedRow[]>;
  const rows = [...(await strandedOf(false)), ...(await strandedOf(true))];

  const { groups, rest } = takeConversationEvents(
    rows.map((row) => ({ row, tenantId })),
    now,
    STALE_AFTER_MS,
  );
  for (const { row } of rest) {
    await settleStranded(row, tenantId, base, now, STALE_AFTER_MS, counts);
  }
  await settleConversationEvents(
    groups,
    base,
    counts,
    readClock(params.deps) + (params.readBudgetMs ?? SWEEP_READ_BUDGET_MS),
    params.deps,
  );
  return counts;
}

function emptyCounts(): SweepCounts {
  return {
    closed: 0,
    lost: 0,
    owed: 0,
    observerStrands: 0,
    conversationState: 0,
    owedTranscription: 0,
    roleUnstated: 0,
    raced: 0,
  };
}

// One stranded row to its verdict and its terminal state. `staleAfterMs` is the window the row has to
// be past: the stranded sweep's for a row it reads by age, none for one whose claimer is known dead.
async function settleStranded(
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
  now: Date,
  staleAfterMs: number,
  counts: SweepCounts,
): Promise<void> {
  const verdict = classifyStrandedDelivery(row, { now, staleAfterMs });
  // NOTE: unreachable through either caller (the stranded sweep's query already cut at the same
  // window, and the dead-claim pass asks with none), kept because the rule is the classifier's: two
  // statements of one threshold, and this is where they would be caught disagreeing.
  if (verdict === "in-flight") return;
  // The mirror is read only for a row going in the loss list (the only verdict that writes
  // a line). A throwing read must not cost the report, since `record` marks the row terminal
  // first; null is "could not tell", said out loud.
  const mirror =
    verdict === "lost" ||
    verdict === "observer-strand" ||
    verdict === "role-unstated"
      ? await mirrorOf(
          row,
          tenantId,
          base,
          verdict === "observer-strand" || verdict === "role-unstated",
        ).catch((err) => {
          logger.warn(
            { err, deliveryId: row.deliveryId },
            "chatwoot delivery sweep: the mirror of a stranded delivery could not be read",
          );
          return null;
        })
      : null;
  await record(verdict, row, tenantId, mirror, counts, base);
}

// STRANDED CONVERSATION EVENTS. A status or assignee change reaches the mirror only through its
// conversation event, and that row owes no turn, so the classifier closes it as having carried
// nothing. Closed that way, the change is lost: a resolve stranded behind the `pending` its own label
// write caused leaves the mirror `pending` for good. The event's body is not kept once the row is
// claimed, so the state is read back from Chatwoot and applied by `reconcileMirrorFromLive`, under
// the same version ordering the live path uses: a newer state already mirrored still wins.

const CONVERSATION_STATE_EVENTS: ReadonlySet<string> = new Set([
  "conversation_resolved",
  "conversation_opened",
  "conversation_status_changed",
  "conversation_updated",
]);

// Passes that may fail to read a stranded event's conversation before its rows close without it: an
// outage longer than this many sweep intervals is past what the event could still say.
export const CONVERSATION_STATE_READS = 3;

export interface ConversationStateDeps {
  makeClient?: () => Promise<ChatwootClient>;
  // The clock the read budget is measured on.
  clock?: () => number;
}
const readClock = (deps?: ConversationStateDeps) => (deps?.clock ?? Date.now)();

type LiveRead =
  | {
      kind: "state";
      live: NonNullable<ReturnType<typeof parseLiveConversation>>;
    }
  | { kind: "gone" }
  | { kind: "unreadable"; err: unknown; instanceWide: boolean };

// The statuses that speak for the whole account rather than for one conversation: the token refused,
// the rate limit, and the gateway or the server down. Any other HTTP status, or a body that does not
// parse, is about the conversation asked for, and says nothing about its siblings.
const INSTANCE_WIDE_STATUSES = new Set([401, 403, 429, 502, 503, 504]);

async function readLive(
  tenantId: bigint,
  instanceId: bigint,
  conversationId: number,
  base: PrismaClient,
  deps?: ConversationStateDeps,
): Promise<LiveRead> {
  try {
    const make = deps?.makeClient;
    const client = await loadChatwootClient(tenantId, instanceId, {
      base,
      ...(make ? { makeClient: () => make() } : {}),
    });
    const live = parseLiveConversation(
      await client.getConversation(conversationId),
    );
    return live
      ? { kind: "state", live }
      : {
          kind: "unreadable",
          err: new Error("unparseable conversation"),
          instanceWide: false,
        };
  } catch (err) {
    if (err instanceof ChatwootApiError && err.status === 404) {
      return { kind: "gone" };
    }
    // No answer at all (a timeout, a refused connection, a client that could not be built) is the
    // instance's, like the statuses above. A 200 whose body does not decode is the conversation's.
    if (err instanceof SyntaxError) {
      return { kind: "unreadable", err, instanceWide: false };
    }
    return {
      kind: "unreadable",
      err,
      instanceWide:
        !(err instanceof ChatwootApiError) ||
        INSTANCE_WIDE_STATUSES.has(err.status),
    };
  }
}

interface ConversationEventGroup {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  rows: StrandedRow[];
}

// Takes the stranded conversation events out of `rows`, grouped by conversation so each is read once
// however many of its rows stranded; returns the rest for the ordinary verdicts.
function takeConversationEvents(
  rows: Array<{ row: StrandedRow; tenantId: bigint }>,
  now: Date,
  staleAfterMs: number,
): {
  groups: ConversationEventGroup[];
  rest: Array<{ row: StrandedRow; tenantId: bigint }>;
} {
  const rest: Array<{ row: StrandedRow; tenantId: bigint }> = [];
  const groups = new Map<string, ConversationEventGroup>();
  for (const item of rows) {
    const { row, tenantId } = item;
    if (
      row.conversationId === null ||
      !CONVERSATION_STATE_EVENTS.has(row.event) ||
      classifyStrandedDelivery(row, { now, staleAfterMs }) !== "no-message"
    ) {
      rest.push(item);
      continue;
    }
    const key = `${tenantId}:${row.chatwootInstanceId}:${row.conversationId}`;
    const g = groups.get(key) ?? {
      tenantId,
      instanceId: row.chatwootInstanceId,
      conversationId: row.conversationId,
      rows: [],
    };
    g.rows.push(row);
    groups.set(key, g);
  }
  return { groups: [...groups.values()], rest };
}

// Publishes the state a read-back left on the row. The reconcile announces only its deferred
// transition and leaves every other one to its caller, and a console showing the list learns a
// status or a holder only from this event.
async function announceReconciled(
  tenantId: bigint,
  base: PrismaClient,
  where: { id: bigint } | { instanceId: bigint; conversationId: number },
  state: NonNullable<
    Awaited<ReturnType<typeof reconcileMirrorFromLive>>["state"]
  >,
): Promise<void> {
  const id =
    "id" in where
      ? where.id
      : (
          await runScopedOn(base, sysCtx(tenantId), (db) =>
            db.conversation.findUnique({
              where: {
                tenantId_chatwootInstanceId_chatwootConversationId: {
                  tenantId,
                  chatwootInstanceId: where.instanceId,
                  chatwootConversationId: where.conversationId,
                },
              },
              select: { id: true },
            }),
          )
        )?.id;
  if (id === undefined) return;
  broadcastConversationEvent(tenantId, {
    conversationId: String(id),
    status: state.status,
    assigneeId: state.assigneeId,
    assigneeType: state.assigneeType,
    lastEventAt: state.lastEventAt ? state.lastEventAt.toISOString() : null,
  });
}

// The wall-clock time one pass spends reading conversations back. The reads are sequential and each
// can take a request timeout, so without a ceiling a backlog of distinct conversations runs the sweep
// job past its scheduler deadline (and the dead-claim pass past its interval, holding its running
// flag). What the ceiling leaves unread stays as it was for the next pass: a stranded row is still
// PROCESSING, and an unconfirmed close is still selected.
export const SWEEP_READ_BUDGET_MS = 60_000;
export const DEAD_CLAIM_READ_BUDGET_MS = 10_000;

// A conversation Chatwoot no longer has: its stranded events close, or its stamp is cleared, with
// nothing applied, so the flow log says which and why instead of the row leaving in silence. Filed
// under the mirrored conversation when there is one; `info`, since nobody is waiting on it.
async function noteConversationGone(
  tenantId: bigint,
  base: PrismaClient,
  instanceId: bigint,
  conversationId: number,
  closed: string,
): Promise<void> {
  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: { id: true, inboxId: true },
    }),
  ).catch(() => null);
  logger.info(
    "chatwoot delivery sweep: conversation %d is gone from Chatwoot (404); %s with nothing applied",
    conversationId,
    closed,
  );
  await writeFlowEvent(
    {
      tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: conv?.id ?? null,
      agentId: null,
      inboxId: conv?.inboxId ?? null,
      base,
    },
    {
      stage: "delivery",
      level: "info",
      status: "ok",
      detail: { outcome: "conversation_gone", conversationId, closed },
    },
  );
}

// Settles the groups `takeConversationEvents` took, AFTER the pass's ordinary verdicts: those are the
// customers waiting on a recovery, and a read here can take a request timeout. An instance that failed
// one read is not asked again in the same pass; its other conversations count the failure too, so an
// instance that is down costs one failed read per pass and its rows still close after the budget.
async function settleConversationEvents(
  groups: ConversationEventGroup[],
  base: PrismaClient,
  counts: SweepCounts,
  readUntil: number,
  deps?: ConversationStateDeps,
): Promise<void> {
  const down = new Map<string, unknown>();
  for (const g of groups) {
    const instanceKey = `${g.tenantId}:${g.instanceId}`;
    // The budget bounds network reads only: a failure already known for the instance still advances
    // every one of its rows, or a timeout that outran the budget would leave all but the first row
    // where they were, holding the scan pass after pass.
    if (!down.has(instanceKey) && readClock(deps) >= readUntil) continue;
    const read: LiveRead = down.has(instanceKey)
      ? { kind: "unreadable", err: down.get(instanceKey), instanceWide: true }
      : await readLive(g.tenantId, g.instanceId, g.conversationId, base, deps);
    if (read.kind === "unreadable") {
      if (read.instanceWide) down.set(instanceKey, read.err);
      logger.warn(
        { err: read.err, conversationId: g.conversationId },
        "chatwoot delivery sweep: a stranded conversation event's state could not be read from Chatwoot",
      );
      // Each row against its OWN count: a row that stranded after the earlier failures is owed its
      // own reads, not the remainder of an older row's budget.
      for (const row of g.rows) {
        if ((row.attempts ?? 0) + 1 >= CONVERSATION_STATE_READS) {
          logger.warn(
            { conversationId: g.conversationId, deliveryId: row.deliveryId },
            "chatwoot delivery sweep: a stranded conversation event closes without its state after %d failed reads",
            CONVERSATION_STATE_READS,
          );
          if (await finish(row, g.tenantId, "PROCESSED", base))
            counts.closed += 1;
          else counts.raced += 1;
          continue;
        }
        await runScopedOn(base, sysCtx(g.tenantId), (db) =>
          db.chatwootWebhookDelivery.updateMany({
            where: casOn(row),
            data: { attempts: { increment: 1 } },
          }),
        );
      }
      continue;
    }
    if (read.kind === "gone") {
      await noteConversationGone(
        g.tenantId,
        base,
        g.instanceId,
        g.conversationId,
        `${g.rows.length} stranded conversation event(s) closed`,
      );
    }
    if (read.kind === "state") {
      const r = await reconcileMirrorFromLive({
        tenantId: g.tenantId,
        instanceId: g.instanceId,
        conversationId: g.conversationId,
        live: read.live,
        base,
      });
      // The returned state, not only a full application: one field can land while the other loses
      // to its own ordering mark, and the one that landed is still news to an open list.
      if (r.state) {
        await announceReconciled(
          g.tenantId,
          base,
          { instanceId: g.instanceId, conversationId: g.conversationId },
          r.state,
        );
      }
    }
    for (const row of g.rows) {
      if (await finish(row, g.tenantId, "PROCESSED", base)) {
        counts.conversationState += 1;
      } else {
        counts.raced += 1;
      }
    }
  }
}

// A CLOSE THIS SIDE MADE THAT THE MIRROR NEVER SAW. Our resolve records who closed the conversation
// (`resolved_by`) when it toggles, and the mirror takes the status from the webhook that follows;
// a `resolved_by` still standing on a row that does not say `resolved` long after that webhook was
// due is a close whose event was lost, which includes every row stranded before the sweep above read
// these events back. Read back the same way. Whatever the read finds, the stamp stops naming the
// row's state unless that state is `resolved`, so a row leaves this list once read: a close the
// source has undone since (the customer wrote again) is no longer the conversation's state.

const UNCONFIRMED_CLOSE_BATCH = 50;

export interface ReconcileUnconfirmedClosesParams {
  tenantId: bigint;
  base: PrismaClient;
  now?: Date;
  deps?: ConversationStateDeps;
  batch?: number;
  readBudgetMs?: number;
}

export async function reconcileUnconfirmedCloses(
  params: ReconcileUnconfirmedClosesParams,
): Promise<number> {
  const { tenantId, base } = params;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const readUntil =
    readClock(params.deps) + (params.readBudgetMs ?? SWEEP_READ_BUDGET_MS);
  // Raw, with `'resolved'` as a literal: that is what lets the planner prove the partial index
  // `conversations_unconfirmed_close_idx` applies (a bound parameter cannot imply its predicate in a
  // generic plan), so a pass costs its worklist and not the tenant's whole history.
  const rows = await runScopedOn(
    base,
    sysCtx(tenantId),
    (db) =>
      db.$queryRaw<
        Array<{
          id: bigint;
          chatwootInstanceId: bigint;
          chatwootConversationId: number;
          updatedAt: Date;
        }>
      >`
      SELECT id, chatwoot_instance_id AS "chatwootInstanceId",
             chatwoot_conversation_id AS "chatwootConversationId", updated_at AS "updatedAt"
        FROM conversations
       WHERE tenant_id = ${tenantId}
         AND resolved_by IS NOT NULL
         AND status <> 'resolved'
         AND updated_at < ${cutoff}
       ORDER BY updated_at
       LIMIT ${params.batch ?? UNCONFIRMED_CLOSE_BATCH}`,
  );
  let applied = 0;
  // As in `settleConversationEvents`: an instance that failed a read is not asked again this pass, so
  // one that is down costs a single request timeout and not one per row, which the job's deadline
  // could not hold.
  const down = new Set<bigint>();
  // A row that could not be read goes to the back of the list (its `updated_at` is touched), so the
  // closes of an instance that is down cannot hold the whole oldest-first batch pass after pass.
  const postpone = (id: bigint) =>
    runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.updateMany({
        where: { id },
        data: { updatedAt: new Date() },
      }),
    );
  for (const conv of rows) {
    if (down.has(conv.chatwootInstanceId)) {
      await postpone(conv.id);
      continue;
    }
    if (readClock(params.deps) >= readUntil) continue;
    const read = await readLive(
      tenantId,
      conv.chatwootInstanceId,
      conv.chatwootConversationId,
      base,
      params.deps,
    );
    if (read.kind === "unreadable") {
      if (read.instanceWide) down.add(conv.chatwootInstanceId);
      logger.warn(
        { err: read.err, conversationId: conv.chatwootConversationId },
        "chatwoot delivery sweep: a close the mirror never confirmed could not be read from Chatwoot; left for a later pass",
      );
      await postpone(conv.id);
      continue;
    }
    if (read.kind === "gone") {
      await noteConversationGone(
        tenantId,
        base,
        conv.chatwootInstanceId,
        conv.chatwootConversationId,
        "its unconfirmed close stamp cleared",
      );
    }
    if (read.kind === "state") {
      const r = await reconcileMirrorFromLive({
        tenantId,
        instanceId: conv.chatwootInstanceId,
        conversationId: conv.chatwootConversationId,
        live: read.live,
        base,
      });
      if (r.applied) applied += 1;
      if (r.state) {
        await announceReconciled(tenantId, base, { id: conv.id }, r.state);
      }
    }
    // Only a row nothing has written since this pass selected it. A close recorded while Chatwoot was
    // being asked carries a stamp of its own, which its webhook (still on the way) confirms, and the
    // stamp's version cannot tell the two apart on a Chatwoot that sends none. A row the reconcile
    // above wrote is left too, and cleared on a later pass once it is stale again.
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.updateMany({
        where: {
          id: conv.id,
          updatedAt: conv.updatedAt,
          resolvedBy: { not: null },
          status: { not: "resolved" },
        },
        data: { resolvedBy: null, resolvedByAt: null },
      }),
    );
  }
  return applied;
}

// How often each process looks for claims whose process died. Together with the lease's lifetime
// this is the whole wait of a delivery a dead process claimed: at most `LEASE_TTL_MS` plus one pass
// after the death, or one pass after the first process starts when none was running.
export const DEAD_CLAIM_PASS_MS = 15_000;
// Rows one pass reads. The rows a dead process can leave are bounded by what it was processing,
// which the admission bound caps per lane (`CHATWOOT_DELIVERY_CONCURRENCY`).
const DEAD_CLAIM_BATCH = 500;

export interface SweepDeadClaimsParams {
  base: PrismaClient;
  // This process's lease, whose claims are never taken: they are alive by definition while it runs,
  // including the ones a live attempt left PROCESSING on purpose for the stranded sweep.
  self?: string;
  now?: Date;
  batch?: number;
  ttlMs?: number;
  deps?: ConversationStateDeps;
  readBudgetMs?: number;
}

// Settles the PROCESSING rows whose claim names a process that is no longer alive: the
// same verdicts the stranded sweep gives, without its 30-minute window, since a dead claimer is the
// one thing that window was waiting to be sure of. A row claimed by a live process, or by an older
// build (no `claimed_by`), is not read. Every process runs it: the CAS on the dead claim makes
// concurrent passes settle a row once.
export async function sweepDeadClaims(
  params: SweepDeadClaimsParams,
): Promise<SweepCounts> {
  const { base } = params;
  const now = params.now ?? new Date();
  const self = params.self ?? processLeaseId();
  // The rows a read-back settles sort after every other one (false before true): their reads are
  // budgeted and may leave most of them for the next pass, so sorted by `claimed_at` alone a backlog
  // of them would fill the capped batch ahead of a customer's message.
  const counts = emptyCounts();
  // One statement, one snapshot: a process commits its lease before it stamps a claim, so a claim
  // seen here names a lease seen here too unless that process is gone. Live claims are left out of the
  // read itself, so older live ones filling a capped batch cannot hide a dead one pass after pass. And
  // every column the verdict reads comes from it: a second read could return the row claimed again by
  // a live process, and the write, guarded on the claimer the row carries, would end that attempt.
  const ttlSeconds = (params.ttlMs ?? LEASE_TTL_MS) / 1000;
  const rows = await asSuperAdminOn(
    base,
    (db) =>
      db.$queryRaw<Array<StrandedRow & { tenantId: bigint }>>`
      SELECT d.id, d.tenant_id AS "tenantId", d.status::text AS status,
             d.chatwoot_instance_id AS "chatwootInstanceId", d.delivery_id AS "deliveryId",
             d.event, d.received_at AS "receivedAt", d.claimed_at AS "claimedAt",
             d.claimed_by::text AS "claimedBy", d.attempts, d.conversation_id AS "conversationId",
             d.inbound_message_id AS "inboundMessageId", d.human_reply_shape AS "humanReplyShape",
             d.human_reply_message_id AS "humanReplyMessageId", d.route_observed AS "routeObserved",
             d.route_agent_bot_id AS "routeAgentBotId", d.route_remembers AS "routeRemembers"
        FROM chatwoot_webhook_deliveries d
       WHERE d.status = 'PROCESSING'
         AND d.claimed_by IS NOT NULL
         AND d.claimed_by <> ${self}::uuid
         AND NOT EXISTS (
               SELECT 1 FROM process_leases l
                WHERE l.id = d.claimed_by
                  AND l.heartbeat_at > now() - make_interval(secs => ${ttlSeconds}))
       ORDER BY (d.event = ANY(${[...CONVERSATION_STATE_EVENTS]}::text[])
                 AND d.conversation_id IS NOT NULL),
                d.claimed_at
       LIMIT ${params.batch ?? DEAD_CLAIM_BATCH}`,
  );
  // No window at all, not zero: `claimedAt` is the dead process's clock, and on a host a little ahead
  // of this one a zero window would read the claim as in flight until the clocks agree.
  const { groups, rest } = takeConversationEvents(
    rows.map(({ tenantId, ...row }) => ({ row, tenantId })),
    now,
    Number.NEGATIVE_INFINITY,
  );
  for (const { row, tenantId } of rest) {
    await settleStranded(
      row,
      tenantId,
      base,
      now,
      Number.NEGATIVE_INFINITY,
      counts,
    );
  }
  await settleConversationEvents(
    groups,
    base,
    counts,
    readClock(params.deps) + (params.readBudgetMs ?? DEAD_CLAIM_READ_BUDGET_MS),
    params.deps,
  );
  return counts;
}

interface DeadClaimHolder {
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
}
const DEAD_CLAIM_KEY = Symbol.for("fazerai.deadClaimSweep");
function deadClaimHolder(): DeadClaimHolder {
  const g = globalThis as unknown as Record<symbol, DeadClaimHolder>;
  g[DEAD_CLAIM_KEY] ??= { timer: null, running: false };
  return g[DEAD_CLAIM_KEY];
}

// One pass, registered with the shutdown drain: a verdict that closes a row and then arms what it
// owes is two writes, and an exit between them leaves a terminal row nothing revisits. A draining
// process starts none.
export async function runDeadClaimPass(base: PrismaClient): Promise<void> {
  const h = deadClaimHolder();
  if (h.running || isDraining()) return;
  h.running = true;
  await trackWork("chatwoot-dead-claim-pass", () =>
    deadClaimPass(base),
  ).finally(() => {
    h.running = false;
  });
}

async function deadClaimPass(base: PrismaClient): Promise<void> {
  try {
    const c = await sweepDeadClaims({ base });
    const settled =
      c.closed +
      c.lost +
      c.owed +
      c.observerStrands +
      c.owedTranscription +
      c.roleUnstated;
    if (settled > 0) {
      logger.warn(
        "chatwoot: settled %d deliveries claimed by a process that is no longer running (%d to the recovery)",
        settled,
        c.lost,
      );
    }
    await pruneProcessLeases(base);
  } catch (err) {
    logger.warn(
      { err },
      "chatwoot: the dead-claim pass failed; the next one retries",
    );
  }
}

// Runs the dead-claim pass now and every `DEAD_CLAIM_PASS_MS`, in every process (a web replica's
// death is found by the leader, and the leader's by whatever starts next). Idempotent.
export function startDeadClaimSweep(base: PrismaClient = basePrisma): void {
  const h = deadClaimHolder();
  if (h.timer !== null) return;
  h.timer = setInterval(() => void runDeadClaimPass(base), DEAD_CLAIM_PASS_MS);
  h.timer.unref?.();
  void runDeadClaimPass(base);
}

export function stopDeadClaimSweep(): void {
  const h = deadClaimHolder();
  if (h.timer !== null) clearInterval(h.timer);
  h.timer = null;
}

// The words, a second debt on the same row. Not a verdict: the verdicts answer what the conversation
// was owed, and any of them can sit on a row that also owed a memory append; the two are armed
// independently. Asked of the row alone; everything it cannot say (provider shape, whether the route
// remembers, whether the thread exists) is re-asked by ./recover-human-reply.ts, since
// `route_remembers = false` reads the same for a failed arm and a route that never remembers. Free
// where not owed (`not-owed`), harmless where done (the ingest dedup, ../../graph/ingest.ts).
async function armReplyMemory(
  row: StrandedRow,
  tenantId: bigint,
  base: PrismaClient,
  label: string,
): Promise<boolean | null> {
  if (!namesRecoverableHumanReply(row)) return null;
  try {
    await armHumanReplyRecovery(tenantId, row.id, base);
    return true;
  } catch (error) {
    // NOTE: `warn`, not `error`: the receiver already reported this loss at `error` on the
    // conversation, and that first line is the one an operator acts on.
    logger.warn(
      { error },
      `chatwoot delivery sweep: ${label} was stranded owing a colleague's reply and the recovery of its memory could not be armed; the words stay out of the conversation's memory`,
    );
    return false;
  }
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
  // NOTE: the transcription strand takes one half from each neighbour. From the loss: the row goes
  // DEAD and the ordinary delivery recovery is armed (it claims from DEAD); the replay is safe, since
  // a `message_updated` drives no turn and the ingest gate refuses it where a turn answered. From the
  // takeover: a `warn` saying what was owed, since no reply was ever coming on these routes and
  // paging would be about a memory gap the replay is closing.
  if (verdict === "owed-transcription") {
    const dead = await finishDead(row, tenantId, base, true, label);
    if (dead === "failed") return;
    if (dead === "lost") {
      counts.raced += 1;
      return;
    }
    counts.owedTranscription += 1;
    logger.warn(
      "chatwoot delivery sweep: %s stranded on %s carrying the transcription of message %s on conversation %s; nobody is owed a reply, but the words never reached the memory — replay armed",
      label,
      row.status,
      String(row.inboundMessageId),
      String(row.conversationId),
    );
    return;
  }
  if (verdict !== "lost") {
    if (!(await finish(row, tenantId, "PROCESSED", base))) {
      counts.raced += 1;
      return;
    }
    // NOTE: PROCESSED in both arms, including the one owing a takeover: DEAD is the worklist of
    // customers never answered, and a colleague's reply belongs on no such list. If the armed job
    // never runs, the next human reply takes the conversation over on its own.
    if (verdict === "observer-strand") {
      counts.observerStrands += 1;
      // What this line may claim. Beside a responder of ours, its own delivery folds the reply
      // into the shared memory, so nothing was lost; with none, the observer's memory is the only
      // one. `route_remembers = false` (also what a failed arm writes) cannot close the row benign,
      // only keep the line from asserting a loss; it names both readings. The binding is read now,
      // not at receipt, so it is evidence, not an answer: asked of a responder with a route, at
      // `warn` (an `error` would page for the ordinary shared inbox). The reply is replayable.
      const memoryArmed = await armReplyMemory(row, tenantId, base, label);
      logger.warn(
        "chatwoot delivery sweep: %s stranded on an observer's route carrying a colleague's reply (%s) on conversation %s; %s. The inbox %s NOW, which is not what it had when the event arrived",
        label,
        String(row.humanReplyShape),
        String(row.conversationId),
        row.routeRemembers === false
          ? "its claim recorded that the route remembers nothing (no responder of ours on the inbox, or the watcher switched off), so nothing was owed unless an arm failed after the claim"
          : memoryArmed === true
            ? "the watcher never folded it into its memory, and the recovery of that append is armed"
            : "the watcher never folded it into its memory, and this row names no reply to go back for",
        mirror === null
          ? "could not be read"
          : mirror.responderHasRoute === true
            ? "has a responder with a route (so that responder's own delivery of the same reply probably owns it)"
            : "has no responder with a route",
      );
      return;
    }
    if (verdict === "role-unstated") {
      counts.roleUnstated += 1;
      // NOTE: both honest things, since this pass cannot tell the stories apart. The takeover is
      // armed (free where not owed: recover-takeover.ts re-asks every gate), and the gap is reported
      // (on a watcher's route the owed memory append leaves no other trace). The line states whether
      // it was actually armed, because the row is already PROCESSED and nothing revisits it. The
      // words are armed too, whichever route this was.
      await armReplyMemory(row, tenantId, base, label);
      let armed = true;
      try {
        await armTakeoverRecovery(tenantId, row.id, base);
      } catch (error) {
        armed = false;
        logger.warn(
          { error },
          `chatwoot delivery sweep: ${label} stranded before its route was named and its takeover could not be armed; if it was the responder's, the conversation stays with the bot until the next human reply`,
        );
      }
      logger.warn(
        "chatwoot delivery sweep: %s stranded on %s carrying a colleague's reply (%s) on conversation %s BEFORE anything named its route — the claim that states the role never ran. %s; if it was a watcher's, that watcher never folded the reply into its memory. The inbox %s NOW, which is not necessarily what it had when the event arrived",
        label,
        row.status,
        String(row.humanReplyShape),
        String(row.conversationId),
        armed
          ? "A takeover is armed in case it was the responder's, and so is the reply's memory append"
          : "A takeover COULD NOT BE ARMED, so if it was the responder's the conversation stays with the bot until the next human reply",
        mirror === null
          ? "could not be read"
          : mirror.responderHasRoute === true
            ? "has a responder with a route"
            : "has no responder with a route",
      );
      return;
    }
    if (verdict === "owed-takeover") {
      counts.owed += 1;
      // NOTE: best-effort, armed after the CAS (winning it makes the row nobody else's). A failure
      // leaves the conversation as it was, so `warn`: nothing was lost an operator has to find.
      try {
        await armTakeoverRecovery(tenantId, row.id, base);
      } catch (error) {
        logger.warn(
          { error },
          `chatwoot delivery sweep: ${label} was stranded owing a handover and its recovery could not be armed; the conversation stays with the bot until the next human reply`,
        );
      }
      // NOTE: two debts, two jobs: the handover it was stranded owing, the append it was stranded
      // carrying. Armed independently: a handover that failed says nothing about the words.
      await armReplyMemory(row, tenantId, base, label);
      logger.info(
        "chatwoot delivery sweep: %s stranded on %s owing a human-reply handover (%s) on conversation %s; closing and arming the recovery",
        label,
        row.status,
        String(row.humanReplyShape),
        String(row.conversationId),
      );
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

  // Armed with the CAS, the only moment anything knows the row became recoverable (the query reads
  // PENDING and PROCESSING). Rows DEAD before recovery existed are never backfilled: that would arm
  // a whole backlog of model calls and replies at once, and they are already on the worklist.
  const recoveryArmed = isRecoverableStrand(row);
  // The CAS goes first and the line only if it wins: `writeFlowEvent` dispatches the alert as
  // it writes and nothing retracts it, and a redelivery claiming the row in between is a designed
  // path. A write failing after a won CAS leaves a DEAD row with no line, which is still the record.
  // Armed before the line, so the alert is never newer than the attempt.
  const dead = await finishDead(row, tenantId, base, recoveryArmed, label);
  if (dead === "failed") return;
  if (dead === "lost") {
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
      agentId: mirror?.lineAgentId ?? null,
      inboxId: mirror?.inboxId ?? null,
      base,
    },
    {
      stage: "delivery",
      // NOTE: With a recovery armed the message is not lost yet: the recovery either closes it with
      // its own line or ends with the one that says nobody answered (./recover-delivery.ts). Without
      // one, this is the loss.
      level: recoveryArmed ? "info" : "error",
      status: "error",
      detail: {
        outcome: "stranded",
        deliveryEvent: row.event,
        strandedOn: row.status,
        messageId: row.inboundMessageId,
        conversationId: row.conversationId,
        knownToMirror: mirror !== null,
        willRetry: recoveryArmed,
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
  // NOTE: First the rows whose body the ack stored and nothing processes: processed from that body
  // now, rather than called lost half an hour from now. Its failure must not cost the sweep.
  await drainStoredChatwootDeliveries({ tenantId: job.tenantId, base }).catch(
    (err) => {
      logger.warn(
        { err, tenantId: String(job.tenantId) },
        "chatwoot delivery sweep: the stored-delivery drain failed; sweeping anyway",
      );
    },
  );
  await sweepStrandedDeliveries({ tenantId: job.tenantId, base });
  await reconcileUnconfirmedCloses({ tenantId: job.tenantId, base }).catch(
    (err) => {
      logger.warn(
        { err, tenantId: String(job.tenantId) },
        "chatwoot delivery sweep: reconciling unconfirmed closes failed",
      );
    },
  );
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
    // NOTE: one perpetual row per tenant, like the flow-log sweep and the heartbeat: a completed
    // pass clears the budget, and a re-arm is the same unit of work. Clearing here would give a
    // failing sweep five fresh attempts every time an account connects, defeating the cap.
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
