import type { PrismaClient } from "@/../generated/prisma/client";
import { broadcastConversationEvent } from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { chatwootThreadId, resolveGraphThreadId } from "@/graph/checkpointer";
import {
  clearTurnReserved,
  isFlushHeld,
  isTurnInFlight,
  markTurnReserved,
} from "@/graph/inflight";
import { turnOwnsThread } from "@/graph/thread-claim";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  claimOpenForHumanQueue,
  conversationOwnershipNow,
  openForHumanQueue,
  withdrawClaim,
} from "@/modules/chatwoot/human-takeover";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  maxIncomingId,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  parseLiveConversation,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { reconcileMirrorFromLive } from "@/modules/chatwoot/reconcile";
import { assignPinnedTarget } from "@/modules/handoff/assign-pinned";
import {
  type HandoffConfig,
  readHandoffConfig,
} from "@/modules/handoff/settings";

// Hands the conversation to the team, with a private note, when a turn is definitively lost, so the
// person working the inbox has it in their queue and can tell a dead turn from an agent that chose
// silence. The hand-over closes `shouldBotHandle` (the gate a pending retry depends on), so a
// premature one causes the failure it reports. That is why it hangs off the dead-letter event, never a handler's catch: a job announces
// only when its `failJob` CAS actually moved the row to DEAD, and the direct path only when no newer
// incoming message exists (the `shouldPost` supersede fence). An unreadable fence does not announce:
// a missing note costs less than a conversation taken over while its answer was still coming.

export type TurnFailure =
  // A scheduler job. `deadLettered` is the CAS result, not the attempt count: only the statement that
  // actually moved the row to DEAD may claim the turn is over.
  | { path: "job"; deadLettered: boolean }
  // The direct path. `clear` = no newer incoming message exists, so nothing else will answer;
  // `superseded` = one does; `unknown` = the fence could not be read.
  | { path: "direct"; fence: "clear" | "superseded" | "unknown" };

export function isTurnLost(f: TurnFailure): boolean {
  return f.path === "job" ? f.deadLettered : f.fence === "clear";
}

// The direct path's fence, read the same way the success path reads it at `shouldPost`: a newer
// incoming message than the one this turn was triggered by means another turn is coming for it, and
// that turn may well answer. Admin-token read (same as the flush's re-fetch), so it does not depend
// on the persona bot resolving.
export async function readDirectFence(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  triggerId: number | null;
  base?: PrismaClient;
  deps?: LoadChatwootClientDeps;
}): Promise<"clear" | "superseded" | "unknown"> {
  // NOTE: No trigger message (a non-message event, or a payload without one) means there is nothing
  // to compare against, so the fence cannot say anything and the turn is not announced.
  if (params.triggerId === null) return "unknown";
  try {
    const client = await loadChatwootClient(
      params.tenantId,
      params.instanceId,
      {
        ...params.deps,
        base: params.base ?? basePrisma,
      },
    );
    const latest = parseChatwootMessages(
      await client.getMessages(params.chatwootConversationId),
    );
    return maxIncomingId(latest, params.triggerId) > params.triggerId
      ? "superseded"
      : "clear";
  } catch (err) {
    logger.warn(
      "conversations: failed-turn fence unreadable (conv=%s): %s",
      String(params.chatwootConversationId),
      err instanceof Error ? err.message : String(err),
    );
    return "unknown";
  }
}

// One announcement per conversation per window. A provider outage burns through every conversation
// in an inbox, and an inbox buried in identical notes is the same as no notes at all.
export const FAILURE_NOTICE_COOLDOWN_MS = 30 * 60_000;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Elects the single announcer, atomically. Two concurrent failures on one conversation both read the
// same pre-failure stamp, so a read-then-write cooldown lets both through; the claim therefore IS the
// write — whoever's conditional UPDATE matches the row gets the note, and the other sees 0 rows.
//
// NOTE: A claim whose post then fails keeps the stamp, so that conversation stays quiet for the rest
// of the window. That direction is deliberate: the failure mode of a post is a Chatwoot that is down,
// where a re-claim would not deliver anything either, and releasing the claim is exactly how one
// failed turn becomes two notes once it comes back.
export async function claimFailureNotice(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  now?: Date;
  cooldownMs?: number;
  base?: PrismaClient;
}): Promise<boolean> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? new Date();
  const cooldownMs = params.cooldownMs ?? FAILURE_NOTICE_COOLDOWN_MS;
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { count } = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.conversation.updateMany({
      where: {
        tenantId: params.tenantId,
        chatwootInstanceId: params.instanceId,
        chatwootConversationId: params.chatwootConversationId,
        OR: [
          { failureNoticeSentAt: null },
          { failureNoticeSentAt: { lt: cutoff } },
        ],
      },
      data: { failureNoticeSentAt: now },
    }),
  );
  return count > 0;
}

// The persona whose conversation this is, so the note is posted AS the agent the operator sees on the
// inbox. `loadChatwootClient` defaults the bot token to "" and Chatwoot answers 401, which a
// best-effort catch swallows — a note that never posts at all. The bot comes from the conversation's
// inbox (`Inbox.agentId`), the same resolution the console does. The agent's handoff setting comes
// along, so the hand-over lands where `handoff_to_human` would send it.
async function personaOf(
  tenantId: bigint,
  instanceId: bigint,
  chatwootConversationId: number,
  base: PrismaClient,
): Promise<{
  botToken: string;
  chatwootAgentBotId: number;
  handoff: HandoffConfig;
} | null> {
  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId,
      },
      select: { inbox: { select: { agentId: true } } },
    }),
  );
  const agentId = conv?.inbox?.agentId;
  if (agentId == null) return null;
  const bot = await loadAgentBot(tenantId, instanceId, agentId, base);
  if (!bot?.accessToken) return null;
  const agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.agent.findUnique({ where: { id: agentId }, select: { settings: true } }),
  );
  return {
    botToken: bot.accessToken,
    chatwootAgentBotId: bot.chatwootAgentBotId,
    handoff: readHandoffConfig(agent?.settings ?? null),
  };
}

// Both keys a turn claims, the pair the delivery recovery asks: the conversation's, and the graph
// thread's, also read off its row because the in-process Map cannot see another replica. A row that
// cannot be read counts as held.
async function turnKeysOf(
  tenantId: bigint,
  instanceId: bigint,
  conversationId: number,
  base: PrismaClient,
): Promise<{
  handoffKey: string;
  graphKey: string;
  contactInboxId: number | null;
  // The mirror row, for the console broadcast of the claim; null when the mirror does not know it.
  rowId: bigint | null;
  lastEventAt: Date | null;
  lastInboundAt: Date | null;
}> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
      },
      select: {
        id: true,
        contactInboxId: true,
        lastEventAt: true,
        lastInboundAt: true,
      },
    }),
  );
  const contactInboxId = row?.contactInboxId ?? null;
  return {
    handoffKey: chatwootThreadId(tenantId, instanceId, conversationId),
    graphKey: resolveGraphThreadId(
      tenantId,
      instanceId,
      conversationId,
      contactInboxId,
    ),
    contactInboxId,
    rowId: row?.id ?? null,
    lastEventAt: row?.lastEventAt ?? null,
    lastInboundAt: row?.lastInboundAt ?? null,
  };
}

// The in-process half, synchronous so it can be the last thing before a reservation.
function turnBusyHere(keys: { handoffKey: string; graphKey: string }): boolean {
  return (
    isTurnInFlight(keys.handoffKey) ||
    isTurnInFlight(keys.graphKey) ||
    isFlushHeld(keys.handoffKey) ||
    isFlushHeld(keys.graphKey)
  );
}

// Markdown, which Chatwoot renders in a private note. The first line is what an operator scanning
// the conversation reads, so it says what happened; the second says what was done about it, which
// is the part that tells them whether anyone has the conversation yet.
export function noteText(reason: string, opened: boolean): string {
  // The reason is an error message: a backtick in it would close the code span early.
  const quoted = reason.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  return [
    "**⚠️ O agente não conseguiu responder esta conversa.**",
    opened
      ? "Ela foi aberta para a equipe assumir."
      : "Alguém da equipe precisa assumir.",
    `**Motivo:** \`${quoted}\``,
  ].join("\n\n");
}

// Best-effort end to end: a Chatwoot that is down must never turn one failed turn into two. `assess`
// is called right before acting, since a message arriving after the failure can start a new turn.
// A lost turn is HANDED OVER, not only announced: a note on a conversation still `pending` with the
// bot is in nobody's queue. Status, then the pinned target, note last (as graph/skip-handover.ts).
// The note's window coalesces only the note: a conversation returned to the bot and failing again
// still has to reach a person. More in docs/chatwoot.md, "A full database pool".
export async function announceFailedTurn(params: {
  tenantId: bigint;
  instanceId: bigint;
  chatwootConversationId: number;
  assess: () => Promise<TurnFailure>;
  error: unknown;
  now?: Date;
  cooldownMs?: number;
  base?: PrismaClient;
  deps?: LoadChatwootClientDeps;
}): Promise<"posted" | "not-lost" | "coalesced" | "failed"> {
  const base = params.base ?? basePrisma;
  const {
    tenantId,
    instanceId,
    chatwootConversationId: conversationId,
  } = params;
  try {
    const persona = await personaOf(tenantId, instanceId, conversationId, base);
    if (persona === null) {
      logger.warn(
        "conversations: no persona bot to announce a failed turn as (conv=%s)",
        String(conversationId),
      );
      return "failed";
    }
    if (!isTurnLost(await params.assess())) return "not-lost";
    const client = await loadChatwootClient(tenantId, instanceId, {
      ...params.deps,
      base,
      botToken: persona.botToken,
    });
    // Asked again as the last fence before the toggle, after the ownership reads: a newer message
    // landing since the first ask has a turn of its own coming, and opening the conversation would
    // stop it. Then nothing is announced at all, as for the first ask.
    // Null when the ownership fence refused, which leaves the first ask standing. Any read here that
    // throws fails closed (`unreadable`), since the reason to ask again is a turn that may have
    // started meanwhile, and an unread fence cannot rule that out.
    let lastAsk: "lost" | "not-lost" | "unreadable" | null = null;
    let reserved: { handoffKey: string; graphKey: string } | null = null;
    // The mirror's claim, taken inside the fence and released or stamped after the toggle, as the
    // human-reply takeover does. Typed through the cast because the closure assigns it, and a plain
    // `null` would narrow every later read to `never`.
    let claimHeld = null as Date | null;
    let rowOf = null as { id: bigint | null; lastEventAt: Date | null } | null;
    let queued: Awaited<ReturnType<typeof openForHumanQueue>>;
    try {
      queued = await openForHumanQueue({
        gate: "failed-turn",
        conversationId,
        stillOurs: async () => {
          lastAsk = "unreadable";
          // Chatwoot first, since the mirror can be behind it: a person who claimed the conversation
          // while it stayed `pending` would otherwise lose it to the pinned target. Unreadable does not
          // block; the mirror still answers.
          const live = parseLiveConversation(
            await client.getConversation(conversationId).catch(() => null),
          );
          if (
            live !== null &&
            !shouldBotHandle(
              {
                assigneeType: live.assigneeType,
                assigneeId: live.assigneeId,
                status: live.status,
              },
              { ourAgentBotId: persona.chatwootAgentBotId },
            )
          ) {
            lastAsk = null;
            return false;
          }
          const ownership = await conversationOwnershipNow({
            tenantId,
            instanceId,
            conversationId,
            ourAgentBotId: persona.chatwootAgentBotId,
            base,
          });
          if (!ownership.ours) {
            lastAsk = null;
            return false;
          }
          // A turn already running on the conversation (an operator's re-engage, a follow-up, a
          // flush) was started without a new message, so neither ask can see it; opening the
          // conversation would discard its reply. It may still answer, so nothing is announced.
          const keys = await turnKeysOf(
            tenantId,
            instanceId,
            conversationId,
            base,
          );
          const heldElsewhere =
            keys.contactInboxId != null &&
            (await turnOwnsThread(
              {
                tenantId,
                instanceId,
                contactInboxId: keys.contactInboxId,
                graphThreadId: keys.graphKey,
              },
              base,
            ));
          if (heldElsewhere || turnBusyHere(keys)) {
            lastAsk = "not-lost";
            return false;
          }
          lastAsk = isTurnLost(await params.assess()) ? "lost" : "not-lost";
          if (lastAsk === "not-lost") return false;
          // Asked again with nothing awaited before the reservation: a turn that started during the
          // last ask is seen here, and one starting after defers on the reservation, held to the toggle.
          if (turnBusyHere(keys)) {
            lastAsk = "not-lost";
            return false;
          }
          markTurnReserved(keys.handoffKey);
          markTurnReserved(keys.graphKey);
          reserved = keys;
          // The mirror moves BEFORE the toggle and under the reservation, as the human-reply
          // takeover's does: until it says `open` every reader of the row (a re-engage, the runtime's
          // ownership checks) still sees a bot-owned conversation, and the reservation is what keeps
          // them out until then. Pinned to the row the fence read, so a lost swap is a newer
          // decision (a hand-back, a person claiming it) and closes the fence like any refusal. No
          // mirror row has nothing to claim and nothing a reader could misread.
          if (keys.rowId === null) return true;
          claimHeld = await claimOpenForHumanQueue({
            tenantId,
            instanceId,
            conversationId,
            seen: ownership,
            // Read before the last ask: a customer message mirrored since starts a direct turn that
            // the reservation does not hold back, and loses the swap here instead of its reply.
            lastInboundAt: keys.lastInboundAt,
            base,
          });
          // The turn is still lost (`lastAsk` stays so): only the hand-over yields, and the note asks
          // for someone.
          if (claimHeld === null) return false;
          rowOf = { id: keys.rowId, lastEventAt: keys.lastEventAt };
          broadcastConversationEvent(tenantId, {
            conversationId: String(keys.rowId),
            status: "open",
            assigneeId: ownership.assigneeId,
            assigneeType: ownership.assigneeType,
            lastEventAt: keys.lastEventAt
              ? keys.lastEventAt.toISOString()
              : null,
          });
          return true;
        },
        client: async () => client,
      });
    } finally {
      if (reserved !== null) {
        const held: { handoffKey: string; graphKey: string } = reserved;
        clearTurnReserved(held.handoffKey);
        clearTurnReserved(held.graphKey);
      }
    }
    const opened = queued === "opened";
    const claim = claimHeld;
    const row = rowOf;
    // Chatwoot refused the toggle after the claim (it moved on in between): the row says `open`
    // where Chatwoot never will, so it takes the source's state through the claim it owns.
    if (queued === "refused" && claim !== null) {
      await withdrawClaim({
        tenantId,
        instanceId,
        conversationId,
        conversationRowId: row?.id ?? null,
        claimUntil: claim,
        client: async () => client,
        base,
      }).catch((err) =>
        logger.warn(
          "conversations: correcting the mirror after a refused failed-turn hand-over failed (conv=%s): %s",
          String(conversationId),
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
    // Opened: a versioned live read stamps the claim, through it, so a hand-back the operator makes
    // during the claim's window is ordered against it instead of refused by it. A failed toggle
    // keeps the claim to run out, as the takeover's does (an unknown outcome).
    if (opened && claim !== null) {
      try {
        const live = parseLiveConversation(
          await client.getConversation(conversationId),
        );
        if (live && live.updatedAt !== null) {
          await reconcileMirrorFromLive({
            tenantId,
            instanceId,
            conversationId,
            live,
            ownsStatusClaim: claim,
            base,
          });
        }
      } catch (err) {
        logger.warn(
          "conversations: reconciling the mirror after the failed-turn hand-over failed (conv=%s): %s",
          String(conversationId),
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (lastAsk === "not-lost") return "not-lost";
    if (lastAsk === "unreadable") return "failed";
    if (opened) {
      await assignPinnedTarget({
        client,
        conversationId,
        instanceId,
        handoff: persona.handoff,
        // Asked of Chatwoot right before the write, since the fence was before the toggle: a person
        // who took the conversation since, or an operator who handed it back, is not overwritten
        // with the pinned target. Unreadable does not block, as in the fence: the toggle just landed.
        stillWanted: async () => {
          const now = parseLiveConversation(
            await client.getConversation(conversationId).catch(() => null),
          );
          return (
            now === null ||
            (now.status === "open" &&
              (now.assigneeType === null ||
                (now.assigneeType === "AgentBot" &&
                  now.assigneeId === persona.chatwootAgentBotId)))
          );
        },
        logLabel: "failed-turn handoff",
      });
    }
    if (
      !(await claimFailureNotice({
        tenantId,
        instanceId,
        chatwootConversationId: conversationId,
        now: params.now,
        cooldownMs: params.cooldownMs,
        base,
      }))
    ) {
      return "coalesced";
    }
    await client.sendPrivateNote(
      conversationId,
      noteText(sanitizeErrorMessage(params.error), opened),
    );
    return "posted";
  } catch (err) {
    logger.warn(
      "conversations: failed-turn note not posted (conv=%s): %s",
      String(conversationId),
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}
