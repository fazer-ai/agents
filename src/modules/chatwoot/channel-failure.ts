import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson, encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { parseDbId } from "@/lib/db-id";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { type LoadChatwootClientDeps, loadChatwootClient } from "./instance";
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
  emitFlowEvent(params.flow, {
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
  if (instanceId === null || conversationId === null || agentBotId === null)
    return { outcome: "done" };
  // THROWS on a missing or unreadable body, like the ingestion job: a real failure retries and then
  // dead-letters visibly, instead of sending nothing and calling it done.
  if (job.payloadSecret == null)
    throw new Error("media fallback: the job carries no text");
  const text = decryptJson<string>(job.payloadSecret);
  // The bot the failed message came from, by the id the conversation knows it by, so the text goes
  // out under the same identity the audio did.
  const bot = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
    db.chatwootAgentBot.findFirst({
      where: {
        chatwootInstanceId: instanceId,
        chatwootAgentBotId: agentBotId,
      },
      select: { accessToken: true },
    }),
  );
  if (!bot) {
    logger.warn(
      "media fallback: the bot %s is gone from instance %s, the text is not sent",
      String(agentBotId),
      String(instanceId),
    );
    return { outcome: "done" };
  }
  const client = await loadChatwootClient(job.tenantId, instanceId, {
    base,
    botToken: decryptJson<string>(bot.accessToken),
    ...(makeClient ? { makeClient } : {}),
  });
  await client.sendMessage(conversationId, text);
  return { outcome: "done" };
}

let registered = false;
export function registerMediaFallbackJob(): void {
  if (registered) return;
  registered = true;
  registerJobHandler("MEDIA_TEXT_FALLBACK", mediaFallbackHandler);
}

registerMediaFallbackJob();
