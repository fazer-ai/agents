import type { PrismaClient } from "@/../generated/prisma/client";
import { Prisma } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import type { ChatwootClient, ChatwootInboxConversation } from "./client";
import { type LoadChatwootClientDeps, loadChatwootClient } from "./instance";
import {
  type ChatwootMessageRow,
  hasAnswerableContent,
  parseChatwootMessages,
} from "./messages";
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
// message that is a customer's or a reply, when it is the customer's. Private notes, activity lines,
// reactions and imported history say nothing about who spoke last, and neither does a sender-less
// outgoing message (an automation, an away message, a survey, or a reply typed on a paired phone): the
// recovery tells those apart with the inbox's provider, so the message is handed to it.
export function owedCustomerMessage(
  rows: ChatwootMessageRow[],
  managedBotIds: ReadonlySet<number> = new Set(),
): ChatwootMessageRow | null {
  const turn = newestTurn(rows, managedBotIds);
  return typeof turn === "object" ? turn : null;
}

// The same reading, telling "a reply came last" from "nothing on this page decides": a page of notes
// and activity lines says nothing, and the answer is on an older page. A reply from one of our own
// bots is not an answer either: a turn answers only the messages it took, and one finishing after a
// lost message posts past it. The customer message before it is returned, and the ledger, which holds
// a row for every message a turn received, tells the two apart.
function newestTurn(
  rows: ChatwootMessageRow[],
  managedBotIds: ReadonlySet<number>,
): ChatwootMessageRow | "answered" | "undecided" {
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i] as ChatwootMessageRow;
    if (m.private) continue;
    // The customer side is the recovery's own predicate (`maxIncomingId`): the message picked here is
    // the one the recovery will find newest, or it refuses the row as behind a newer one and the loss
    // closes unanswered. A blank incoming message runs no turn, so it is not that message.
    if (m.messageType === "incoming") {
      if (!hasAnswerableContent(m)) continue;
      // Imported history produces no webhook, so its missing row is no outage, and the recovery would
      // refuse anything older behind it.
      if (m.imported) return "answered";
      return m;
    }
    if (m.isReaction || m.imported) continue;
    if (
      m.senderType === "agent_bot" &&
      m.senderId !== null &&
      managedBotIds.has(m.senderId)
    )
      continue;
    if (
      (m.messageType === "outgoing" || m.messageType === "template") &&
      m.senderType !== null
    )
      return "answered";
  }
  return "undecided";
}

// Older pages a conversation may be read back through when its newest ones hold only notes and
// activity lines. Past them the conversation is left undecided and the inbox unfinished.
const MAX_MESSAGE_PAGES = 10;

// The fork's catch-up read returns at most this many messages per call.
const CATCH_UP_PAGE = 100;

// A page completed with the catch-up read: the default and `before` pages keep a reaction only when
// its target is on the same page, so a reaction to a message pages away is missing from all of them,
// and the catch-up read (every message above an id, no reaction window) is where it appears. Read from
// just below the page's lowest id, since an omitted reaction can sit between two rows the page did
// return; a row any page already returned (`seen`) is dropped. Ordered by `(created_at, id)`.
async function completePage(
  client: ChatwootClient,
  conversationId: number,
  rows: ChatwootMessageRow[],
  seen: Set<number>,
): Promise<ChatwootMessageRow[]> {
  const floor = earliest(rows);
  if (floor === null) return rows;
  for (const m of rows) seen.add(m.id);
  // Only rows at or after the page's earliest, by the pair `before` compares: an import dated
  // earlier with a higher id belongs to an older page, which returns it in its own turn.
  const atOrAfterFloor = (m: ChatwootMessageRow) => !isEarlier(m, floor);
  let after = Math.min(...rows.map((m) => m.id)) - 1;
  for (let read = 0; ; read++) {
    if (read >= MAX_MESSAGE_PAGES)
      throw new Error(
        `conversation ${conversationId}: catch-up read still full after ${MAX_MESSAGE_PAGES} pages`,
      );
    const more = readMessagePage(
      await client.getMessages(conversationId, { after }),
      conversationId,
    );
    for (const m of more) {
      if (!seen.has(m.id) && atOrAfterFloor(m)) {
        seen.add(m.id);
        rows.push(m);
      }
    }
    if (more.length < CATCH_UP_PAGE) break;
    after = Math.max(after, ...more.map((m) => m.id));
  }
  return rows.sort((a, b) => {
    const d = (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
    return d !== 0 ? d : a.id - b.id;
  });
}

async function owedOf(
  client: ChatwootClient,
  conversationId: number,
  managedBotIds: ReadonlySet<number>,
): Promise<ChatwootMessageRow | null> {
  const seen = new Set<number>();
  let page = readMessagePage(
    await client.getMessages(conversationId),
    conversationId,
  );
  for (let read = 0; read < MAX_MESSAGE_PAGES; read++) {
    // The next `before` cursor comes from the page as Chatwoot returned it: a catch-up row can be an
    // import dated far back with a higher id, and paging from it would skip the history between.
    const cursor = earliest(page);
    const rows = await completePage(client, conversationId, page, seen);
    const turn = newestTurn(rows, managedBotIds);
    if (turn === "answered") return null;
    if (turn !== "undecided") return turn;
    if (cursor === null) return null;
    page = readMessagePage(
      await client.getMessages(conversationId, { before: cursor.id }),
      conversationId,
    );
  }
  throw new Error(
    `conversation ${conversationId}: no public message in ${MAX_MESSAGE_PAGES} pages`,
  );
}

// The page's earliest row by `(created_at, id)`, the pair the fork's `before` compares: an import can
// number old messages above new ones, so the smallest id is not the earliest.
function earliest(rows: ChatwootMessageRow[]): ChatwootMessageRow | null {
  if (rows.length === 0) return null;
  return rows.reduce((a, b) => (isEarlier(b, a) ? b : a));
}

function isEarlier(a: ChatwootMessageRow, b: ChatwootMessageRow): boolean {
  const at = (a.createdAt as Date).getTime();
  const bt = (b.createdAt as Date).getTime();
  return at < bt || (at === bt && a.id < b.id);
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
  responderBoundAt: Date | null;
  // A monitoring agent never replies here, so what its lost message is owed is memory only.
  owesMemoryOnly: boolean;
  routeBotId: number | null;
  managedBotIds: ReadonlySet<number>;
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
        responderBoundAt: true,
      },
    });
    const agents = await db.agent.findMany({
      where: { id: { in: inboxes.map((i) => i.agentId as bigint) } },
      select: { id: true, mode: true },
    });
    const modeOf = new Map(agents.map((a) => [a.id, a.mode]));
    const bots = await db.chatwootAgentBot.findMany({
      where: { chatwootInstanceId: instanceId },
      select: { agentId: true, chatwootAgentBotId: true },
    });
    const botOf = new Map(bots.map((b) => [b.agentId, b.chatwootAgentBotId]));
    const managedBotIds = new Set(bots.map((b) => b.chatwootAgentBotId));
    return inboxes.map((i) => ({
      id: i.id,
      chatwootInboxId: i.chatwootInboxId,
      agentId: i.agentId as bigint,
      bindingGeneration: i.bindingGeneration,
      responderBoundAt: i.responderBoundAt,
      owesMemoryOnly: modeOf.get(i.agentId as bigint) === "monitoring",
      routeBotId: botOf.get(i.agentId as bigint) ?? null,
      managedBotIds,
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
    // Only a responder's delivery covers the message: an observer's webhook can succeed while the
    // responder's exhausts its retries. Asked of the role recorded at receipt, not of today's bot, so
    // a responder's delivery from before a rebind still counts. A null role is a row the claim never
    // classified (or one older than the column), placed by its route instead: the responder's bot or
    // no route covers; another bot under the same binding is an observer; under an older binding the
    // role cannot be told, and the row covers rather than risk a second answer.
    const known = await db.chatwootWebhookDelivery.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        conversationId,
        inboundMessageId: message.id,
        // A transcription's `message_updated` names the same message and runs no turn.
        event: "message_created",
        OR: [
          { routeObserved: false },
          { routeObserved: null, routeAgentBotId: null },
          ...(inbox.routeBotId !== null
            ? [{ routeObserved: null, routeAgentBotId: inbox.routeBotId }]
            : []),
          { routeObserved: null, bindingGeneration: null },
          {
            routeObserved: null,
            bindingGeneration: { not: inbox.bindingGeneration },
          },
        ],
      },
      select: { id: true },
    });
    if (known) return false;
    // A turn can answer a message no ledger row names (an operator's re-engage reads the channel, not
    // the ledger), and what it decided is written per message: a claim or a dispensal, or a floor the
    // conversation's marks have passed. Any of them means the message is not lost.
    const mirror = await db.conversation.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
      },
      select: {
        id: true,
        lastHandledMessageId: true,
        lastRepliedMessageId: true,
        replyClaimFloorMessageId: true,
        resetAtMessageId: true,
      },
    });
    if (mirror) {
      // The marks speak only below the per-message floor: above it every decision writes a row, and a
      // mark past the message can belong to a later message decided alone (docs/debounce.md).
      const claimFloor = mirror.replyClaimFloorMessageId;
      const marks = Math.max(
        mirror.lastHandledMessageId ?? 0,
        mirror.lastRepliedMessageId ?? 0,
      );
      if (
        (claimFloor === null || message.id <= claimFloor) &&
        marks >= message.id
      )
        return false;
      // `/reset` retires the burst before it with no row of its own.
      if (
        mirror.resetAtMessageId !== null &&
        mirror.resetAtMessageId >= message.id
      )
        return false;
      const decided = await db.messageReplyClaim.findFirst({
        where: { conversationId: mirror.id, messageId: message.id },
        select: { id: true },
      });
      if (decided) return false;
      const dispensed = await db.replyDispensal.findFirst({
        where: {
          conversationId: mirror.id,
          toMessageId: { gte: message.id },
          OR: [{ fromMessageId: null }, { fromMessageId: { lt: message.id } }],
        },
        select: { id: true },
      });
      if (dispensed) return false;
    }
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
          ...(inbox.owesMemoryOnly ? { owesMemoryOnly: true } : {}),
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

// How many times an inbox's listing may be read in one pass before the pass gives up on it. Page
// numbers shift under the read when a conversation leaves `pending` (the recoveries this pass arms can
// do that), so the listing is read again until two reads in a row name the same conversations; the
// rest waits for the next pass.
const MAX_LISTINGS_PER_INBOX = 5;

interface InboxRead {
  base: PrismaClient;
  tenantId: bigint;
  instanceId: bigint;
  client: ChatwootClient;
  inbox: BoundInbox;
  since: Date;
  settledBefore: Date;
  now: Date;
  listingBudgetMs: number;
  counts: ReconcileCounts;
  // Conversations this inbox's read could not judge, which fail the inbox once the read is done.
  failedConversations: number[];
}

// One read of a listing whose page requests outlast this is not converging (conversations arriving faster than the
// pages are read): the inbox fails the pass with its cursor held, and the other inboxes still run.
const LISTING_BUDGET_MS = 2 * 60 * 1000;

async function reconcileInbox(p: InboxRead): Promise<void> {
  p.counts.inboxesRead += 1;
  // Conversations the token's user pinned lead the listing whatever their age, possibly for whole
  // pages, so the activity order only starts after them and only an unpinned row can end the read.
  // Read around every listing: a pin made during one would read as an old row and end it early.
  // A read that only finds nothing new proves nothing: a conversation leaving between two reads shifts
  // the pages again, and the second can skip a row while naming only rows already judged.
  const read = new Set<number>();
  let previous: Set<number> | null = null;
  for (let listing = 0; listing < MAX_LISTINGS_PER_INBOX; listing++) {
    const pinned = await p.client.listPinnedConversationIds();
    const { named, overlapped } = await readListing(p, pinned, read);
    const pinnedAfter = await p.client.listPinnedConversationIds();
    if (
      previous !== null &&
      !overlapped &&
      sameIds(previous, named) &&
      sameIds(pinned, pinnedAfter)
    ) {
      if (p.failedConversations.length > 0)
        throw new Error(
          `inbox ${p.inbox.chatwootInboxId}: conversations ${p.failedConversations.join(", ")} could not be judged`,
        );
      return;
    }
    // An overlapped read missed a row, so it cannot be what the next read is compared against.
    previous = overlapped ? null : named;
  }
  throw new Error(
    `inbox ${p.inbox.chatwootInboxId} still shifted after ${MAX_LISTINGS_PER_INBOX} listings`,
  );
}

function sameIds(a: Set<number>, b: Set<number>): boolean {
  return a.size === b.size && [...a].every((id) => b.has(id));
}

// One read of the listing, judging every conversation inside the window not judged yet. Answers which
// conversations inside the window it named that had moved before the pass began: one that moved since
// is the next pass's, so it does not keep this one reading.
async function readListing(
  p: InboxRead,
  pinned: Set<number>,
  read: Set<number>,
): Promise<{ named: Set<number>; overlapped: boolean }> {
  const { client, inbox, since } = p;
  const { counts } = p;
  const named = new Set<number>();
  // Every row of this read, to see two pages overlap: the listing has a fixed length, so a row named
  // twice means another was named on no page (a conversation that moves to the top between two pages
  // pushes every row behind it down one), and such a read cannot prove the window was covered.
  const listed = new Set<number>();
  let overlapped = false;
  // No page cap: the read ends at the first unpinned row older than the window, so its length is the
  // number of conversations that moved inside it, and a cap would freeze the cursor on a busy inbox.
  // A server that ignores `page` would never end it, which is what the repeated first id catches.
  let previousFirst: number | null = null;
  // Only the listing calls count against the budget: judging each conversation is work the inbox's
  // size asks for, and counting it would fail a large, stable inbox at the same page every pass.
  let listingMs = 0;
  for (let page = 1; ; page++) {
    if (listingMs > p.listingBudgetMs)
      throw new Error(
        `inbox ${inbox.chatwootInboxId}: listing still going after ${page - 1} pages`,
      );
    const pageStarted = Date.now();
    const rows = await client.listInboxConversations(
      inbox.chatwootInboxId,
      "pending",
      page,
    );
    listingMs += Date.now() - pageStarted;
    if (rows.length === 0) return { named, overlapped };
    const first = (rows[0] as ChatwootInboxConversation).id;
    if (first === previousFirst)
      throw new Error(
        `inbox ${inbox.chatwootInboxId} page ${page} repeats the previous page`,
      );
    previousFirst = first;
    let reachedOld = false;
    for (const c of rows) {
      if (listed.has(c.id)) overlapped = true;
      listed.add(c.id);
      // An unreadable clock says nothing about where the activity order is.
      if (c.lastActivityAt === null)
        throw new Error(
          `inbox ${inbox.chatwootInboxId}: conversation ${c.id} has no activity time`,
        );
      if (c.lastActivityAt < since) {
        if (!pinned.has(c.id)) reachedOld = true;
        continue;
      }
      if (c.lastActivityAt <= p.now) named.add(c.id);
      if (read.has(c.id)) continue;
      read.add(c.id);
      // A person holds it: whatever the customer wrote is theirs to answer.
      if (c.assigneeType === "User") continue;
      counts.conversationsRead += 1;
      // One conversation that cannot be judged does not hide the ones behind it: the rest of the
      // listing is still read, and the inbox fails the pass afterwards.
      try {
        await judgeConversation(p, c.id);
      } catch (err) {
        p.failedConversations.push(c.id);
        logger.warn(
          { err, inbox: inbox.chatwootInboxId },
          "chatwoot reconcile: conversation %d could not be judged; the inbox is read again next pass",
          c.id,
        );
      }
    }
    // Past the pinned prefix the listing is newest activity first, so an unpinned row older than the
    // window means every later page is older too.
    if (reachedOld) return { named, overlapped };
  }
}

// Whether one conversation owes a customer an answer nobody received, and if so, hands it over.
async function judgeConversation(
  p: InboxRead,
  conversationId: number,
): Promise<void> {
  const { base, tenantId, instanceId, client, inbox, since, settledBefore } = p;
  const { counts } = p;
  const message = await owedOf(client, conversationId, inbox.managedBotIds);
  if (
    !message?.createdAt ||
    message.createdAt < since ||
    message.createdAt >= settledBefore
  )
    return;
  // A message from before the responder was bound was received for another role (an observer
  // promoted since keeps its bot), and the row written here would name today's binding.
  // NOTE: Chatwoot's `created_at` is whole seconds and the binding is stamped in milliseconds, so the
  // binding is compared at its second: a message in the same second may have followed it.
  if (
    inbox.responderBoundAt !== null &&
    message.createdAt.getTime() <
      Math.floor(inbox.responderBoundAt.getTime() / 1000) * 1000
  )
    return;
  if (
    await handOver(base, tenantId, instanceId, inbox, conversationId, message)
  ) {
    counts.handedToRecovery += 1;
    await lineFor(
      base,
      tenantId,
      instanceId,
      inbox,
      conversationId,
      message.id,
    );
  }
}

// A conversation's newest page, refusing what cannot say which message is newest: read as empty, an
// unreadable answer would owe nothing and let the cursor pass a message it never saw.
function readMessagePage(
  raw: unknown,
  conversationId: number,
): ChatwootMessageRow[] {
  const list = Array.isArray(raw)
    ? raw
    : raw !== null &&
        typeof raw === "object" &&
        Array.isArray((raw as { payload?: unknown }).payload)
      ? (raw as { payload: unknown[] }).payload
      : null;
  if (list === null)
    throw new Error(`conversation ${conversationId}: no message array`);
  const rows = parseChatwootMessages(list);
  // A row without its time or kind cannot be placed: it might be the customer's newest message, or
  // the reply after it.
  if (
    rows.length !== list.length ||
    rows.some((m) => m.createdAt === null || m.messageType === "other")
  )
    throw new Error(`conversation ${conversationId}: unreadable message row`);
  return rows;
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
  // How long one read of an inbox's listing may take before the inbox is given up for the pass.
  listingBudgetMs?: number;
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
    // The first pass's window is written before it is read, so a first pass that fails is retried over
    // the same window instead of one that slid forward with the clock.
    let reconciledUntil = instance.reconciledUntil;
    if (reconciledUntil === null) {
      const start = new Date(
        now.getTime() - FIRST_PASS_LOOKBACK_MS + CURSOR_MARGIN_MS,
      );
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.chatwootInstance.updateMany({
          where: { id: instance.id, reconciledUntil: null },
          data: { reconciledUntil: start },
        }),
      );
      reconciledUntil =
        (
          await runScopedOn(base, sysCtx(tenantId), (db) =>
            db.chatwootInstance.findUnique({
              where: { id: instance.id },
              select: { reconciledUntil: true },
            }),
          )
        )?.reconciledUntil ?? start;
    }
    const since = new Date(reconciledUntil.getTime() - CURSOR_MARGIN_MS);
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
          now,
          listingBudgetMs: params.listingBudgetMs ?? LISTING_BUDGET_MS,
          counts,
          failedConversations: [],
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
        // The alert's text is this message when one is set, and the count is what the operator reads.
        errorMessage: `${counts.handedToRecovery} customer ${counts.handedToRecovery === 1 ? "message" : "messages"} the delivery ledger never received ${counts.handedToRecovery === 1 ? "was" : "were"} found in Chatwoot and handed to recovery`,
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

export async function reconcileSweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
  ctx?: JobContext,
): Promise<JobResult> {
  // Committed from the start: every write a pass makes is idempotent, so a pass on a busy account
  // that outruns the run's deadline still has its reschedule written instead of spending retries.
  ctx?.commit();
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
