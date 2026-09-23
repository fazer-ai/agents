import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { loadAgentConfig } from "@/graph/prepare";
import { resetLandedAfter } from "@/graph/reset-episode";
import { parseDbId } from "@/lib/db-id";
import {
  runScoped,
  runScopedOn,
  type ScopedDb,
  type TenantContext,
} from "@/lib/tenancy";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { attachSignature, signatureFor } from "@/modules/signature/service";
import { type LoadChatwootClientDeps, loadChatwootClient } from "./instance";
import { chatwootMessageListLength, parseChatwootMessages } from "./messages";
import { parseLiveConversation, shouldBotHandle } from "./normalize";
import type { NormalizedChatwootEvent } from "./types";

// A REPLY THE CHANNEL REFUSED AFTER CHATWOOT ACCEPTED IT (issue #587).
//
// The channel takes the send and returns an id; the failure arrives minutes later, through the
// channel's own status webhook, and Chatwoot records it as `external_error` on the message and
// re-dispatches `message_updated` to the Agent Bot. Until this module nothing read it: the turn had
// closed, the customer's side had nothing, and the flow log said the reply went out.
//
// What can be done depends on WHICH failure it is, and that is the whole design:
//
//   media      the channel could not obtain or accept the attachment. The same reply as TEXT gets
//              through, so it is sent, once. The text is the reply the audio was rendered from,
//              which the voice note carries as `transcribed_text` on its attachment: nothing is
//              regenerated, and no model runs.
//   delivery   the message could not reach the recipient at all (outside the service window,
//              undeliverable). A text send hits the same wall and leaves a second failed bubble, so
//              nothing is sent.
//   unknown    a code not in the table, or no code at all. Treated as not answerable and LOGGED with
//              the code, so the table grows from evidence rather than from a guess.
//
// Only the route's OWN bot's messages are acted on: a human agent's attachment that failed is the
// human's to resend, and another bot's is that bot's.

const MEDIA_ERROR_CODES = new Set(["131052", "131053"]);

export type ChannelFailureClass = "media" | "delivery" | "unknown";

export interface ChannelFailure {
  messageId: number;
  conversationId: number;
  // The leading number of `external_error` ("131053: Media upload error" → "131053"), or null when
  // there is none to read.
  code: string | null;
  kind: ChannelFailureClass;
  // The reply as text, when the message carries it. Only meaningful for `media`.
  text: string | null;
}

// The codes whose failure is known NOT to be answerable by resending as text. Named so the log can
// tell "a known wall" from "a code nobody has classified yet", which is what widening the media table
// is decided on.
const DELIVERY_ERROR_CODES = new Set(["131026", "131047"]);

function classify(code: string | null): ChannelFailureClass {
  if (code !== null && MEDIA_ERROR_CODES.has(code)) return "media";
  if (code !== null && DELIVERY_ERROR_CODES.has(code)) return "delivery";
  return "unknown";
}

// Whether this event is a channel failure on a message THIS route's bot sent, and what it is. Null for
// everything else, which is every event but a rare few.
export function channelFailureOf(
  n: NormalizedChatwootEvent,
  routeAgentBotId: number | null,
): ChannelFailure | null {
  const m = n.message;
  if (n.event !== "message_updated" || !m) return null;
  if (m.messageType !== "outgoing" || m.private) return null;
  if (!m.externalError) return null;
  if (routeAgentBotId === null) return null;
  if (m.sender?.type !== "agent_bot" || m.sender.id !== routeAgentBotId)
    return null;
  if (m.id === null || n.conversationId === null) return null;
  const code = m.externalError.match(/^\s*(\d+)\b/)?.[1] ?? null;
  const text =
    m.attachments
      ?.map((a) => a.transcribedText?.trim() ?? "")
      .find((t) => t.length > 0) ?? null;
  return {
    messageId: m.id,
    conversationId: n.conversationId,
    code,
    kind: classify(code),
    text,
  };
}

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

async function agentBehindBot(
  tenantId: bigint,
  instanceId: bigint,
  chatwootAgentBotId: number,
  base?: PrismaClient,
): Promise<bigint | null> {
  const find = (db: ScopedDb) =>
    db.chatwootAgentBot.findFirst({
      where: { chatwootInstanceId: instanceId, chatwootAgentBotId },
      select: { agentId: true },
    });
  const bot = base
    ? await runScopedOn(base, sysCtx(tenantId), find)
    : await runScoped(sysCtx(tenantId), find);
  return bot?.agentId ?? null;
}

// How far back a rerun looks for its own earlier send. A page is ~20 messages, so this is a
// conversation that moved on by about a hundred messages since the voice note failed.
const FALLBACK_READBACK_MAX_PAGES = 5;

export function mediaFallbackDedupeKey(messageId: number): string {
  return `msg:${messageId}`;
}

// Acts on a failure: arms the text for a media failure that has one, and writes the line in every
// case. The line never carries the channel's sentence nor the reply: the code, the class and what was
// done are the diagnosis, and the sentence can quote the customer's own number.
export async function handleChannelFailure(params: {
  failure: ChannelFailure;
  tenantId: bigint;
  instanceId: bigint;
  agentBotId: number;
  flow: FlowContext;
  base?: PrismaClient;
}): Promise<void> {
  const { failure: f } = params;
  // The line belongs to the AGENT behind the bot that sent the message, so the Logs page filtered by
  // agent shows it: the flow log stores the agent it is handed and infers nothing.
  const flow: FlowContext =
    params.flow.agentId != null
      ? params.flow
      : {
          ...params.flow,
          agentId: await agentBehindBot(
            params.tenantId,
            params.instanceId,
            params.agentBotId,
            params.base,
          ),
        };
  let action: "text_fallback" | "no_text" | "none" = "none";
  if (f.kind === "media") {
    if (f.text === null) {
      action = "no_text";
    } else {
      action = "text_fallback";
      await enqueueJob({
        tenantId: params.tenantId,
        kind: "MEDIA_TEXT_FALLBACK",
        // The key names the FAILED MESSAGE, and the arm is `once`: a redelivered webhook, a second
        // bot route and a failure reported twice all land on this row and leave it as it is, so the
        // text goes out one time whatever the channel repeats.
        dedupeKey: mediaFallbackDedupeKey(f.messageId),
        rearm: "once",
        runAt: new Date(),
        // The reply in its own column, never in the Json payload: it is text the customer will read,
        // and it can carry their data.
        payloadSecret: encryptJson(f.text),
        payload: {
          instanceId: String(params.instanceId),
          conversationId: f.conversationId,
          messageId: f.messageId,
          agentBotId: params.agentBotId,
        },
        ...(params.base ? { base: params.base } : {}),
      });
    }
  }
  emitFlowEvent(flow, {
    stage: "channel_error",
    level: "warn",
    status: "error",
    detail: {
      messageId: f.messageId,
      code: f.code,
      codeRead: f.code !== null,
      class: f.kind,
      action,
    },
  });
}

export async function mediaFallbackHandler(
  job: ClaimedJob,
  base: PrismaClient,
  // Test seam, as the ingestion job takes one; optional, so this stays assignable to `JobHandler`.
  makeClient?: LoadChatwootClientDeps["makeClient"],
): Promise<JobResult> {
  const p = job.payload as Record<string, unknown>;
  const instanceId =
    typeof p.instanceId === "string" ? parseDbId(p.instanceId) : null;
  const conversationId =
    typeof p.conversationId === "number" ? p.conversationId : null;
  const agentBotId = typeof p.agentBotId === "number" ? p.agentBotId : null;
  const messageId = typeof p.messageId === "number" ? p.messageId : null;
  if (
    instanceId === null ||
    conversationId === null ||
    agentBotId === null ||
    messageId === null
  )
    return { outcome: "done" };
  // THROWS on a missing or unreadable body, like the ingestion job: a real failure retries and then
  // dead-letters visibly, instead of sending nothing and calling it done.
  if (job.payloadSecret == null)
    throw new Error("media fallback: the job carries no text");
  const text = decryptJson<string>(job.payloadSecret);
  // STILL ALLOWED TO SPEAK HERE, asked again at send time: the job can sit queued while the operator
  // switches the agent off, flips it to monitoring, disconnects the account or `/reset`s the
  // conversation, and the bot's stored token outlives all four. The bot is found by the id the
  // conversation knows it by, so the text goes out under the same identity the audio did.
  const bot = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
    db.chatwootAgentBot.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        chatwootAgentBotId: agentBotId,
      },
      select: {
        accessToken: true,
        agentId: true,
        instance: { select: { disconnectedAt: true } },
      },
    }),
  );
  const conv = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
    db.conversation.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
      },
      select: { threadId: true, lastInboundAt: true, resetAtMessageId: true },
    }),
  );
  const stop = (why: string): JobResult => {
    logger.warn(
      "media fallback: %s (conv=%s msg=%s), the text is not sent",
      why,
      String(conversationId),
      String(messageId),
    );
    return { outcome: "done" };
  };
  if (!bot || bot.instance.disconnectedAt !== null)
    return stop("the bot is gone or the account is disconnected");
  if (!conv) return stop("the conversation is not mirrored here");
  // The reply belongs to the episode a `/reset` closed.
  if (resetLandedAfter(messageId, conv.resetAtMessageId))
    return stop("the conversation was reset after the failed reply");
  // The seam every sender loads first (`loadAgentConfig`): it refuses a switched-off agent and a
  // monitoring one, and it carries the signature, which the voice note's transcription never has.
  const cfg = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
    loadAgentConfig(
      db,
      {
        tenantId: job.tenantId,
        instanceId,
        conversationId,
        agentId: bot.agentId,
        threadId: conv.threadId,
        lastIncomingAt: conv.lastInboundAt,
      },
      { skipExperiment: true },
    ),
  );
  if (!cfg) return stop("the agent is off, monitoring or unloadable");
  // SIGNED, as the text path signs a reply: the audio is exempt from the signature, its text
  // replacement is not (docs/signature.md).
  const sig = signatureFor(cfg.signatureConfig, cfg.promptVars, cfg.promptOpts);
  const [signed = text] = sig
    ? attachSignature([text], sig, cfg.signatureConfig)
    : [text];
  const client = await loadChatwootClient(job.tenantId, instanceId, {
    base,
    botToken: decryptJson<string>(bot.accessToken),
    ...(makeClient ? { makeClient } : {}),
  });
  // WHO OWNS IT NOW, read live. The audio went out under the bot, but minutes can pass between that
  // send and this one, and a person may have taken the conversation in between: posting as the bot
  // over them is the one thing no send path here does. An unreadable conversation THROWS, so the job
  // retries instead of guessing either way.
  const live = parseLiveConversation(
    await client.getConversation(conversationId),
  );
  if (!live)
    throw new Error("media fallback: the conversation could not be read");
  // With THIS bot's id: a conversation handed to another bot is not ours either.
  if (!shouldBotHandle(live, { ourAgentBotId: agentBotId })) {
    logger.info(
      "media fallback: conversation %s is no longer the bot's, the text is not sent",
      String(conversationId),
    );
    return { outcome: "done" };
  }
  // THE SEND CARRIES A NAME, and a retry looks for it before sending again. The row is armed once,
  // but the HANDLER can run twice: a POST that landed and whose response was lost, or a crash between
  // the send and `completeJob`, both come back here, and the second one only after the stale-claim
  // interval, when newer messages may have pushed the first send off the latest page. So the read
  // pages back to the FAILED message, which the text can only have followed. A read that fails
  // THROWS, for the same reason as above; a conversation too busy to reach that boundary within the
  // page ceiling sends nothing, because a text that late is worth less than a duplicate costs.
  const sendId = `media-fallback:${messageId}`;
  let before: number | undefined;
  for (let page = 0; ; page++) {
    if (page === FALLBACK_READBACK_MAX_PAGES) {
      logger.warn(
        "media fallback: could not reach message %s in conversation %s, the text is not sent",
        String(messageId),
        String(conversationId),
      );
      return { outcome: "done" };
    }
    const raw = await client.getMessages(
      conversationId,
      before === undefined ? undefined : { before },
    );
    const rows = parseChatwootMessages(raw);
    // A page read INCOMPLETELY (not a list, or rows that did not parse) cannot say the send is not
    // there, only that it could not tell: THROW and retry, never resend on it.
    if (chatwootMessageListLength(raw) !== rows.length)
      throw new Error(
        "media fallback: a page of the conversation did not read",
      );
    if (rows.some((m) => m.sendId === sendId)) return { outcome: "done" };
    const oldest = rows[0]?.id;
    if (oldest === undefined || oldest <= messageId) break;
    before = oldest;
  }
  await client.sendMessage(conversationId, signed, { sendId });
  return { outcome: "done" };
}

let registered = false;
export function registerMediaFallbackJob(): void {
  if (registered) return;
  registered = true;
  registerJobHandler("MEDIA_TEXT_FALLBACK", mediaFallbackHandler);
}

registerMediaFallbackJob();
