import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { resolveGraphThreadId } from "@/graph/checkpointer";
import { INGEST_ID_WINDOW, ingestVerdict } from "@/graph/ingest-dedup";
import { armIngest } from "@/graph/ingest-job";
import { resetLandedAfter, threadResetBoundary } from "@/graph/reset-episode";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { ingestsContinuously } from "@/modules/agents/mode";
import { writeFlowEvent } from "@/modules/flowlog/service";
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
// THE PREMISE THAT BLOCKED THIS FOR THREE ISSUES, and why it is no longer true. Both neighbours used
// to state it as a fact about the ledger: the takeover recovery, that no outgoing message is named
// there at all; the sweep's `observer-strand`, that a recovery has only ever had a customer's message
// to anchor on. Each was accurate when it was written, and both stopped being accurate at issue
// #469, which added `humanReplyMessageId` and has written it at INSERT for every colleague's reply
// since — for the takeover's own fence, which needed one coordinate to order a console write
// against. One column, two readers: the fence that refuses, and now the read that rebuilds. Both
// sentences were corrected where they lived; they are paraphrased and not quoted here on purpose,
// because a claim the tree no longer makes should not be findable in it.
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
  // NOBODY CAN TELL ANY MORE, and the recovery says that instead of guessing (review r2, narrowed in
  // r5). The thread's dedup window has moved past this id, so the append the job would arm is one
  // `ingestMessageIntoThread` refuses as `ancient` — SUCCESSFULLY, so a job armed anyway completes
  // and nothing anywhere says the reply never landed.
  //
  // What the window CANNOT say is which of the two happened. Eviction is not absence: a delivery
  // that crashed after arming its ingestion and before settling leaves a row exactly like this one,
  // and its reply is already in the memory — sixty-four attendant messages later, that remembered
  // reply reads `ancient` too. The first version of this outcome was called `gone` and told the
  // operator the words were lost and had to be re-entered by hand, which on that path is an
  // instruction to duplicate a message that is already there.
  | "undecided"
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
        // WHICH ROUTE the delivery arrived on, so the recovery asks about the SAME agent the live
        // path did. The takeover recovery reads `routeAgentBotId` for the neighbouring reason; here
        // it is what separates a watcher's lost append from a responder's (review r1).
        routeObserved: true,
        routeAgentBotId: true,
        // WHEN THE MESSAGE ARRIVED, which is what dates the evidence used to recover an unstated
        // role: a binding younger than the delivery describes another moment.
        receivedAt: true,
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
      select: {
        id: true,
        inboxId: true,
        contactInboxId: true,
        // WHO HOLDS IT, which is half of the answer to "was this an observer's route?" — see the
        // exception below. The mirror is the only source here: there is no payload to prefer, which
        // is the same fallback the receiver makes for a silent one.
        assigneeType: true,
        assigneeId: true,
      },
    });
    if (!conv) return null;
    // THE MIRROR KNOWS THE CONVERSATION AND NOT ITS INBOX, which is a THIRD state and not the
    // absence of an inbox (review r6). `upsertInbox` answers null for an event whose payload names
    // no inbox, and the row is created with `inbox_id` null; a later event fills it in
    // (`decision.unversioned && inboxRowId != null`). Collapsed into the "no route" answer below, a
    // conversation in that state resolved `not-owed` — terminal, so the reply was never read back
    // and nothing ever revisited the row, on a mirror that Chatwoot could have completed a minute
    // later.
    if (conv.inboxId === null) return "sparse" as const;
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { id: true, agentId: true, provider: true },
    });
    if (!inbox?.agentId) return null;
    // THE ROUTE'S OWN AGENT, AND THE TWO ROUTES RESOLVE IT DIFFERENTLY — which is not symmetry the
    // receiver could have had, it is what `resolveRoute` actually does (review r1, corrected in r3):
    //
    //   const responder = await inboxAgentRuntime(tenantId, instanceId, n.inboxId, …)
    //   const watcher   = await observerRuntimeForRoute(tenantId, instanceId, params.agentBotId, …)
    //   const rt        = watcher ?? responder
    //
    // So a WATCHER's runtime comes from the bot the delivery arrived on, and a RESPONDER's comes
    // from the INBOX — never from the bot. The difference is reachable: Chatwoot fans a message to
    // the conversation's assigned bot and to the inbox's, so on a conversation another persona's bot
    // holds, `routeAgentBotId` names that persona while the ingestion ran under the inbox's
    // responder. Asked through the bot on both routes, a `test`-mode or switched-off assigned agent
    // discards an append the inbox's production responder owed — and a responder rebind does the
    // same to every row written before it.
    //
    // Reading `Inbox.agentId` on BOTH routes was the r1 defect and it is not what this restores: the
    // watcher's half stays resolved through the bot, because there the bot IS the route.
    //
    // AND `routeObserved` HAS A THIRD VALUE (review r4). The claim is what states the role
    // (`routeObserved: observer !== null`, written by the very UPDATE that takes the row), so a
    // delivery stranded BEFORE its claim carries null — and `role-unstated` is one of the three
    // verdicts the sweep arms this recovery from, which is to say the null is not an edge case here,
    // it is a whole third of the inbound work. Read as `false`, an observer's lost append beside a
    // `test`-mode or switched-off responder is discarded on the responder's gate, permanently, since
    // the terminal row is never revisited: the r1 defect arriving by the one door r1 left open.
    //
    // The evidence that survives an unclaimed row is `routeAgentBotId`, written at INSERT, and the
    // question the receiver asks of it is whether that bot's agent OBSERVES this inbox — the same
    // row `observerRuntimeForRoute` requires before it will call a route a watcher's. So the role is
    // recovered from the binding rather than assumed, and a pending attachment counts, for the
    // reason the schema states: every reader that asks whether an agent observes an inbox counts a
    // pending row, because the attachment may already be live upstream.
    const routeBotAgentId =
      row.routeAgentBotId === null
        ? null
        : ((
            await db.chatwootAgentBot.findFirst({
              where: {
                tenantId,
                chatwootInstanceId: instanceId,
                chatwootAgentBotId: row.routeAgentBotId,
              },
              select: { agentId: true },
            })
          )?.agentId ?? null);
    // HOLDING THE CONVERSATION ENDS THE QUESTION, row or no row (issue #476 review, rounds 8 and 11,
    // brought here by review r9). The fork delivers to the conversation's assignee bot as well, and
    // an agent that used to answer this inbox keeps holding what it was assigned — including after
    // it becomes the watcher. `observerRuntimeForRoute` refuses to call that route an observer's
    // whenever the inbox has a responder of its own, which it does here by construction (the read
    // above returns null without one). Recovered as an observer's, a strand on a conversation this
    // bot holds would fold a reply into memory on a route the live path resolves to the inbox's
    // responder — a `test`-mode one remembering nothing.
    const heldByRouteBot =
      conv.assigneeType === "AgentBot" &&
      conv.assigneeId !== null &&
      conv.assigneeId === row.routeAgentBotId;
    const observed =
      row.routeObserved ??
      (!heldByRouteBot &&
        routeBotAgentId !== null &&
        routeBotAgentId !== inbox.agentId &&
        (await db.inboxObserver.count({
          where: {
            tenantId,
            inboxId: inbox.id,
            agentId: routeBotAgentId,
            // AND OLDER THAN THE DELIVERY, which is the rule this subsystem already states for the
            // other piece of after-the-fact evidence: "bot equality is evidence about the role only
            // while the binding is OLDER than the delivery" (docs/chatwoot.md). An agent attached
            // as an observer AFTER this message arrived says nothing about the route it arrived on,
            // and reading it as one would arm the append under an agent that was not there. The
            // sweep runs half an hour later, so that window is real.
            //
            // The other direction is left conservative on purpose: an attachment the fork had not
            // confirmed when the message landed reads as the responder's route, which is the answer
            // this recovery gave for every null before r4.
            createdAt: { lte: row.receivedAt },
          },
        })) > 0);
    const routeAgentId = observed ? routeBotAgentId : inbox.agentId;
    if (routeAgentId === null) return null;
    const agent = await db.agent.findUnique({
      where: { id: routeAgentId },
      select: { mode: true, enabled: true, settings: true },
    });
    if (!agent) return null;
    // WHETHER A RESPONDER OF OURS ANSWERS THIS INBOX, which is the other half of the watcher's own
    // condition: an observer beside a responder shares that responder's memory and folds into it; an
    // observer with none folds nothing (issue #620). Asked of the inbox's binding, which is the same
    // reading `routeRemembers` makes.
    const responder = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { enabled: true },
    });
    return {
      contactInboxId: conv.contactInboxId,
      // The MIRROR's row id, which is what a flow-log line hangs on — the reports an operator reads
      // are keyed by it, not by Chatwoot's display id.
      conversationRowId: conv.id,
      agentId: routeAgentId,
      whatsappProvider: inbox.provider,
      mode: agent.mode,
      enabled: agent.enabled,
      settings: agent.settings,
      responderExists: responder !== null,
      // The role as this recovery RESOLVED it, which is the ledger's when the claim stated one and
      // the binding's when it did not.
      observed,
    };
  });
  // THE MIRROR HAS THE CONVERSATION AND NOT THE INBOX: a row another event completes, so the same
  // answer the unknown conversation gets (review r6).
  if (bound === "sparse") {
    logger.warn(
      "chatwoot human-reply recovery: %s names conversation %d, whose mirrored row carries no inbox yet; retrying",
      row.deliveryId,
      conversationId,
    );
    return "unresolved";
  }
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
  // WHETHER THIS ROUTE REMEMBERS AT ALL, asked of the agent and not of the row (see the header), and
  // asked PER ROUTE because the receiver asks it per route:
  //
  //   `routeRemembers = rt.enabled && (observer !== null ? responderRt !== null : ingestsContinuously(rt.mode))`
  //
  // On a WATCHER's route the mode is deliberately not asked — the row-backed observer decides this
  // whatever its mode says, and only its switch is asked (issue #476 review, round 19) — and what IS
  // asked is whether a responder of ours answers the inbox at all, because that responder's thread
  // is the memory the watcher folds into (issue #620). On the responder's own route it is the mode.
  //
  // Read as the responder's on both, which is what shipped in the first draft of this file, the
  // watcher's lost append is discarded whenever the responder is in `test` mode or switched off —
  // silently, and permanently, since nothing revisits the row (review r1).
  //
  // A `test`-mode responder leaves a row byte for byte like the one a failed enqueue leaves, and the
  // difference between "owed and failed" and "never owed" lives here and nowhere else.
  const routeRemembers =
    bound.enabled &&
    (bound.observed ? bound.responderExists : ingestsContinuously(bound.mode));
  if (!routeRemembers) return "not-owed";
  // NO THREAD TO HOLD IT, which is the ingestion's own `"no-thread"` answer arriving by the other
  // road. The receiver already reported that case as the permanent loss it is and settled the row;
  // a recovery armed on one anyway has nothing to key a thread by.
  if (bound.contactInboxId === null) return "not-owed";
  const contactInboxId = bound.contactInboxId;
  // THE EPISODE BOUNDARY, and this is the one refusal here that protects against ACTIVE HARM rather
  // than against wasted work (review r1). `/reset` clears the thread and, inside the same critical
  // section, revokes every queued `INGEST_MESSAGE` for it — precisely because an append carrying
  // text from before the reset would rebuild the memory an operator was just told had been cleared.
  // It cannot revoke this job: the recovery is a kind of its own, armed before the command and
  // running after it, and deleting the thread takes the append dedup with it, so nothing downstream
  // would catch the duplicate either. Asked with the tree's own predicate, against Chatwoot's
  // sequence, which is the order the operator actually experienced.
  //
  // A VERDICT, not a deferral: the boundary never moves back (`GREATEST`), so a later attempt asks
  // the same question and gets the same answer.
  //
  // AND THIS ONE IS THE CHEAP HALF, not the fence. The fence is the second reading, immediately
  // before the arm: a `/reset` landing during the REST round trip is exactly the case this exists
  // for, and only that reading can see it. What this buys is the round trip itself on a conversation
  // already cleared, which on a backfill is one Chatwoot call per stranded reply of a whole episode.
  //
  // It has a test of its own for exactly that, and it needed one: on the first battery, deleting
  // this line alone killed nothing — the second reading answered the same way and every assertion
  // still passed. What makes it load-bearing is asserting the ABSENCE OF THE CALL, not the verdict,
  // which is the shape a "cheap half" has to be measured by.
  if (
    resetLandedAfter(
      messageId,
      await threadResetBoundary(tenantId, instanceId, contactInboxId, base),
    )
  ) {
    logger.info(
      "chatwoot human-reply recovery: %s names message %d on conversation %d, which a /reset has since cleared; not restoring it",
      row.deliveryId,
      messageId,
      conversationId,
    );
    return "not-owed";
  }

  // AND WHETHER THE APPEND CAN STILL LAND AT ALL (review r2). The thread remembers the last
  // `INGEST_ID_WINDOW` ids per direction, and once that window is SATURATED an id below its floor is
  // `ancient`: `ingestMessageIntoThread` refuses it rather than appending, because at that distance
  // absence from the set stops being evidence of anything. That refusal is a success — the job
  // completes, the row disappears on DONE, and the words are permanently absent with every line in
  // the system saying the recovery worked.
  //
  // So it is asked HERE, where there is still somewhere to say it. `duplicate` is the ordinary happy
  // answer for a row stranded AFTER the append landed and costs a job that would refuse anyway;
  // `ancient` is the loss, and it gets a line an operator can act on, because at that point the only
  // way the words reach the agent is a person putting them there.
  //
  // ASKED BEFORE THE NETWORK, and that ordering is a correction rather than a preference (issue
  // #728, verifier round 2): the first draft read the page and asked afterwards, so `duplicate` and
  // `ancient` each cost a Chatwoot round trip — and those are precisely the two answers a backlog
  // produces in bulk. Nothing in the message decides either of them; the thread's own row does.
  //
  // EVIDENCE, NOT A GUARANTEE, exactly like the takeover recovery's cheap ownership look: the window
  // can move between this read and the job's own. What it buys is that the common outcomes stop
  // being silent, not that the race is closed — the job re-asks under the thread's lock, which is
  // where the answer is authoritative.
  const thread = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.agentThread.findUnique({
      where: {
        tenantId_chatwootInstanceId_contactInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          contactInboxId,
        },
      },
      select: { recentAgentMessageIds: true },
    }),
  );
  const verdict =
    thread === null
      ? "new"
      : ingestVerdict(thread.recentAgentMessageIds, messageId);
  if (verdict === "duplicate") return "not-owed";
  if (verdict === "ancient") {
    logger.error(
      "chatwoot human-reply recovery: %s names message %d on conversation %d, which is older than everything that thread's memory still remembers; whether the reply reached the agent cannot be decided from here and a person has to read the conversation",
      row.deliveryId,
      messageId,
      conversationId,
    );
    // AND WHERE AN OPERATOR ACTUALLY LOOKS (verifier round 2). The line above is a process log, and
    // a process log is not durable, not queryable by conversation, and gone with the container —
    // which is the standard this repo's own reports are held to. Without this, the only line naming
    // this message stays `human_reply_not_remembered`, written by the receiver at the moment of the
    // loss, and that reason means something this one does not: it says the loss is transient and a
    // retry is coming. Nothing is coming; this is where the retrying stops.
    //
    // AND IT REPORTS THE UNCERTAINTY, NOT A LOSS (review r5). Eviction from the window is not
    // evidence of absence: past the floor the set answers "I no longer carry this id", which is the
    // same answer for a reply that never landed and for one that landed sixty-four messages ago —
    // and the second is reachable, from a delivery that armed its ingestion and crashed before
    // settling. Reported as a permanent loss, this line tells an operator to re-type words that may
    // already be in the memory, which is the duplicate the whole dedup window exists to prevent.
    //
    // At `error` all the same, and for the level's own reason: this is the one path where the
    // machinery stops and a person has to read the conversation to decide.
    await writeFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: bound.conversationRowId,
        agentId: bound.agentId,
        base,
      },
      {
        stage: "memory",
        level: "error",
        status: "error",
        detail: {
          reason: "human_reply_recovery_undecidable",
          messageId,
          window: INGEST_ID_WINDOW,
        },
      },
    );
    return "undecided";
  }

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

  // ASKED AGAIN, IMMEDIATELY BEFORE THE ARM, because the read above happened before a REST round
  // trip and a `/reset` inside that stretch is exactly the one this fence exists for — the command
  // revokes what is queued, and this would queue after it. It does not CLOSE the window: the reset
  // can still land between this read and the enqueue, and what bounds that residue is the command's
  // own critical section, which holds the thread row and refuses while an append is in flight
  // (`threadBusyForResetOn`). Narrowing the gap from a network round trip to two statements is what
  // is available here; claiming it is closed would be the lie.
  const clearedSince = await threadResetBoundary(
    tenantId,
    instanceId,
    contactInboxId,
    base,
  );
  if (resetLandedAfter(messageId, clearedSince)) {
    logger.info(
      "chatwoot human-reply recovery: %s was cleared by a /reset while its message was being read back (conversation %d); not restoring it",
      row.deliveryId,
      conversationId,
    );
    return "not-owed";
  }

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
  // `undecided` COMPLETES, and that is not the same as succeeding: the uncertainty is already
  // reported at `error` by the line above, on the conversation and the message. Retrying it would
  // ask a window that only moves further away, and dead-lettering would announce the same thing a
  // second time through a channel that says "a job died" rather than "a person has to look".
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
