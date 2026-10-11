import type { PrismaClient } from "@/../generated/prisma/client";
import { Prisma } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import type { ChatwootClient } from "./client";
import { type LoadChatwootClientDeps, loadChatwootClient } from "./instance";
import { type ChatwootMessageRow, parseChatwootMessages } from "./messages";
import { armDeliveryRecoveryOn, MAX_RECOVERY_AGE_MS } from "./recover-delivery";

// Finds the customer messages the delivery ledger never received (the webhook failed for Chatwoot's
// whole retry ladder, so no row exists) and hands each to the recovery that already exists. It decides
// nothing: for a bound inbox's `pending` conversation whose newest public message is the customer's and
// has no ledger row, it writes the DEAD row the receiver never wrote, received at the MESSAGE's
// creation, and arms `DELIVERY_RECOVERY`, which answers or hands the conversation to the team.
// Conversations Chatwoot opened on the bot's failure are the human queue's (fazer-ai/chatwoot#830).
// See docs/chatwoot.md, "Reconciliation from Chatwoot".

// Cadence of the sweep. Minutes, like the stranded-delivery sweep: a message lost to an outage is
// found within one interval of the outage ending, and WhatsApp's recovery ceiling is ninety minutes.
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
// How old a message must be before this sweep judges it: longer than Chatwoot's retry ladder for the
// bot webhook (five attempts, about seven minutes with jitter), so a message whose delivery is still
// on its way is left to the receiver instead of racing it with a second recovery. The cursor advances
// only to here, so a message too young for this pass is inside the next one's window.
const SETTLE_MS = 10 * 60 * 1000;
// How far before the last finished pass the next one reads. A conversation that moved while that pass
// was listing can land behind the cursor; reading it twice costs one ledger lookup.
const CURSOR_MARGIN_MS = 2 * 60 * 1000;
// How far back the very first pass reads: the longest any recovery would still answer. Older messages
// would only be handed to the team, and a first pass is not the place to hand over a backlog.
const FIRST_PASS_LOOKBACK_MS = MAX_RECOVERY_AGE_MS;
// Pages of 25 an inbox may be read per pass, against a pathological backlog. The rest is read on the
// next pass, since the cursor does not advance past an inbox it did not finish.
const MAX_PAGES_PER_INBOX = 40;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// The delivery id the receiver never got, written so a second pass over the same message conflicts
// with the first instead of arming a second recovery.
export function reconciledDeliveryId(
  conversationId: number,
  messageId: number,
): string {
  return `reconcile:${conversationId}:${messageId}`;
}

// The customer message a conversation owes an answer to, read off its newest page: the newest public
// message that is a customer's or ours, when it is the customer's. Private notes, activity lines,
// reactions and imported history say nothing about who spoke last.
export function owedCustomerMessage(
  rows: ChatwootMessageRow[],
): ChatwootMessageRow | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i] as ChatwootMessageRow;
    if (m.private || m.isReaction || m.imported) continue;
    if (m.messageType === "incoming") return m;
    if (m.messageType === "outgoing" || m.messageType === "template")
      return null;
  }
  return null;
}

export interface ReconcileCounts {
  inboxesRead: number;
  conversationsRead: number;
  handedToRecovery: number;
  inboxesFailed: number;
}

interface BoundInbox {
  id: bigint;
  chatwootInboxId: number;
  agentId: bigint;
  bindingGeneration: number;
  routeBotId: number | null;
}

async function boundInboxes(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
): Promise<BoundInbox[]> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inboxes = await db.inbox.findMany({
      where: { chatwootInstanceId: instanceId, agentId: { not: null } },
      select: {
        id: true,
        chatwootInboxId: true,
        agentId: true,
        bindingGeneration: true,
      },
    });
    const bots = await db.chatwootAgentBot.findMany({
      where: { chatwootInstanceId: instanceId },
      select: { agentId: true, chatwootAgentBotId: true },
    });
    const botOf = new Map(bots.map((b) => [b.agentId, b.chatwootAgentBotId]));
    return inboxes.map((i) => ({
      id: i.id,
      chatwootInboxId: i.chatwootInboxId,
      agentId: i.agentId as bigint,
      bindingGeneration: i.bindingGeneration,
      routeBotId: botOf.get(i.agentId as bigint) ?? null,
    }));
  });
}

// Writes the row the receiver never wrote and arms its recovery, in one transaction: a DEAD row with
// no recovery is a loss nothing revisits. False when the row already exists (a pass ran over the same
// message, or the delivery arrived after all and the receiver's row names the message).
async function handOver(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  inbox: BoundInbox,
  conversationId: number,
  message: ChatwootMessageRow,
): Promise<boolean> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const known = await db.chatwootWebhookDelivery.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        conversationId,
        inboundMessageId: message.id,
      },
      select: { id: true },
    });
    if (known) return false;
    try {
      const row = await db.chatwootWebhookDelivery.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          deliveryId: reconciledDeliveryId(conversationId, message.id),
          event: "message_created",
          status: "DEAD",
          receivedAt: message.createdAt ?? new Date(),
          processedAt: new Date(),
          conversationId,
          inboundMessageId: message.id,
          routeAgentBotId: inbox.routeBotId,
          routeObserved: false,
          bindingGeneration: inbox.bindingGeneration,
        },
        select: { id: true },
      });
      await armDeliveryRecoveryOn(db, tenantId, row.id);
      return true;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      )
        return false;
      throw err;
    }
  });
}

async function reconcileInbox(p: {
  base: PrismaClient;
  tenantId: bigint;
  instanceId: bigint;
  client: ChatwootClient;
  inbox: BoundInbox;
  since: Date;
  settledBefore: Date;
  counts: ReconcileCounts;
}): Promise<void> {
  const { base, tenantId, instanceId, client, inbox, since, settledBefore } = p;
  const { counts } = p;
  counts.inboxesRead += 1;
  for (let page = 1; page <= MAX_PAGES_PER_INBOX; page++) {
    const rows = await client.listInboxConversations(
      inbox.chatwootInboxId,
      "pending",
      page,
    );
    if (rows.length === 0) return;
    let anyRecent = false;
    for (const c of rows) {
      if (c.lastActivityAt === null || c.lastActivityAt < since) continue;
      anyRecent = true;
      // A person holds it: whatever the customer wrote is theirs to answer.
      if (c.assigneeType === "User") continue;
      counts.conversationsRead += 1;
      const message = owedCustomerMessage(
        parseChatwootMessages(await client.getMessages(c.id)),
      );
      if (
        !message?.createdAt ||
        message.createdAt < since ||
        message.createdAt >= settledBefore
      )
        continue;
      if (await handOver(base, tenantId, instanceId, inbox, c.id, message)) {
        counts.handedToRecovery += 1;
        await lineFor(base, tenantId, instanceId, inbox, c.id, message.id);
      }
    }
    // Newest activity first, so a page with nothing recent ends the read. Pinned conversations lead
    // page one whatever their age, which is why the whole page is read before deciding.
    if (!anyRecent) return;
  }
  logger.warn(
    "chatwoot reconcile: inbox %d still had recent conversations after %d pages; the rest is read next pass",
    inbox.chatwootInboxId,
    MAX_PAGES_PER_INBOX,
  );
  throw new Error("page cap reached");
}

// The per-conversation line: `info`, since the recovery writes the outcome (an answer, or the
// `unanswered` line when it hands the conversation to the team).
async function lineFor(
  base: PrismaClient,
  tenantId: bigint,
  instanceId: bigint,
  inbox: BoundInbox,
  conversationId: number,
  messageId: number,
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
      select: { id: true },
    }),
  ).catch(() => null);
  await writeFlowEvent(
    {
      tenantId,
      turnId: crypto.randomUUID(),
      source: "inbox",
      conversationId: conv?.id ?? null,
      agentId: inbox.agentId,
      inboxId: inbox.id,
      base,
    },
    {
      stage: "delivery",
      level: "info",
      status: "error",
      detail: {
        outcome: "reconciled",
        messageId,
        conversationId,
        willRetry: true,
      },
    },
  );
}

export interface ReconcileParams {
  tenantId: bigint;
  base?: PrismaClient;
  now?: Date;
  makeClient?: LoadChatwootClientDeps["makeClient"];
}

// One pass over every connected account of the tenant. The cursor of an account advances (to the
// settle line of this pass) only when every bound inbox was read to the end, so a Chatwoot that failed mid-pass is
// read again from the same point next time.
export async function reconcileFromChatwoot(
  params: ReconcileParams,
): Promise<ReconcileCounts> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? new Date();
  const { tenantId } = params;
  const counts: ReconcileCounts = {
    inboxesRead: 0,
    conversationsRead: 0,
    handedToRecovery: 0,
    inboxesFailed: 0,
  };
  const settledBefore = new Date(now.getTime() - SETTLE_MS);
  const instances = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.chatwootInstance.findMany({
      where: { disconnectedAt: null },
      select: { id: true, reconciledUntil: true },
    }),
  );
  for (const instance of instances) {
    const since = new Date(
      instance.reconciledUntil
        ? instance.reconciledUntil.getTime() - CURSOR_MARGIN_MS
        : now.getTime() - FIRST_PASS_LOOKBACK_MS,
    );
    const inboxes = await boundInboxes(base, tenantId, instance.id);
    if (inboxes.length === 0) continue;
    let finished = true;
    let client: ChatwootClient;
    try {
      client = await loadChatwootClient(tenantId, instance.id, {
        base,
        ...(params.makeClient ? { makeClient: params.makeClient } : {}),
      });
    } catch (err) {
      counts.inboxesFailed += inboxes.length;
      logger.warn(
        { err, tenantId: String(tenantId), instanceId: String(instance.id) },
        "chatwoot reconcile: the account's client could not be built; read again next pass",
      );
      continue;
    }
    for (const inbox of inboxes) {
      try {
        await reconcileInbox({
          base,
          tenantId,
          instanceId: instance.id,
          client,
          inbox,
          since,
          settledBefore,
          counts,
        });
      } catch (err) {
        finished = false;
        counts.inboxesFailed += 1;
        logger.warn(
          { err, tenantId: String(tenantId), inbox: inbox.chatwootInboxId },
          "chatwoot reconcile: inbox %d could not be read to the end; read again from the same point next pass",
          inbox.chatwootInboxId,
        );
      }
    }
    if (finished) {
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.chatwootInstance.update({
          where: { id: instance.id },
          data: { reconciledUntil: settledBefore },
        }),
      );
    }
  }
  if (counts.handedToRecovery > 0) {
    // The incident's headline, once per pass that found any: how many customers the ledger had lost.
    await writeFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: null,
        agentId: null,
        inboxId: null,
        base,
      },
      {
        stage: "delivery",
        level: "warn",
        status: "error",
        detail: {
          outcome: "reconciled",
          handedToRecovery: counts.handedToRecovery,
          conversationsRead: counts.conversationsRead,
          inboxesRead: counts.inboxesRead,
        },
      },
    );
  }
  return counts;
}

async function reconcileSweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  await reconcileFromChatwoot({ tenantId: job.tenantId, base });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + RECONCILE_INTERVAL_MS),
  };
}

let registered = false;
export function registerReconcileSweepHandler(): void {
  if (registered) return;
  registerJobHandler("RECONCILE_SWEEP", reconcileSweepHandler);
  registered = true;
}

// Arms the per-tenant sweep (idempotent: one live row per tenant). The first pass runs now rather than
// one interval out, unlike the stranded-delivery sweep: a boot is exactly when an outage has just ended,
// and what it lost is what this pass exists to find.
export async function ensureReconcileSweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "RECONCILE_SWEEP",
    dedupeKey: "reconcile-sweep",
    runAt: new Date(),
    rearm: "same-work",
    base,
  });
}

// Arms the sweep for every existing tenant (once at boot), one tenant's failure not costing the rest.
// `connectChatwootInstance` arms it too, for a tenant that had no account at boot.
export async function ensureAllReconcileSweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      await ensureReconcileSweep(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "reconcile sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
