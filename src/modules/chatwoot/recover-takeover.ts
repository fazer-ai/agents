import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { readTakeoverConfig } from "@/modules/handoff/settings";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  conversationOwnershipNow,
  runHumanReplyTakeover,
} from "./human-takeover";
import { agentBotChatwootId } from "./instance";
import { resolveHumanReplyRoute } from "./normalize";
import { isHumanReplyShape } from "./stranded-delivery";

// Re-running the human-reply takeover a process death lost. A delivery that carried a COLLEAGUE's
// reply owes the customer nothing and is not a loss; what was lost is a SIDE EFFECT, the transition
// that steps the agent off the conversation. It runs the unit the live delivery runs
// (./human-takeover.ts), never the delivery path nor a second copy, and the memory half is its own job
// (./recover-human-reply.ts). No model, no alert. The route's provider half, the agent's mode and
// takeover switch and ownership are re-read NOW; no version is carried and there is no age ceiling.
// Why each: docs/chatwoot.md, "Webhook receiver", on the takeover recovery.
const RECOVERY_KIND = "TAKEOVER_RECOVERY" as const;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function takeoverRecoveryDedupeKey(deliveryRowId: bigint): string {
  return `takeover-recovery:${deliveryRowId}`;
}

// Arms the recovery of ONE stranded row, called by the sweep at the moment it closes the row: the
// sweep's own query reads PENDING and PROCESSING, so from the CAS onward the row is invisible to
// every later pass and nothing else will ever notice.
//
// `rearm: "new-work"` for the same reason the delivery recovery gives: a row can only be closed
// once, so in practice this is armed once per row, and answering the question anyway keeps a re-arm
// from inheriting a spent failure budget.
export async function armTakeoverRecovery(
  tenantId: bigint,
  deliveryRowId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: RECOVERY_KIND,
    dedupeKey: takeoverRecoveryDedupeKey(deliveryRowId),
    runAt: new Date(),
    // A bigint does not survive JSON, and the payload column is one. Read back with parseDbId.
    payload: { deliveryRowId: String(deliveryRowId) },
    rearm: "new-work",
    base,
  });
}

export type TakeoverRecoveryOutcome =
  // The conversation was handed over: the claim was written and Chatwoot was told.
  | "recovered"
  // Nothing was owed after all, or nothing is owed any more. Covers every refusal that is a VERDICT
  // rather than a failure: the row cannot be read, the shape was an echo on an unreserved provider,
  // the agent is not in production or has the switch off, the conversation is no longer the bot's,
  // an operator resolved it. Retrying any of these asks the same question and gets the same answer.
  | "not-owed"
  // The mirror does not know this conversation yet, which is NOT a verdict: a delivery that died
  // before the mirror write leaves no row, and the very next event on that conversation creates one.
  // Everything this needs (the inbox, the agent, the row the claim is a CAS on) hangs off it, and
  // this path does not create one: the body can be read back by `humanReplyMessageId`, but what
  // writes the mirror from a body is the delivery path, which this recovery does not re-run
  // (docs/chatwoot.md, "Takeover recovery"). So it is retried on the scheduler's own ladder and
  // announced if it runs out, rather than discarded as an answer.
  | "unresolved"
  // The takeover ran and did not land. Already reported by the unit that tried, at the level it
  // decided; this is the caller's word for it.
  | "failed";

export interface RecoverTakeoverParams {
  tenantId: bigint;
  deliveryRowId: bigint;
  base?: PrismaClient;
  makeClient?: Parameters<typeof runHumanReplyTakeover>[0]["makeClient"];
}

export async function recoverStrandedTakeover(
  params: RecoverTakeoverParams,
): Promise<TakeoverRecoveryOutcome> {
  const base = params.base ?? basePrisma;
  const { tenantId } = params;

  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootWebhookDelivery.findUnique({
      where: { id: params.deliveryRowId },
      select: {
        deliveryId: true,
        chatwootInstanceId: true,
        conversationId: true,
        humanReplyShape: true,
        routeAgentBotId: true,
        humanReplyMessageId: true,
      },
    }),
  );
  // Re-read here rather than trusted from the payload, because the job outlives the pass that armed
  // it: the row is what says a takeover was owed, and a row that cannot answer is not one to act on.
  if (!row || row.conversationId === null) return "not-owed";
  const instanceId = row.chatwootInstanceId;
  const conversationId = row.conversationId;
  // ONE reading of the column, handed to the resolver rather than checked twice: an unknown
  // shape and none recorded are the same answer, and `resolveHumanReplyRoute` gives it for `null`.
  // This is the TYPE gate, not a runtime one (the resolver compares against the two literals, and a
  // mutation deleting this narrowing leaves the suite green); it keeps a raw String out of a typed
  // API, and what the predicate PROMISES is fixed by the classifier's table.
  const shape = isHumanReplyShape(row.humanReplyShape)
    ? row.humanReplyShape
    : null;

  // The conversation's own inbox, and the agent bound to it. Keyed by the CONVERSATION and not by a
  // payload inbox id, because there is no payload any more: the same reading `conversationAgent`
  // uses in the delivery for a payload that names no inbox.
  const bound = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        id: true,
        inboxId: true,
        lastEventAt: true,
        status: true,
        statusClaimUntil: true,
        statusClaimFrom: true,
      },
    });
    if (conv?.inboxId == null) return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, provider: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { mode: true, settings: true },
    });
    if (!agent) return null;
    return {
      conversationRowId: conv.id,
      lastEventAt: conv.lastEventAt,
      status: conv.status,
      statusClaimUntil: conv.statusClaimUntil,
      statusClaimFrom: conv.statusClaimFrom,
      agentId: inbox.agentId,
      whatsappProvider: inbox.provider,
      mode: agent.mode,
      settings: agent.settings,
    };
  });
  // TWO CAUSES, and only one of them is an answer. An inbox bound to no agent owes nothing and never
  // will; a conversation the mirror has never seen is a row that does not exist YET.
  if (!bound) {
    const known = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.conversation.count({
        where: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      }),
    );
    if (known === 0) {
      logger.warn(
        "chatwoot takeover recovery: %s names conversation %d, which the mirror does not know yet; retrying",
        row.deliveryId,
        conversationId,
      );
      return "unresolved";
    }
    return "not-owed";
  }

  // THE HALF THE PAYLOAD COULD NOT ANSWER. A `device` shape on a provider that does not reserve its
  // send ids is an echo of our OWN reply wearing an attendant's marker, and taking the conversation
  // over on it would have the agent step aside for itself.
  const route = resolveHumanReplyRoute(shape, {
    whatsappProvider: bound.whatsappProvider,
  });
  if (route === null) return "not-owed";
  // The same two gates the live path applies, read as they stand now. Production only, for the
  // reason stated there: a takeover is a fact about the conversation, and a test-mode agent lives in
  // a conversation an operator activated.
  if (bound.mode !== "production") return "not-owed";
  if (!readTakeoverConfig(bound.settings).onHumanReply) return "not-owed";

  // The route's bot, carried on the row, because ownership is asked ABOUT an identity and the
  // two routes differ: Chatwoot fans a message to the conversation's assignee bot and the inbox's,
  // and only the route holding the conversation passes the gate, so an identity from the inbox would
  // refuse the takeover on a conversation another persona's bot holds. Rows an older build wrote carry
  // no route and fall back to the inbox persona, which can only REFUSE wrongly, never take over.
  const ourAgentBotId =
    row.routeAgentBotId ??
    (await agentBotChatwootId(tenantId, instanceId, bound.agentId, base));
  // NOTE: our own unfinished write, asked before ownership because ownership cannot see it. The claim
  // is taken before the toggle, so a death between the two (the widest gap, so the likeliest death)
  // leaves the row `open` from `pending` with Chatwoot never told. Not gated on the claim's deadline:
  // it is 60s (STATUS_CLAIM_TTL_MS) and nothing is stranded before 30 minutes (STALE_AFTER_MS), so
  // that branch would never run. The LIVE READ inside the retry stands in: Chatwoot `pending` against
  // our `open` is the signature of exactly the lost write (a hand-back writes `pending` on the ROW; a
  // person who opened it left Chatwoot `open`). `pending` as the replaced status says this `open`
  // came from this takeover rather than from some other claim.
  if (bound.status === "open" && bound.statusClaimFrom === "pending") {
    // FINISHING rather than deciding, through the SAME unit and not a second copy of it: asked
    // again, the ownership fence would read our own write as somebody else's and stand down, the job
    // would complete as an answer, and the delete-on-done row would take the only recovery with it.
    const finished = await runHumanReplyTakeover({
      tenantId,
      instanceId,
      conversationId,
      route,
      ourAgentBotId,
      agentId: bound.agentId,
      decidedAtVersion: null,
      // NOTE: no message coordinate either: the fence it feeds is one of the steps finishing skips. A
      // hand-back writes `pending` on the ROW, which takes the conversation out of this branch's
      // shape, so that case goes down the ordinary path below and IS asked there; here a console mark
      // means an operator opened the conversation themselves, and finishing the toggle is what that
      // click asked for. An id here would change no outcome, and no test could tell it from null.
      decidedAtMessageId: null,
      conversationRowId: bound.conversationRowId,
      lastEventAt: bound.lastEventAt,
      // The row's own deadline, expired or not: it travels to the reconcile, which compares it for
      // equality to know the write is the claim's owner.
      heldClaimUntil: bound.statusClaimUntil,
      base,
      makeClient: params.makeClient,
    });
    if (finished === "refused") return "not-owed";
    if (finished === "failed") return "failed";
    logger.info(
      "chatwoot takeover recovery: %s finished a takeover whose toggle had not landed (conversation %d)",
      row.deliveryId,
      conversationId,
    );
    return "recovered";
  }

  // A cheap first look, not the fence. The fence is inside the unit below and reads Chatwoot
  // before it decides; this is the mirror answering the same question for free, so a conversation
  // somebody already moved on costs a query instead of an HTTP round trip. It can only ever refuse:
  // what it lets through is re-asked, of Chatwoot and of the mirror both, one statement before the write.
  const now = await conversationOwnershipNow({
    tenantId,
    instanceId,
    conversationId,
    ourAgentBotId,
    base,
  });
  if (!now.ours) return "not-owed";

  const opened = await runHumanReplyTakeover({
    tenantId,
    instanceId,
    conversationId,
    route,
    ourAgentBotId,
    agentId: bound.agentId,
    // NULL BY CONSTRUCTION, for the reason the header gives: there is no frozen payload here to
    // hold a position, and the mark this would be compared against advances on every payload that
    // declares a status rather than only on the ones that change it.
    decidedAtVersion: null,
    // NOTE: the other axis is not null. The recovery runs at least half an hour after the delivery,
    // so a hand-back made in that stretch is exactly the write it must not walk back, and the ledger
    // kept the coordinate that says so, the message this takeover was about. A row an older build
    // wrote names none, and there the fence has nothing to order.
    decidedAtMessageId: row.humanReplyMessageId,
    conversationRowId: bound.conversationRowId,
    lastEventAt: bound.lastEventAt,
    base,
    makeClient: params.makeClient,
  });
  // A FENCE THAT STOOD DOWN IS AN ANSWER, and only a call that failed is worth a backoff. The
  // preliminary read above is not a lock: ownership can move between it and the fence's own read,
  // and the fence correctly refuses then; retrying that spends the ladder and dead-letters a job
  // about a conversation that owes nothing.
  if (opened === "refused") return "not-owed";
  if (opened === "failed") return "failed";
  logger.info(
    "chatwoot takeover recovery: %s was stranded owing a handover (%s) and the conversation %d has now been opened for the human queue",
    row.deliveryId,
    route,
    conversationId,
  );
  return "recovered";
}

function readDeliveryRowId(payload: unknown): bigint | null {
  if (typeof payload !== "object" || payload === null) return null;
  const v = (payload as { deliveryRowId?: unknown }).deliveryRowId;
  // NOTE: `parseDbId` and not a local digits check, because the tree has ONE answer to "is this an
  // id?" and a scheduler payload is a transport like any other.
  return typeof v === "string" ? parseDbId(v) : null;
}

async function takeoverRecoveryHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const deliveryRowId = readDeliveryRowId(job.payload);
  if (deliveryRowId === null) {
    logger.error(
      "chatwoot takeover recovery: job %s carries no delivery row id; nothing to recover",
      String(job.id),
    );
    return { outcome: "done" };
  }
  const outcome = await recoverStrandedTakeover({
    tenantId: job.tenantId,
    deliveryRowId,
    base,
  });
  // FAILED IS THE ONLY RETRY, and it takes the road that spends the failure budget: the toggle threw
  // or the fence closed on a read it could not make, which is a condition that either clears on its
  // own in a minute or is durable and has to be announced. `not-owed` is a verdict and retrying it
  // would ask the same rows the same question forever.
  if (outcome === "failed") {
    return {
      outcome: "fail",
      error: "takeover recovery: the conversation could not be opened",
    };
  }
  // Retried on the same ladder as a failure, and it is the right shape for it: what this waits on is
  // another event creating the mirror row, which either happens within the backoff or does not
  // happen at all. Running out reaches the dead-letter line, where `JOB_DEATH_LEVEL` says `warn`:
  // an operator learns, and what they learn about is a conversation the bot is still holding.
  if (outcome === "unresolved") {
    return {
      outcome: "fail",
      error: "takeover recovery: the mirror does not know this conversation",
    };
  }
  return { outcome: "done" };
}

// NO DEAD-LETTER HOOK OF ITS OWN, for the reason the delivery recovery states: `dispatchDeadLetter`
// already announces every kind's death with the kind, the job id and the dedupe key (which here IS
// the ledger row id), and takes its level from `JOB_DEATH_LEVEL`, where the answer sits next to the
// other thirteen.
let registered = false;
export function registerTakeoverRecoveryHandler(): void {
  if (registered) return;
  registerJobHandler(RECOVERY_KIND, takeoverRecoveryHandler);
  registered = true;
}
