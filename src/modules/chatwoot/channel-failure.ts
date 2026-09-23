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
import { isTestSilenced } from "@/modules/agents/test-mode";
import { episodeTestActivatedAt } from "@/modules/channel-redirect/episode";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { proactiveSendMode } from "@/modules/service-window/service";
import { attachSignature, signatureFor } from "@/modules/signature/service";
import { mediaAnnotationFor } from "./annotations";
import { type LoadChatwootClientDeps, loadChatwootClient } from "./instance";
import { chatwootMessageListLength, parseChatwootMessages } from "./messages";
import { parseLiveConversation, shouldBotHandle } from "./normalize";
import { reconcileMirrorFromLive } from "./reconcile";
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
//              which the voice note carries as `transcribed_text` on its attachment, or whole in its
//              `content_attributes` when the speech left a URL or an address out (issue #792):
//              nothing is regenerated, and no model runs.
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
  // The whole reply when the voice note carries it, which is when its speech had a URL or an address
  // taken out (issue #792): the transcription is then the sentence with holes in it, and the text
  // replacing the audio would read broken. The items go again, after the balloon that already
  // carried them: a repeated link costs less than a sentence that stops mid-way.
  const text =
    m.replyText?.trim() ||
    (m.attachments
      ?.map((a) => a.transcribedText?.trim() ?? "")
      .find((t) => t.length > 0) ??
      null);
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

// Per Chatwoot INSTANCE as well as per message: message ids are the server's own, and a tenant that
// replaces its Chatwoot deployment keeps its scheduler rows, so a new server reusing an old id would
// land on the old row and `once` would keep it.
// WhatsApp's own ceiling on a text message. A reply longer than this is refused by the channel AFTER
// Chatwoot accepted the post, which is this issue's own failure again, so it is not sent at all.
const CHANNEL_TEXT_MAX = 4_096;

export function mediaFallbackDedupeKey(
  instanceId: bigint,
  messageId: number,
): string {
  return `msg:${instanceId}:${messageId}`;
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
  // The reply the voice note was rendered from. The fork keeps it on the attachment; an upstream
  // Chatwoot drops that metadata, and then the text this process stashed when it sent the audio is
  // the one place it still is.
  const f: ChannelFailure =
    params.failure.kind === "media" && params.failure.text === null
      ? {
          ...params.failure,
          text:
            mediaAnnotationFor(
              params.tenantId,
              params.instanceId,
              params.failure.messageId,
            )?.transcribedText?.trim() || null,
        }
      : params.failure;
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
        dedupeKey: mediaFallbackDedupeKey(params.instanceId, f.messageId),
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
  // An UNREADABLE body throws (decrypt below), like the ingestion job: a real failure retries and
  // then dead-letters visibly. No body is a `/reset` having forgotten it (a DONE row is never claimed again), so there is
  // nothing to send and nothing to retry.
  if (job.payloadSecret == null) {
    logger.info(
      "media fallback: job %s carries no text (forgotten by a reset), nothing is sent",
      String(job.id),
    );
    return { outcome: "done" };
  }
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
  const client = await loadChatwootClient(job.tenantId, instanceId, {
    base,
    botToken: decryptJson<string>(bot.accessToken),
    ...(makeClient ? { makeClient } : {}),
  });
  // FIRST, because it is the slow part: every gate below is asked AFTER these reads, so a person
  // taking the conversation or a `/reset` landing while they run still stops the send.
  //
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
    // The conversation holds at least the failed voice note, so a FIRST page with nothing on it is
    // a read that did not see the conversation, not an empty one.
    if (page === 0 && rows.length === 0)
      throw new Error("media fallback: the conversation read back empty");
    if (rows.some((m) => m.sendId === sendId)) return { outcome: "done" };
    const oldest = rows[0]?.id;
    if (oldest === undefined || oldest <= messageId) break;
    before = oldest;
  }
  // WHO OWNS IT NOW, read live. The audio went out under the bot, but minutes can pass between that
  // send and this one, and a person may have taken the conversation in between: posting as the bot
  // over them is the one thing no send path here does. An unreadable conversation THROWS, so the job
  // retries instead of guessing either way.
  const live = parseLiveConversation(
    await client.getConversation(conversationId),
  );
  if (!live)
    throw new Error("media fallback: the conversation could not be read");
  // AND THE MIRROR, read through the reconcile: a local status claim (a colleague's reply claimed
  // `open` before Chatwoot's toggle landed) and a takeover webhook committed after this snapshot are
  // both newer than the live read, and the reconcile returns the row as its own ordering left it. A
  // text that nobody is waiting on costs less than one over a person, so BOTH readings have to say
  // the bot owns it. A reconcile that fails THROWS: the claim is what the snapshot cannot show.
  const reconciled = await reconcileMirrorFromLive({
    tenantId: job.tenantId,
    instanceId,
    conversationId,
    live,
    base,
  });
  const ours = (c: {
    status: string | null;
    assigneeType: string | null;
    assigneeId: number | null;
  }) => shouldBotHandle(c, { ourAgentBotId: agentBotId });
  // With THIS bot's id: a conversation handed to another bot is not ours either.
  if (!ours(live) || (reconciled.state !== null && !ours(reconciled.state))) {
    logger.info(
      "media fallback: conversation %s is no longer the bot's, the text is not sent",
      String(conversationId),
    );
    return { outcome: "done" };
  }
  // LAST, and after every network read: the database answers for a `/reset` or a rebinding that
  // landed while Chatwoot was being asked, and nothing but the send follows it.
  //
  // The same reads a follow-up makes before it speaks (../../graph/nudge.ts), in the same order: the
  // conversation, the agent its inbox is bound to NOW, the test-mode activation, and the config.
  const gate = await runScopedOn(base, sysCtx(job.tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: job.tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      select: {
        inboxId: true,
        threadId: true,
        lastInboundAt: true,
        resetAtMessageId: true,
        testActivatedAt: true,
        contactId: true,
      },
    });
    if (!conv?.inboxId) return "the conversation is not mirrored here";
    // The reply belongs to the episode a `/reset` closed.
    if (resetLandedAfter(messageId, conv.resetAtMessageId))
      return "the conversation was reset after the failed reply";
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: {
        agentId: true,
        chatwootInboxId: true,
        channelType: true,
        provider: true,
      },
    });
    // The inbox may have been unbound or handed to another agent while the job waited: the persona
    // that sent the audio no longer answers here.
    if (inbox?.agentId !== bot.agentId)
      return "the inbox is no longer bound to this agent";
    const agent = await db.agent.findUnique({
      where: { id: bot.agentId },
      select: { mode: true, settings: true },
    });
    if (
      agent &&
      isTestSilenced(
        agent.mode,
        await episodeTestActivatedAt({
          tenantId: job.tenantId,
          instanceId,
          cfg: readChannelRedirectConfig(agent.settings),
          agentMode: agent.mode,
          conv: {
            testActivatedAt: conv.testActivatedAt,
            contactId: conv.contactId,
            chatwootInboxId: inbox.chatwootInboxId,
          },
          base,
          scoped: db,
        }),
      )
    )
      return "the agent is in test mode and this conversation was not activated";
    // The seam every sender loads first: it refuses a switched-off agent and a monitoring one, and
    // it carries the signature, which the voice note's transcription never has.
    const cfg = await loadAgentConfig(
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
    );
    if (!cfg) return "the agent is off, monitoring or unloadable";
    // THE 24H WINDOW, the proactive paths' rule: a job that waited out an outage past it would post
    // a free-form message the channel rejects, and finish DONE with nothing delivered. A template is
    // not the reply either, so outside the window the text simply does not go.
    if (
      proactiveSendMode(
        cfg.serviceWindowConfig,
        conv.lastInboundAt,
        new Date(),
        {
          channelType: inbox.channelType,
          provider: inbox.provider,
        },
      ) !== "freeform"
    )
      return "the channel's 24h service window has closed";
    return { cfg, chatwootInboxId: inbox.chatwootInboxId };
  });
  if (typeof gate === "string") return stop(gate);
  const { cfg } = gate;
  // The inbox the binding above was read for is the MIRROR's, and a transfer to another inbox can
  // reach Chatwoot before its webhook reaches the mirror. The live read is the newer word: an inbox
  // that differs is a binding nobody here has read, so nothing goes out under the old persona.
  if (live.inboxId !== null && live.inboxId !== gate.chatwootInboxId)
    return stop("the conversation moved to another inbox");

  // SIGNED, as the text path signs a reply: the audio is exempt from the signature, its text
  // replacement is not (docs/signature.md).
  const sig = signatureFor(cfg.signatureConfig, cfg.promptVars, cfg.promptOpts);
  const [signed = text] = sig
    ? attachSignature([text], sig, cfg.signatureConfig)
    : [text];
  // ONE message, like every single-message send here (the follow-up, the handoff's farewell): the
  // signature rule is applied to it as to any of those. A reply over the channel's ceiling is not
  // sent: the channel would refuse it after Chatwoot took it, and a voice note that long (minutes of
  // audio) is not a shape this path is for.
  if (Array.from(signed).length > CHANNEL_TEXT_MAX)
    return stop("the reply is longer than the channel takes in one message");
  await client.sendMessage(conversationId, signed, { sendId });
  return { outcome: "done" };
}

// WHAT A `/reset` DOES TO THIS CONVERSATION'S FALLBACKS. A pending one is retired (its reply
// belongs to the episode the command closed, and the job's own reset fence would stop it anyway), and
// every one of them, DEAD included, loses the body while keeping its row: the key is the dedupe a
// redelivered failure lands on, the body is a customer's words that the reset promised to forget.
// A CLAIMED one loses its body too: its handler already holds the text and reads the reset before it
// sends, and a claim that later dies must not keep the words the reset promised to forget. A run that
// comes back to a row with no body finds nothing to send and finishes.
export async function forgetMediaFallbacks(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  base?: PrismaClient;
}): Promise<void> {
  const run = (db: ScopedDb) =>
    db.schedulerJob.updateMany({
      where: {
        kind: "MEDIA_TEXT_FALLBACK",
        AND: [
          {
            payload: {
              path: ["instanceId"],
              equals: String(params.instanceId),
            },
          },
          {
            payload: {
              path: ["conversationId"],
              equals: params.conversationId,
            },
          },
        ],
      },
      data: { payloadSecret: null },
    });
  const retire = (db: ScopedDb) =>
    db.schedulerJob.updateMany({
      where: {
        kind: "MEDIA_TEXT_FALLBACK",
        status: "PENDING",
        AND: [
          {
            payload: {
              path: ["instanceId"],
              equals: String(params.instanceId),
            },
          },
          {
            payload: {
              path: ["conversationId"],
              equals: params.conversationId,
            },
          },
        ],
      },
      data: { status: "DONE" },
    });
  const both = async (db: ScopedDb) => {
    await retire(db);
    await run(db);
  };
  if (params.base)
    await runScopedOn(params.base, sysCtx(params.tenantId), both);
  else await runScoped(sysCtx(params.tenantId), both);
}

let registered = false;
export function registerMediaFallbackJob(): void {
  if (registered) return;
  registered = true;
  registerJobHandler("MEDIA_TEXT_FALLBACK", mediaFallbackHandler);
}

registerMediaFallbackJob();
