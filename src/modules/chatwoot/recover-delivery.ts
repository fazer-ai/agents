import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId } from "@/graph/checkpointer";
import { isTurnInFlight } from "@/graph/inflight";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { agentBotChatwootId, loadChatwootClient } from "./instance";
import { normalizeChatwootEvent } from "./normalize";
import { buildRecoveryPayload } from "./recover-payload";
import { processChatwootDelivery } from "./webhook";

// Answering the customer whose delivery a process death stranded (issue #295).
//
// The sweep (issue #228) says a message went unanswered; it does not answer it. This does, and the
// whole design is one sentence: RUN THE DELIVERY PATH AGAIN. Not a flush, and not a re-implementation
// of the gates.
//
// WHY NOT THE FLUSH, which was the obvious answer and is wrong. `flushDebounceJob` re-checks two
// gates itself, ownership and contact authorization, and it re-reads the conversation's messages
// from Chatwoot so the event body is not needed. But three gates run only in the delivery path and
// none of their verdicts survive the process that computed them: test mode, availability /
// out-of-hours, and the channel redirect. A recovery through the flush replies out of hours, or on a
// conversation whose test mode was never activated — a message the original delivery would have
// suppressed.
//
// Re-implementing those three here was the alternative, and it is worse than it looks: they are not
// predicates. Each one DECIDES AND ACTS — the redirect gate sends the link, availability posts the
// away message, test mode posts its notice — so a second implementation would have to reproduce the
// actions and their claims, not just the verdicts. And `isTestSilenced` already has five callers; a
// sixth is the shape of defect this repo keeps paying for.
//
// Re-running the delivery path is correct by construction: every gate runs where it already runs.
// What made that look unsafe was the fear of re-firing the side effects, and it does not hold —
// MEASURED in the code that performs them: all three are idempotent through a watermark CAS
// (`claimAwayMessage`, the test notice's `testNoticeSentAt`, the redirect's own claim), and the
// comment on the first one names the reason it had to be: "The webhook dispatch is DETACHED, so a
// customer who writes twice in a row lands two invocations that both read the same watermark before
// either writes it". A recovery is a third invocation into a door that was already built for this.
//
// WHAT THIS DOES NOT DO, and it is a bound rather than an omission: it never runs a turn beside a
// live one. The turn-in-flight fence is consulted first, and it is in-memory — safe under the
// single-replica / one-leader invariant this whole repo already runs on, and the seven other modules
// that gate on it are the precedent. A turn live on ANOTHER replica is issue #203's gap, shared with
// every one of them.

// How many recoveries one stranded row may ever get. `attempts` is the ledger column that counts
// them, unused since the ledger was introduced and written for the first time by the claim in
// `processChatwootDelivery`.
//
// THREE, and the number is a policy rather than a measurement — said plainly because the alternative
// is a reader assuming it was tuned. What is NOT arbitrary is that a bound exists at all: a recovery
// runs a real turn, which spends the model and can call side-effecting tools, and a row that fails
// for a reason recovery cannot fix (a deleted conversation, a revoked token) would otherwise be
// retried for the life of the install.
export const MAX_RECOVERY_ATTEMPTS = 3;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Four outcomes because the caller has four things to do, and a narrower union would make it guess.
// The scheduler's vocabulary is what they are FOR: three of them are `done` and one is `fail`, and
// collapsing any of the three into the one would either burn a retry budget on work somebody else
// already did, or retry forever on work nobody can do.
export type RecoveryOutcome =
  // The delivery path ran. Whether it ANSWERED is the delivery path's business: the gates it applies
  // may consume the message deliberately, and that is a recovery that worked.
  | "recovered"
  // The row is not ours to recover: it is no longer DEAD, or another pass won the claim between the
  // read and the CAS. Somebody else is doing this work, so there is nothing to retry.
  | "superseded"
  // Not now. A turn is live on the conversation, or the Chatwoot account could not be read — both
  // repairable, neither a verdict, and the caller's retry budget is what bounds them.
  | "deferred"
  // The row cannot be recovered, ever, and stays DEAD. Its message remains in the operator's
  // worklist, which is the honest place for it.
  | "unrecoverable";

export interface RecoverStrandedDeliveryParams {
  tenantId: bigint;
  deliveryRowId: bigint;
  base?: PrismaClient;
  deps?: RuntimeDeps;
}

export async function recoverStrandedDelivery(
  params: RecoverStrandedDeliveryParams,
): Promise<RecoveryOutcome> {
  const base = params.base ?? basePrisma;
  const row = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.chatwootWebhookDelivery.findUnique({
      where: { id: params.deliveryRowId },
      select: {
        id: true,
        chatwootInstanceId: true,
        status: true,
        attempts: true,
        conversationId: true,
        inboundMessageId: true,
      },
    }),
  );
  // Gone, or already taken back by something else. Not a failure: the claim below would have said
  // the same thing, and saying it here spends no network.
  if (row?.status !== "DEAD") return "superseded";

  // A row the sweep reported without ids is one an older build wrote, and there is nothing to
  // rebuild a body from. It stays DEAD and stays in the worklist.
  if (row.conversationId === null || row.inboundMessageId === null) {
    return "unrecoverable";
  }
  if (row.attempts >= MAX_RECOVERY_ATTEMPTS) return "unrecoverable";

  const instanceId = row.chatwootInstanceId;
  const conversationId = row.conversationId;
  const messageId = row.inboundMessageId;

  // Asked BEFORE the claim, and about the conversation rather than the row: two deliveries for one
  // conversation are two rows, and answering one while a turn runs on the other is what the fence
  // exists to stop.
  if (
    isTurnInFlight(
      chatwootThreadId(params.tenantId, instanceId, conversationId),
    )
  ) {
    return "deferred";
  }

  const conv = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: params.tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        contactInboxId: true,
        status: true,
        assigneeType: true,
        assigneeId: true,
        assigneeName: true,
        inbox: {
          select: {
            chatwootInboxId: true,
            name: true,
            agentId: true,
          },
        },
      },
    }),
  );
  // The mirror does not know this conversation, so nothing here can say who should answer it or
  // whether they still may. A row this old with no mirror row is not going to grow one.
  if (!conv) return "unrecoverable";

  // WHICH BOT answers, derived rather than stored, and the derivation is the more correct of the
  // two. The ledger does not record the route a delivery arrived on, and adding a column would
  // answer the wrong question: Chatwoot fans one message to up to two bot routes (`agent_bots_for`:
  // the conversation's assignee bot and the inbox's, each with its own delivery id — MEASURED), so
  // "the route it came from" is not "who should answer it now". The inbox's agent's bot is, and if
  // the conversation has since moved to a different bot the ownership gate closes on that fact,
  // which is the right outcome rather than a missed one.
  //
  // Asked of `agentBotChatwootId`, which is the repo's existing answer to it: it reads the unique
  // (tenant, instance, agent) row and deliberately does NOT decrypt the token, which a caller that
  // merely wants to know WHICH bot cannot survive doing. A second reader here would be the same
  // question in one more place, which is the defect this repo keeps paying for.
  const agentId = conv.inbox?.agentId ?? null;
  const agentBotId =
    agentId === null
      ? null
      : await agentBotChatwootId(params.tenantId, instanceId, agentId, base);

  // The message, which is the one thing the mirror does not hold. `before` anchors the page that
  // ENDS at this id, so the message is in it whatever the conversation's length.
  let raw: unknown;
  try {
    const client = await loadChatwootClient(params.tenantId, instanceId, {
      base,
      // The same seam every other caller uses, so a test drives a fake account rather than mocking
      // the module.
      ...(params.deps?.makeClient
        ? { makeClient: params.deps.makeClient }
        : {}),
    });
    raw = await client.getMessages(conversationId, { before: messageId + 1 });
  } catch (e) {
    // The account is unreachable or the token no longer works. Both are repairable by an operator,
    // so this is a DEFERRAL rather than a verdict: the row keeps its attempt budget and the next
    // pass tries again.
    logger.warn(
      "chatwoot recovery: could not read conversation %d (delivery=%s): %s",
      conversationId,
      String(row.id),
      e instanceof Error ? e.message : String(e),
    );
    return "deferred";
  }

  const message = findRawMessage(raw, messageId);
  // Chatwoot no longer has the message: deleted, or the conversation was. There is nothing to
  // answer, and no number of retries will change that.
  if (!message) return "unrecoverable";

  const normalized = normalizeChatwootEvent(
    buildRecoveryPayload({
      conversation: {
        chatwootConversationId: conversationId,
        contactInboxId: conv.contactInboxId,
        status: conv.status,
        assigneeType: conv.assigneeType,
        assigneeId: conv.assigneeId,
        assigneeName: conv.assigneeName,
      },
      inboxId: conv.inbox?.chatwootInboxId ?? null,
      inboxName: conv.inbox?.name ?? null,
      message: {
        id: messageId,
        content: typeof message.content === "string" ? message.content : null,
        messageType: message.message_type,
        private: message.private === true,
        contentAttributes: isRecord(message.content_attributes)
          ? message.content_attributes
          : null,
        sender: isRecord(message.sender) ? message.sender : null,
        attachments: Array.isArray(message.attachments)
          ? message.attachments
          : [],
      },
    }),
  );
  // Unreachable in practice — the body above is built to normalize — and not an assertion: a
  // recovery that cannot produce an event has nothing to hand the delivery path, and saying so is
  // cheaper than a throw nobody catches.
  if (!normalized) return "unrecoverable";

  const outcome = await processChatwootDelivery({
    tenantId: params.tenantId,
    instanceId,
    deliveryRowId: row.id,
    agentBotId,
    normalized,
    claimFrom: "DEAD",
    base,
    deps: params.deps,
  });
  // "skipped" means the claim matched nothing: another recovery took the row between the read above
  // and the CAS. The winner is running it, so this pass has nothing left to do and nothing to retry.
  return outcome === "processed" ? "recovered" : "superseded";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// The raw page item for one message id. Raw on purpose: `parseChatwootMessages` returns the shape
// the RENDERER wants (transcriptions, attachment types, reply ids) and drops the sender object and
// the attachment records, which is precisely what a body has to carry.
function findRawMessage(
  raw: unknown,
  id: number,
): Record<string, unknown> | null {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.payload)
      ? raw.payload
      : [];
  for (const item of list) {
    if (isRecord(item) && item.id === id) return item;
  }
  return null;
}

// ── The job ──────────────────────────────────────────────────────────────────────────────────────
//
// A kind of its own rather than work the sweep does inline, and lanes.ts states the reason as a
// rule: the sweep spends no provider capacity and this spends a whole turn. Folded into the sweep,
// one pass over a backlog would start a batch's worth of agent turns inside a job whose lane is
// sized for indexed queries.

export function deliveryRecoveryDedupeKey(deliveryRowId: bigint): string {
  return `delivery-recovery:${deliveryRowId}`;
}

// Arms the recovery of ONE stranded row. Called by the sweep at the moment it declares the row DEAD,
// which is the only moment anything knows the row just became recoverable: the sweep's own query
// reads PENDING and PROCESSING, so a DEAD row is invisible to every later pass.
//
// `rearm: "new-work"` because that is what a second arming would be. A row can only be declared DEAD
// once — `finish` is a CAS — so in practice this is armed once per row and the question is
// hypothetical; answered anyway, because the row it upserts carries the failure budget, and a row
// re-armed as the same work would hand a recovery that keeps failing a fresh five every time.
export async function armDeliveryRecovery(
  tenantId: bigint,
  deliveryRowId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "DELIVERY_RECOVERY",
    dedupeKey: deliveryRecoveryDedupeKey(deliveryRowId),
    // Now. The message has already waited out the staleness window; what it is waiting on next is
    // the shared tick, which is the delay this design accepts (lanes.ts).
    runAt: new Date(),
    // A bigint does not survive JSON, and the payload column is one. Read back with BigInt().
    payload: { deliveryRowId: String(deliveryRowId) },
    rearm: "new-work",
    base,
  });
}

function readDeliveryRowId(payload: unknown): bigint | null {
  if (!isRecord(payload)) return null;
  const v = payload.deliveryRowId;
  if (typeof v !== "string" || !/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

async function deliveryRecoveryHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const deliveryRowId = readDeliveryRowId(job.payload);
  // Nothing to work on, and no attempt can produce one. Failing would spend five attempts and then
  // announce a lost message that this job never identified in the first place.
  if (deliveryRowId === null) {
    logger.error(
      "chatwoot recovery: job %s carries no delivery row id; nothing to recover",
      String(job.id),
    );
    return { outcome: "done" };
  }

  const outcome = await recoverStrandedDelivery({
    tenantId: job.tenantId,
    deliveryRowId,
    base,
  });
  // The mapping the four outcomes exist for. Three of them are finished work — the recovery ran, or
  // somebody else's did, or nothing ever can — and only "deferred" is a state a later attempt may
  // find different.
  //
  // Deferrals go to `fail` rather than `reschedule` deliberately: `reschedule` CLEARS the failure
  // budget (it means the pass completed), so a conversation whose account stays unreachable would be
  // retried for the life of the install with nothing ever saying so. `fail` backs off, bounds the
  // ladder at the scheduler's own cap, and ends at the dead-letter hook below, which is the one
  // place that can state the recovery is not coming.
  if (outcome === "deferred") {
    return {
      outcome: "fail",
      error:
        "recovery deferred: a live turn, or the Chatwoot account is unreachable",
    };
  }
  return { outcome: "done" };
}

// NO DEAD-LETTER HOOK OF ITS OWN, and that is a decision rather than an omission. `dispatchDeadLetter`
// already announces every kind's death (issue #356), and its generic line carries what this one
// would: the kind, the job id, and the dedupe key — which for this kind IS the delivery row id
// (`delivery-recovery:<id>`). A hook here would restate that and lose two things the generic path
// does: it re-reads the row so a re-armed job is not announced as a loss, and it takes its level
// from `JOB_DEATH_LEVEL`, where the answer is written next to the other twelve.
//
// That answer is `warn`, and the rule the map states is what decides it: `warn` where the operator
// has their own way back to the work. Here they do, twice over — the sweep already announced this
// exact delivery at `error`, and the row is still in the `WHERE status = 'DEAD'` worklist that is
// the whole point of #228. A second `error` is the same message paging somebody twice.

let registered = false;
export function registerDeliveryRecoveryHandler(): void {
  if (registered) return;
  registerJobHandler("DELIVERY_RECOVERY", deliveryRecoveryHandler);
  registered = true;
}
