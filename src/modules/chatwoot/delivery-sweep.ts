import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { TURN_BEARING_EVENT } from "./normalize";
import { armDeliveryRecovery, isRecoverableStrand } from "./recover-delivery";
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
// recalled; closing that properly needs a processor heartbeat.
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
        select: { deliveryId: true, inboundMessageId: true, receivedAt: true },
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
  // Filed under the conversation's inbox and its agent, like the loss line it closes: a channel that
  // excludes the agent filters the correction by these, and a line filed under nobody passes every
  // exclusion. Null when the mirror does not know the conversation; the line is still written.
  const filedUnder =
    corrected.length === 0
      ? null
      : await runScopedOn(params.base, sysCtx(params.tenantId), (db) =>
          db.conversation.findUnique({
            where: {
              tenantId_chatwootInstanceId_chatwootConversationId: {
                tenantId: params.tenantId,
                chatwootInstanceId: params.instanceId,
                chatwootConversationId: params.conversationId,
              },
            },
            select: { inboxId: true, inbox: { select: { agentId: true } } },
          }),
        ).catch((error) => {
          logger.warn(
            { error },
            "chatwoot: could not read the agent a stranded-delivery correction is filed under; filing it under none",
          );
          return null;
        });
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
        agentId: filedUnder?.inbox?.agentId ?? null,
        inboxId: filedUnder?.inboxId ?? null,
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
  row: StrandedRow,
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
  const counts: SweepCounts = {
    closed: 0,
    lost: 0,
    owed: 0,
    observerStrands: 0,
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
        humanReplyShape: true,
        humanReplyMessageId: true,
        routeObserved: true,
        routeAgentBotId: true,
        routeRemembers: true,
      },
    }),
  )) as StrandedRow[];

  for (const row of rows) {
    const verdict = classifyStrandedDelivery(row, {
      now,
      staleAfterMs: STALE_AFTER_MS,
    });
    // NOTE: unreachable through the query, kept because the rule is the classifier's: two
    // statements of one threshold, and this is where they would be caught disagreeing.
    if (verdict === "in-flight") continue;
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
  return counts;
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
    if (!(await finish(row, tenantId, "DEAD", base))) {
      counts.raced += 1;
      return;
    }
    counts.owedTranscription += 1;
    try {
      await armDeliveryRecovery(tenantId, row.id, base);
    } catch (error) {
      // NOTE: nothing follows, because the line below would say the replay was armed. The row is
      // already DEAD and never revisited, so these two lines are the whole record.
      logger.error(
        { error },
        `chatwoot delivery sweep: ${label} was stranded owing a transcription and its replay could not be armed; the words stay out of the conversation's memory and the row stays DEAD`,
      );
      return;
    }
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

  // NOTE: the CAS goes first and the line only if it wins: `writeFlowEvent` dispatches the alert as
  // it writes and nothing retracts it, and a redelivery claiming the row in between is a designed
  // path. A write failing after a won CAS leaves a DEAD row with no line, which is still the record
  // (and an outage, not a race). A rescue landing after the CAS writes its own correction, so both
  // lines end up on the conversation; the loss is never unreported.
  if (!(await finish(row, tenantId, "DEAD", base))) {
    counts.raced += 1;
    return;
  }

  let recoveryArmed = false;
  // NOTE: the recovery is armed now, the only moment anything knows the row became recoverable (the
  // query reads PENDING and PROCESSING). Rows already DEAD before recovery existed are never
  // recovered, deliberately: a backfill would arm a whole backlog of model calls and real replies
  // at once, and those rows are already on the DEAD worklist. Best-effort and logged loudly (the
  // row is already reported). Armed before the line, so the alert is never newer than the attempt.
  try {
    if (isRecoverableStrand(row)) {
      await armDeliveryRecovery(tenantId, row.id, base);
      recoveryArmed = true;
    }
  } catch (error) {
    logger.error(
      { error },
      `chatwoot delivery sweep: ${label} is DEAD and its recovery could not be armed; the row stays in the DEAD list and nothing will retry it`,
    );
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
