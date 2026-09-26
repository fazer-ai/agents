import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { runScopedOn } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  hasAnswerableContent,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  parseLiveConversation,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { recordResolutionOrigin } from "@/modules/conversations/record-resolution";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { ourSideHasSpoken } from "@/modules/followups/eligibility";

// A CONVERSATION WHOSE CUSTOMER SAID NOTHING, AND THAT NOBODY ON OUR SIDE EVER ANSWERED (issue #895).
//
// A message with no text, no attachment, no email subject and no image in the body is never selected
// for a turn (`hasAnswerableContent`), so no model runs and nothing is sent. That is right. What was
// wrong is what it left behind: the conversation stayed `pending` and bot-owned, and on a NEW
// conversation nothing ever moved it again. The follow-up only arms where our side has spoken, and
// here it never did. Measured on an email inbox: blank emails sat in the pending queue for days, with
// no log line for the agent at all.
//
// So the caller that found nothing to answer asks this, and it closes the conversation when all of
// these hold, each read at the last moment it can be:
//
//   - our side never spoke here (the mirror row, the follow-up's own predicate). Where it did, the
//     follow-up already covers the conversation, and closing would cut its ladder short;
//   - the thread holds no incoming message that IS answerable, and no reaction. The caller's burst
//     only saw messages above the watermark; this reads the WHOLE history (the catch-up read from the
//     first id, which also carries every reaction), so a message a previous turn left unanswered keeps
//     the conversation open for whatever handles that. The default page would not do: it is the last
//     twenty, and a request older than that is exactly the one nobody answered. A history the read
//     cannot hold in one batch is not proven blank, so it is left alone;
//   - Chatwoot, read live, still has it `pending` with our bot (or nobody) holding it. An operator
//     who took it, or an escalation that opened it, is never overruled;
//   - the caller still wants it, asked right before the write (`stillWanted`): the reads above are
//     waits a `/reset`, an agent switched off or the job's deadline can land inside, and none of the
//     caller's own fences run after this point. Withdrawn closes nothing and says nothing.
//
// Recorded as `nothing_to_answer`, which the dashboard counts as a close by somebody other than the
// agent: no model judged anything. The line is `info`, not `warn`: this is not a failure, and an
// alert channel has nothing to act on. Best-effort and never throws: the caller's flush or turn has
// already settled. A failed close is the exception, and says so at `warn`.
// A customer-facing message from our side: a reply, a nudge or a template. A private note is not.
function weSpoke(m: { messageType: string; private: boolean }): boolean {
  return (
    (m.messageType === "outgoing" || m.messageType === "template") && !m.private
  );
}

// The fork's `MessageFinder::CATCH_UP_LIMIT`: a batch this full may have more behind it.
const HISTORY_BATCH = 100;

export async function closeIfNothingToAnswer(params: {
  client: ChatwootClient;
  conversationId: number;
  conversationDbId: bigint | null;
  ourAgentBotId: number | null;
  tenantId: bigint;
  instanceId: bigint;
  base: PrismaClient;
  flow: FlowContext;
  stage: "debounce" | "route";
  stillWanted: () => Promise<boolean>;
}): Promise<boolean> {
  const { client, conversationId, conversationDbId, tenantId, base } = params;
  if (conversationDbId === null) return false;
  try {
    const row = await runScopedOn(
      base,
      { tenantId, userId: null, role: "TENANT_ADMIN" },
      (db) =>
        db.conversation.findUnique({
          where: { id: conversationDbId },
          select: {
            lastRepliedMessageId: true,
            chatwootFirstReplyAt: true,
            lastProactiveAt: true,
          },
        }),
    );
    if (!row || ourSideHasSpoken(row)) return false;

    const messages = parseChatwootMessages(
      await client.getMessages(conversationId, { after: 0 }),
    );
    if (messages.length >= HISTORY_BATCH) return false;
    // The mirror row above is a snapshot from before these reads; a nudge or a reply sent while they
    // ran is on the history they return, and it means our side spoke after all.
    if (messages.some(weSpoke)) return false;
    const incoming = messages.filter(
      (m) => m.messageType === "incoming" && !m.private,
    );
    if (incoming.length === 0) return false;
    if (incoming.some((m) => m.isReaction || hasAnswerableContent(m)))
      return false;

    const live = parseLiveConversation(
      await client.getConversation(conversationId),
    );
    if (
      !live ||
      !shouldBotHandle(live, { ourAgentBotId: params.ourAgentBotId })
    )
      return false;

    // The supersede re-read, the same one the reply's post gate makes: a message that landed after the
    // history read is answerable work for its own flush, and closing now would bury it (it was created
    // on a PENDING conversation, so Chatwoot does not reopen for it). Asked last, right before the
    // write, so what is left is the same read-to-write gap every close and every post in the runtime
    // has. Closing first and reopening on a late arrival does not work: by then that message's flush
    // may already have settled against a resolved conversation.
    const seen = Math.max(...messages.map((m) => m.id));
    const later = parseChatwootMessages(
      await client.getMessages(conversationId, { after: seen }),
    );
    if (
      later.some(
        (m) => (m.messageType === "incoming" && !m.private) || weSpoke(m),
      )
    )
      return false;
    // The caller's fences, asked after the last read and right before the write: every await above
    // is a wait a /reset, a switched-off agent or the job's deadline can land in.
    if (!(await params.stillWanted())) return false;
    await client.toggleStatus(conversationId, "resolved");
    await recordResolutionOrigin({
      tenantId,
      conversation: {
        chatwootInstanceId: params.instanceId,
        chatwootConversationId: conversationId,
      },
      origin: "nothing_to_answer",
      observed: { status: live.status, statusAt: live.updatedAt },
      base,
    });
    emitFlowEvent(params.flow, {
      stage: params.stage,
      level: "info",
      status: "ok",
      detail: { outcome: "resolved", reason: "nothingAnswerable" },
    });
    return true;
  } catch (e) {
    // A close that failed leaves the conversation stuck exactly as the issue found it, so this one IS
    // a warn: it reaches the operator's alert channel instead of a stdout nobody reads.
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      "nothing to answer: could not close (conv=%s): %s",
      String(conversationId),
      msg,
    );
    emitFlowEvent(params.flow, {
      stage: params.stage,
      level: "warn",
      status: "error",
      detail: { outcome: "resolved", reason: "nothingAnswerable" },
      errorMessage: msg,
    });
    return false;
  }
}
