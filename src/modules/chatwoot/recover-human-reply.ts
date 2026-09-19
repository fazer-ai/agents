import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { resolveGraphThreadId } from "@/graph/checkpointer";
import { armIngest } from "@/graph/ingest-job";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ingestsContinuously } from "@/modules/agents/mode";
import { readMemoryConfig } from "@/modules/memory/settings";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { loadChatwootClient } from "./instance";
import {
  type HumanReplyRoute,
  isNewHumanReplyToCustomer,
  normalizeChatwootEvent,
  resolveHumanReplyRoute,
} from "./normalize";
import { buildRecoveryPayload } from "./recover-payload";
import { renderAttendantMessage } from "./render";
import { isHumanReplyShape } from "./stranded-delivery";

// Folding back into the contact's memory the colleague's reply an ingestion lost (issue #728).
//
// THE PREMISE THAT BLOCKED THIS FOR THREE ISSUES, and why it is no longer true. Both neighbours say,
// in as many words, that the reply cannot be rebuilt: `recover-takeover.ts` because "the id of an
// outgoing message is deliberately not stored", the sweep's `observer-strand` because "the delivery
// recovery needs a customer message id to anchor on, which a colleague's reply has by construction
// not got". That was accurate when each was written and stopped being accurate at issue #469, which
// added `humanReplyMessageId` to the ledger and has written it at INSERT for every colleague's reply
// since — for the takeover's own fence, which needed one coordinate to order a console write
// against. One column, two readers: the fence that refuses, and now the read that rebuilds.
//
// WHY NOT THE DELIVERY RECOVERY, which is the obvious place and is what recovers a customer's
// message. That one replays the WHOLE delivery through the receiver, and it claims the row from
// `DEAD` to do it. Neither fits here:
//
//   - `DEAD` is the `WHERE status = 'DEAD'` worklist of customers who wrote and were never answered
//     (issue #228), and the sweep says out loud that a colleague's own reply belongs on no such
//     list. Recovering one must not put it there.
//   - A replay re-runs the takeover, the ownership gates and, on a creation, a turn. What is owed
//     here is exactly one effect — the words reaching memory — and the conversation may well have
//     been handed back to the bot in the meantime (issue #469). Replaying would take it away from
//     the bot again to recover a memory append, which is a second, worse defect bought with the fix.
//
// So this is a kind of its own, armed beside the takeover recovery rather than instead of it, and
// the two retry independently: a `not-owed` takeover must not abort the memory, and a memory arm
// that fails must not re-run the toggle.
//
// WHAT IS RE-DECIDED HERE rather than carried, which is the same list `recover-takeover.ts` keeps
// and for the same reason — the job outlives the pass that armed it, so every fact it acts on is
// read as it stands NOW:
//
//   - THE ROUTE'S PROVIDER HALF, before any network. The ledger stores the payload's SHAPE, and
//     `device` is also what an unreserved provider's echo of our OWN reply looks like: sender-less,
//     wearing `external_sender_name`. Anchoring on the column alone would file the agent's own words
//     into the contact's memory as a human attendant's — the most expensive way this could be wrong,
//     and the reason the resolver is asked here and not trusted from the row.
//   - WHETHER THE ROUTE REMEMBERS AT ALL. `route_remembers = false` on the row does not separate "it
//     was owed and the enqueue failed" from "this route never folds anything in": a `test`-mode
//     agent leaves the same signature. Nothing on the row can tell them apart, so the question is
//     not asked of the row — it is asked of the agent, now, the way the receiver asks it.
//   - THE CONTACT-INBOX, which is what the thread is keyed by and what a `no-thread` outcome means
//     the absence of.
//
// AND THE READ IS FENCED like the delivery recovery's is (`rebuiltInbound` there): a message that
// comes back from REST as anything but a colleague's reply describes a degraded response — a missing
// `message_type` normalizes to "other" — and handing that to the ingestion would append something
// nobody wrote. Refused as `unreachable`, never settled as recovered.
//
// NO AGE CEILING, unlike the delivery recovery and for the reason the takeover's states: that one
// SENDS A REPLY, so hours later it is a stranger reopening a conversation. This one writes to a
// memory. A reply from four hours ago that the agent cannot see is a hole in the attendance whenever
// the next customer message arrives, and closing it late is strictly better than not closing it.

const RECOVERY_KIND = "HUMAN_REPLY_RECOVERY" as const;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function humanReplyRecoveryDedupeKey(deliveryRowId: bigint): string {
  return `human-reply-recovery:${deliveryRowId}`;
}

// Whether a stranded row names a colleague's reply this can rebuild, asked of the row alone.
//
// ONE definition with two callers, like `isRecoverableStrand` next door and for the same reason: the
// sweep asks it to avoid arming a job that can only say "not-owed", and the recovery re-asks it after
// reading the row, which is the only moment the row is authoritative.
//
// A type predicate rather than a boolean, so the caller that goes on to USE the two ids gets them
// narrowed by the statement that decided they are there.
export function namesRecoverableHumanReply<
  T extends {
    conversationId: number | null;
    humanReplyMessageId: number | null;
    humanReplyShape: string | null;
  },
>(
  row: T,
): row is T & {
  conversationId: number;
  humanReplyMessageId: number;
  humanReplyShape: HumanReplyRoute;
} {
  return (
    row.conversationId !== null &&
    row.humanReplyMessageId !== null &&
    isHumanReplyShape(row.humanReplyShape)
  );
}

// Arms the recovery of ONE stranded row, called by the sweep at the moment it closes the row: from
// the CAS onward the row is invisible to every later pass, so this is the only moment anything knows
// there is a reply to go back for.
//
// `rearm: "new-work"` for the reason both neighbours give: a row is closed once, so in practice this
// is armed once per row, and answering anyway keeps a re-arm from inheriting a spent budget.
export async function armHumanReplyRecovery(
  tenantId: bigint,
  deliveryRowId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: RECOVERY_KIND,
    dedupeKey: humanReplyRecoveryDedupeKey(deliveryRowId),
    runAt: new Date(),
    // A bigint does not survive JSON, and the payload column is one. Read back with parseDbId.
    payload: { deliveryRowId: String(deliveryRowId) },
    rearm: "new-work",
    base,
  });
}

export type HumanReplyRecoveryOutcome =
  // The append is queued. Not "appended": the ingest job owns that decision, and it is the same job
  // the live path would have armed — including its own dedup, which is what makes a row stranded
  // AFTER a successful ingestion cost nothing (../../graph/ingest.ts, `ingestVerdict`).
  | "remembered"
  // Nothing was owed, or nothing is owed any more. Every refusal that is a VERDICT rather than a
  // failure: the row names no reply, the shape was an echo on an unreserved provider, the route
  // remembers nothing, the conversation names no contact-inbox, the message is gone from Chatwoot.
  // Retrying any of these asks the same question and gets the same answer.
  | "not-owed"
  // The mirror does not know this conversation yet, which is not a verdict: a delivery that died
  // before the mirror write leaves no row, and the next event on that conversation creates one.
  | "unresolved"
  // The account could not be read, or answered with something unusable. Repairable, and the next
  // attempt may get a different answer.
  | "unreachable"
  // The enqueue failed — which is the very failure this recovery exists for, happening again.
  | "failed";

export interface RecoverHumanReplyParams {
  tenantId: bigint;
  deliveryRowId: bigint;
  base?: PrismaClient;
  makeClient?: Parameters<typeof loadChatwootClient>[2] extends infer D
    ? D extends { makeClient?: infer M }
      ? M
      : never
    : never;
}

export async function recoverStrandedHumanReply(
  params: RecoverHumanReplyParams,
): Promise<HumanReplyRecoveryOutcome> {
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
        humanReplyMessageId: true,
      },
    }),
  );
  // Re-read rather than trusted from the payload, because the job outlives the pass that armed it:
  // the row is what says there was a reply, and a row that cannot answer is not one to act on.
  if (!row || !namesRecoverableHumanReply(row)) return "not-owed";
  const instanceId = row.chatwootInstanceId;
  const conversationId = row.conversationId;
  const messageId = row.humanReplyMessageId;

  // The conversation's own inbox and the agent bound to it, keyed by the CONVERSATION rather than by
  // a payload inbox id, because there is no payload — the same read the takeover recovery makes.
  const bound = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: { id: true, inboxId: true, contactInboxId: true },
    });
    if (conv?.inboxId == null) return null;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, provider: true },
    });
    if (!inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { mode: true, enabled: true, settings: true },
    });
    if (!agent) return null;
    return {
      contactInboxId: conv.contactInboxId,
      agentId: inbox.agentId,
      whatsappProvider: inbox.provider,
      mode: agent.mode,
      enabled: agent.enabled,
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
        "chatwoot human-reply recovery: %s names conversation %d, which the mirror does not know yet; retrying",
        row.deliveryId,
        conversationId,
      );
      return "unresolved";
    }
    return "not-owed";
  }

  // THE HALF THE COLUMN COULD NOT ANSWER, and it is asked BEFORE the network on purpose: a `device`
  // shape on a provider that does not reserve its send ids is the echo of our OWN reply, and the
  // cheapest place to refuse it is the one that spends nothing. Reading the message first and
  // deciding after would cost a REST round trip per echo on every unreserved-provider install.
  if (
    resolveHumanReplyRoute(row.humanReplyShape, {
      whatsappProvider: bound.whatsappProvider,
    }) === null
  ) {
    return "not-owed";
  }
  // WHETHER THIS ROUTE REMEMBERS AT ALL, asked of the agent and not of the row (see the header). The
  // receiver's own condition is `rt.enabled && ingestsContinuously(rt.mode)` for a responder, and
  // this is that condition read now. A `test`-mode agent leaves a row byte for byte like the one a
  // failed enqueue leaves, and the difference lives here.
  if (!bound.enabled || !ingestsContinuously(bound.mode)) return "not-owed";
  // NO THREAD TO HOLD IT, which is the ingestion's own `"no-thread"` answer arriving by the other
  // road. The receiver already reported that case as the permanent loss it is and settled the row;
  // a recovery armed on one anyway has nothing to key a thread by.
  if (bound.contactInboxId === null) return "not-owed";
  const contactInboxId = bound.contactInboxId;

  let raw: unknown;
  try {
    const client = await loadChatwootClient(tenantId, instanceId, {
      base,
      // The same seam every other caller uses, so a test drives a fake account rather than mocking
      // the module.
      ...(params.makeClient ? { makeClient: params.makeClient } : {}),
    });
    // `before` anchors the page that ENDS at this id, so the message is in it whatever the
    // conversation's length — the same read the delivery recovery makes for the same reason.
    raw = await client.getMessages(conversationId, { before: messageId + 1 });
  } catch (e) {
    logger.warn(
      "chatwoot human-reply recovery: %s could not read conversation %d from the account: %s",
      row.deliveryId,
      conversationId,
      e instanceof Error ? e.message : String(e),
    );
    return "unreachable";
  }

  const message = findRawMessage(raw, messageId);
  // Chatwoot no longer has the message: deleted, or the conversation was. Nothing to fold in, and no
  // number of retries changes that.
  if (!message) return "not-owed";

  // REBUILT THROUGH THE SAME BUILDER THE OTHER RECOVERY USES, so the two cannot drift about what a
  // webhook body looks like — the REST and webhook spellings differ in both fields this depends on
  // (`message_type` is an integer there and an enum string on the wire), and `normalizeChatwootEvent`
  // is the one reader that reconciles them.
  //
  // The conversation block is minimal on purpose: nothing below reads ownership, status or the
  // pairing. What this needs from the body is the message and the contact-inbox the thread is keyed
  // by, and every field invented beyond that is a field a later reader could start trusting.
  const normalized = normalizeChatwootEvent(
    buildRecoveryPayload({
      event: "message_created",
      conversation: {
        chatwootConversationId: conversationId,
        status: "open",
        assigneeType: null,
        assigneeId: null,
        assigneeName: null,
        contactInboxId,
        redirectOriginDisplayId: null,
        redirectOriginAt: null,
      },
      inboxId: null,
      inboxName: null,
      message: {
        id: messageId,
        content: typeof message.content === "string" ? message.content : null,
        messageType: message.message_type ?? null,
        private: message.private === true,
        contentAttributes: isRecord(message.content_attributes)
          ? message.content_attributes
          : null,
        sender: isRecord(message.sender) ? message.sender : null,
        attachments: Array.isArray(message.attachments)
          ? message.attachments
          : [],
        createdAt: null,
      },
    }),
  );
  // STILL A COLLEAGUE'S REPLY, or the read was degraded. The ledger row is the proof it ever was one,
  // and a rebuild that comes back as anything else describes a REST response that lost something
  // rather than a message that changed. Appending it anyway is the quiet failure this whole issue is
  // about, one layer down: words nobody wrote, in a contact's permanent memory, attributed to an
  // attendant. `unreachable` rather than `not-owed` for the reason the delivery recovery gives — the
  // account answered with something unusable, which the next attempt may not.
  if (
    normalized === null ||
    !isNewHumanReplyToCustomer(normalized, {
      whatsappProvider: bound.whatsappProvider,
    })
  ) {
    logger.warn(
      "chatwoot human-reply recovery: %s rebuilt message %d on conversation %d as something other than a colleague's reply; the REST read is degraded",
      row.deliveryId,
      messageId,
      conversationId,
    );
    return "unreachable";
  }

  // The ATTENDANT's renderer, which is the one the receiver picks for this role: the eager media pass
  // never runs on an outgoing message, so there is no transcription or description to fold in, and
  // the customer-facing markers would tell the agent to ask its own colleague to retype a file.
  const text = renderAttendantMessage({
    text: normalized.message?.content ?? "",
    attachmentTypes: (normalized.message?.attachments ?? [])
      .map((a) => a.fileType)
      .filter((t): t is string => t !== null),
  });
  // An empty reply is nothing to remember, and the receiver's ingestion answers the same way.
  if (!text.trim()) return "not-owed";

  try {
    await armIngest({
      tenantId,
      instanceId,
      conversationId,
      contactInboxId,
      graphThreadId: resolveGraphThreadId(
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
      ),
      messageId,
      text,
      role: "human_agent",
      agentId: bound.agentId,
      compactionEnabled: readMemoryConfig(bound.settings).compaction.enabled,
      base,
    });
  } catch (e) {
    // THE FAILURE THIS RECOVERY EXISTS FOR, HAPPENING AGAIN, which is exactly the case to retry: the
    // scheduler was down when the delivery ran and is down again now. The job's own ladder is the
    // right waiting room for it, and running out reaches the dead-letter line where an operator
    // learns the reply never made it.
    logger.warn(
      "chatwoot human-reply recovery: %s could not arm the ingestion of message %d on conversation %d: %s",
      row.deliveryId,
      messageId,
      conversationId,
      e instanceof Error ? e.message : String(e),
    );
    return "failed";
  }
  logger.info(
    "chatwoot human-reply recovery: %s was stranded owing a colleague's reply (message %d) and it is queued for conversation %d's memory",
    row.deliveryId,
    messageId,
    conversationId,
  );
  return "remembered";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

function readDeliveryRowId(payload: unknown): bigint | null {
  if (typeof payload !== "object" || payload === null) return null;
  const v = (payload as { deliveryRowId?: unknown }).deliveryRowId;
  // `parseDbId` and not a local digits check, because the tree has ONE answer to "is this an id?"
  // and a scheduler payload is a transport like any other (#371).
  return typeof v === "string" ? parseDbId(v) : null;
}

async function humanReplyRecoveryHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const deliveryRowId = readDeliveryRowId(job.payload);
  if (deliveryRowId === null) {
    logger.error(
      "chatwoot human-reply recovery: job %s carries no delivery row id; nothing to recover",
      String(job.id),
    );
    return { outcome: "done" };
  }
  const outcome = await recoverStrandedHumanReply({
    tenantId: job.tenantId,
    deliveryRowId,
    base,
  });
  // THREE OUTCOMES RETRY AND THEY ARE THE THREE THAT CAN CHANGE ON THEIR OWN: the scheduler that
  // refused the arm, the account that could not be read or answered with a degraded body, and the
  // mirror row another event will create. `not-owed` is a verdict about facts that do not move, and
  // retrying it would ask the same rows the same question until the ladder runs out.
  if (outcome === "failed" || outcome === "unreachable") {
    return {
      outcome: "fail",
      error: "human-reply recovery: the reply could not be queued for memory",
    };
  }
  if (outcome === "unresolved") {
    return {
      outcome: "fail",
      error: "human-reply recovery: the mirror does not know this conversation",
    };
  }
  return { outcome: "done" };
}

// NO DEAD-LETTER HOOK OF ITS OWN, for the reason both neighbours state: `dispatchDeadLetter` already
// announces every kind's death with the kind, the job id and the dedupe key — which here IS the
// ledger row id — and takes its level from `JOB_DEATH_LEVEL`.
let registered = false;
export function registerHumanReplyRecoveryHandler(): void {
  if (registered) return;
  registerJobHandler(RECOVERY_KIND, humanReplyRecoveryHandler);
  registered = true;
}
