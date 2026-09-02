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

// Re-running the human-reply takeover a process death lost (issue #439).
//
// The sweep (issue #228) reports a delivery nothing finished; the recovery for a delivery that
// carried a CUSTOMER message answers it by running the delivery path again (issue #295). This is the
// third case, and it is neither: the delivery carried a COLLEAGUE's reply, so nothing is owed to the
// customer and nothing is lost from the loss list — what was lost is a SIDE EFFECT, the transition
// that steps the agent off the conversation (issue #430).
//
// WHY NOT THE DELIVERY PATH, which is what the other recovery does and is the obvious answer here
// too. That path takes a webhook body, and the body of an OUTGOING message is the one thing the
// ledger cannot rebuild: `buildRecoveryPayload` reads the message over REST by its id, and the id of
// an outgoing message is deliberately not stored (only a new INCOMING one is — see the ledger's
// `inboundMessageId`). Rebuilding a body with a synthetic message would then drive the continuous
// ingestion with content nobody wrote, into the contact's permanent memory. So this runs the
// takeover itself, through the same unit the live delivery runs (./human-takeover.ts) — not a second
// implementation of it, which is the defect this repo keeps paying for.
//
// NO MODEL AND NO ALERT, which is the whole reason the sweep needed a verdict of its own for it. The
// alternative on the table was to classify these rows `lost`, and that is wrong in both directions
// at once: it pages an operator about a message nobody lost, and it arms a turn to answer a reply
// that was ours.
//
// WHAT IS RE-DECIDED HERE rather than carried: the ROUTE's provider half (the ledger stores the
// payload's shape, and `device` is also what an unreserved provider's echo of our own reply looks
// like), the agent's mode and takeover switch, and ownership. All of it is read as it stands NOW,
// which is what the live path does too — it reads them at its own moment.
//
// AND NO VERSION IS CARRIED, which is a decision and the one place this deliberately differs from
// the live path. There, the takeover compares the payload's `conversation.updated_at` against the
// row's status mark, so a hand-back committed after the reply outranks it — the two `pending`s
// otherwise look identical. Transplanted here that check refuses almost everything, and MEASURED
// exactly where it matters: `chatwootStatusAt` is a version, not a change stamp, so it advances on
// every payload that DECLARES a status, the customer's own next message included (state-order.ts).
// The live check works because its payload is seconds old; a recovery's decision is half an hour
// old, and a conversation the customer wrote on in between — which is precisely the conversation
// where the agent has been answering over a person — reads as "somebody answered later than you".
//
// It is the pattern the repo already has a name for: a version is not an identity, and a mark that
// advances on redeclaration cannot serve as one. What the recovery has instead is that it holds no
// frozen snapshot at all: it reads the state NOW and writes one statement later, under a CAS on
// what it read. "Is my decision still the most recent one" is a question a stale payload has to ask;
// this one asks "does the state now allow the takeover", and ownership is the whole of that answer.
//
// THE COST, named rather than papered over: a hand-back that lands inside the sweep's window is
// undone by this, and the operator has to click "Return to AI" once more. That is the same class of
// gap as issue #469 and it errs in the direction a fence must err in — the failure is the agent
// staying quiet on a conversation a person can see in their queue, not the agent speaking over
// somebody, which is the defect issue #430 exists to prevent.
//
// NO AGE CEILING, unlike ./recover-delivery.ts, and the difference is what the two recover. That one
// SENDS A REPLY, so hours later it is a stranger reopening a conversation rather than a late answer.
// This one writes a status: a conversation still `pending` and still the bot's, hours after a person
// answered on it, is a conversation the agent is still wrong to be holding, and the fence refuses on
// its own the moment that stops being true.

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
  // Nothing was owed after all, or nothing is owed any more. Covers every refusal that is a verdict
  // rather than a failure: the row cannot be read, the shape was an echo on an unreserved provider,
  // the agent is not in production or has the switch off, the conversation is no longer the bot's.
  | "not-owed"
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
      },
    }),
  );
  // Re-read here rather than trusted from the payload, because the job outlives the pass that armed
  // it: the row is what says a takeover was owed, and a row that cannot answer is not one to act on.
  if (!row || row.conversationId === null) return "not-owed";
  const instanceId = row.chatwootInstanceId;
  const conversationId = row.conversationId;
  // ONE reading of the column, handed to the resolver below rather than checked twice. A shape this
  // build does not know and a row that recorded none are the same answer — nothing to act on — and
  // `resolveHumanReplyRoute` already gives it for `null`, so a second guard here would be a second
  // spelling of a rule that has one.
  //
  // NOTE: this is the TYPE gate and not a runtime one — the resolver compares against the two
  // literals, so an unknown string reaching it answers `null` all the same, and a mutation that
  // deletes this narrowing leaves the suite green. It stays because the column is a String and this
  // is what keeps a raw one out of a typed API; what the predicate itself PROMISES is fixed by the
  // classifier's table, where deleting either literal fails tests.
  const shape = isHumanReplyShape(row.humanReplyShape)
    ? row.humanReplyShape
    : null;

  // The conversation's own inbox, and the agent bound to it. Keyed by the CONVERSATION and not by a
  // payload inbox id, because there is no payload any more — the same reading `conversationAgent`
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
      select: { id: true, inboxId: true, lastEventAt: true },
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
      agentId: inbox.agentId,
      whatsappProvider: inbox.provider,
      mode: agent.mode,
      settings: agent.settings,
    };
  });
  if (!bound) return "not-owed";

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

  const ourAgentBotId = await agentBotChatwootId(
    tenantId,
    instanceId,
    bound.agentId,
    base,
  );
  // A CHEAP FIRST LOOK, not the fence. The fence is inside the unit below and reads Chatwoot before
  // it decides; this is the mirror answering the same question for free, so a conversation somebody
  // already moved on costs a query instead of an HTTP round trip. It can only ever refuse: what it
  // lets through is re-asked, of Chatwoot and of the mirror both, one statement before the write.
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
    conversationRowId: bound.conversationRowId,
    lastEventAt: bound.lastEventAt,
    base,
    makeClient: params.makeClient,
  });
  if (!opened) return "failed";
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
  // `parseDbId` and not a local digits check, because the tree has ONE answer to "is this an id?"
  // and a scheduler payload is a transport like any other (#371).
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
  return { outcome: "done" };
}

// NO DEAD-LETTER HOOK OF ITS OWN, for the reason the delivery recovery states: `dispatchDeadLetter`
// already announces every kind's death with the kind, the job id and the dedupe key — which here IS
// the ledger row id — and takes its level from `JOB_DEATH_LEVEL`, where the answer sits next to the
// other thirteen.
let registered = false;
export function registerTakeoverRecoveryHandler(): void {
  if (registered) return;
  registerJobHandler(RECOVERY_KIND, takeoverRecoveryHandler);
  registered = true;
}
