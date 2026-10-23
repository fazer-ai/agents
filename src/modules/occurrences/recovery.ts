import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { recordUnmeteredCall } from "@/graph/usage";
import { runScopedOn } from "@/lib/tenancy";
import {
  mediaAnnotationFor,
  overlayMediaAnnotations,
} from "@/modules/chatwoot/annotations";
import type { LoadChatwootClientDeps } from "@/modules/chatwoot/instance";
import type { ChatwootMessageRow } from "@/modules/chatwoot/messages";
import { usableRow } from "@/modules/chatwoot/transcript";
import {
  mediaRefusedThrough,
  refusedCovers,
  watcherMediaRefusedThrough,
} from "@/modules/contact-auth/media-refusal";
import { readContactAuthConfig } from "@/modules/contact-auth/settings";
import type { FlowContext } from "@/modules/flowlog/service";
import { spendCeilingVerdict } from "@/modules/spend-ceiling/service";
import { getSttProvider } from "@/modules/stt/providers";
import { transcribeInboundAudio } from "@/modules/stt/service";
import { readSttConfig } from "@/modules/stt/settings";
import { extractMessageVisuals } from "@/modules/vision/extract-message";
import { readVisionConfig } from "@/modules/vision/settings";
import { sysCtx } from "./config";
import type { MediaState } from "./media";

// RECOVERING WHAT UPSTREAM CHATWOOT FORGOT (docs/occurrences.md, "Voice notes and images on upstream
// Chatwoot"). There a voice note's words and an image's description live only in this process's
// memory, for 15 minutes, and a round can come later. With `recoverMedia` on, the reading transcribes
// and describes again what the conversation's new messages are missing, with the speech-to-text and
// vision of the agent that receives the inbox, billed to the monitor on its own lines and never to the
// agent. Only messages the conversation's last reading did not cover are recovered, so each one is
// paid for once: an older one was read before, with or without its content, and stays as it was.

// The newest messages of a conversation recovered in one reading; the rest keep the renderer's marker.
export const RECOVERY_MAX_MESSAGES = 5;
// The share of the reading's remaining time the recovery may take: the rest is the reading's own,
// so a slow provider cannot leave the conversation pending and the recovery paid for again.
export const RECOVERY_TIME_SHARE = 0.5;

export interface RecoveryDeps {
  makeChatwootClient?: LoadChatwootClientDeps["makeClient"];
  transcribe?: typeof transcribeInboundAudio;
  sttFetch?: typeof fetch;
  visionFetch?: typeof fetch;
}

export interface RecoveryTarget {
  tenantId: bigint;
  conversationId: bigint;
  inboxId: bigint | null;
  chatwootInstanceId: bigint;
  chatwootConversationId: number;
  // The customer message the last reading covered: newer ones are this reading's to recover.
  readInboundAt: Date | null;
  readInboundMessageId: number | null;
}

// The agent whose speech-to-text and vision the inbox's media is read with: the one bound to it, else
// the first that observes it. Null when none does, or it is switched off.
async function inboxAgent(
  base: PrismaClient,
  tenantId: bigint,
  inboxId: bigint,
): Promise<{ id: bigint; settings: unknown } | null> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: { id: inboxId },
      select: {
        agentId: true,
        observers: {
          select: { agentId: true },
          orderBy: { id: "asc" },
          take: 1,
        },
      },
    });
    const agentId = inbox?.agentId ?? inbox?.observers[0]?.agentId ?? null;
    if (agentId === null) return null;
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { enabled: true, settings: true },
    });
    return agent?.enabled ? { id: agentId, settings: agent.settings } : null;
  });
}

// Whether this reading recovers the message: the customer's, incomplete, and newer than what the
// conversation's last reading covered (by id where the mirror knows it, else by time).
function newSinceLastReading(
  row: ChatwootMessageRow,
  t: RecoveryTarget,
): boolean {
  if (t.readInboundMessageId !== null) return row.id > t.readInboundMessageId;
  if (t.readInboundAt === null) return true;
  return row.createdAt != null && row.createdAt > t.readInboundAt;
}

// Fills the rows in place with what was recovered. Best-effort: a call that fails, or that the spend
// ceiling, the round's time or a media refusal stops, leaves the message with the renderer's marker.
export async function recoverReadingMedia(args: {
  base: PrismaClient;
  target: RecoveryTarget;
  rows: ChatwootMessageRow[];
  states: MediaState[];
  threadId: string | null;
  signal: AbortSignal;
  // How many messages the transcript renders: only those are recovered.
  windowSize: number;
  // Whether the message's line, whole or cut, still reaches the reading within the transcript's
  // character budget, with what was recovered so far.
  fits: (messageId: number) => boolean;
  deps?: RecoveryDeps;
}): Promise<void> {
  const { base, target: t, rows, states } = args;
  if (t.inboxId === null) return;
  // By id: the window's pages come newest first, so the rows are not in order across pages.
  const rendered = rows
    .filter(usableRow)
    .sort((a, b) => a.id - b.id)
    .slice(-args.windowSize);
  const read = new Set(rendered.map((r) => r.id));
  const due = rows
    .filter(
      (r, k) =>
        states[k] === "incomplete" &&
        read.has(r.id) &&
        newSinceLastReading(r, t),
    )
    .sort((a, b) => b.id - a.id)
    .slice(0, RECOVERY_MAX_MESSAGES);
  if (due.length === 0) return;
  const agent = await inboxAgent(base, t.tenantId, t.inboxId);
  if (agent === null) return;
  // An agent with a contact authorization gate lends nothing: the reading cannot ask that gate, and
  // no refusal on record is not consent (a message from before the binding was never asked about).
  if (readContactAuthConfig(agent.settings).enabled) return;
  const stt = readSttConfig(agent.settings);
  const vision = readVisionConfig(agent.settings);
  const sttModel =
    stt.model || getSttProvider(stt.provider)?.defaultModel || stt.provider;
  const flow: FlowContext = {
    tenantId: t.tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    conversationId: t.conversationId,
    agentId: null,
    inboxId: t.inboxId,
    threadId: args.threadId,
    base,
  };
  // Asked before every paid call: the account's ceiling, the round's time, and the contact
  // authorization's refusal marks (docs/contact-auth.md, "Media waits for the gate"): the
  // conversation's, and the one this agent left as a watcher.
  const allowed = async (messageId: number): Promise<boolean> => {
    if (args.signal.aborted) return false;
    const ceiling = await spendCeilingVerdict({
      tenantId: t.tenantId,
      source: "inbox",
      base,
    });
    if (ceiling.state === "over") return false;
    const refused = await mediaRefusedThrough(
      t.tenantId,
      t.conversationId,
      base,
    ).catch(() => Number.POSITIVE_INFINITY);
    const watched = watcherMediaRefusedThrough(
      t.tenantId,
      t.conversationId,
      agent.id,
    );
    return (
      !refusedCovers(refused, messageId) && !refusedCovers(watched, messageId)
    );
  };
  // Newest first: once a message no longer fits the budget, no older one does.
  for (const row of due) {
    if (args.signal.aborted || !args.fits(row.id)) return;
    // What another pass finished since the reading overlaid the rows (while this one asked its
    // fences, or transcribed) is taken from memory, here and before the files, not paid for again
    // or left out.
    overlayMediaAnnotations(t.tenantId, t.chatwootInstanceId, [row]);
    const label = `${t.conversationId}/${row.id}`;
    const audio = row.audio;
    if (
      stt.enabled &&
      audio &&
      !row.transcribedText &&
      !mediaAnnotationFor(t.tenantId, t.chatwootInstanceId, row.id)
        ?.transcriptionEmpty &&
      (await allowed(row.id))
    ) {
      const startedAt = performance.now();
      // Billed when this call reached the provider: a transcription another pass finished, or one
      // it was running and this call waited for, was paid for there.
      let called = false;
      const sttFetch = args.deps?.sttFetch ?? fetch;
      const counted = ((...a: Parameters<typeof fetch>) => {
        called = true;
        return sttFetch(...a);
      }) as typeof fetch;
      let text: string | null = null;
      try {
        text = await (args.deps?.transcribe ?? transcribeInboundAudio)({
          tenantId: t.tenantId,
          instanceId: t.chatwootInstanceId,
          conversationId: t.chatwootConversationId,
          messageId: row.id,
          attachmentId: audio.id,
          dataUrl: audio.dataUrl,
          cfg: stt,
          base,
          flow,
          signal: args.signal,
          deps: {
            makeClient: args.deps?.makeChatwootClient,
            fetchImpl: counted,
          },
        });
      } catch (err) {
        logger.warn(
          { tenantId: String(t.tenantId), err },
          `occurrence reading: the voice note ${label} could not be transcribed again`,
        );
      }
      // Also after a throw: the words reach memory before the write-back, and a reading cut short
      // during that write still paid for the call and still reads them.
      text ??=
        mediaAnnotationFor(t.tenantId, t.chatwootInstanceId, row.id)
          ?.transcribedText ?? null;
      if (called)
        await recordUnmeteredCall(flow, {
          model: sttModel,
          node: "occurrence_transcription",
          durationMs: performance.now() - startedAt,
        });
      if (text) row.transcribedText = text;
    }
    overlayMediaAnnotations(t.tenantId, t.chatwootInstanceId, [row]);
    // Unseen unless the arrival pass finished the message here or every file carries its meta: one
    // file's meta written back fills the row's fields but leaves the others unread.
    const stashed = mediaAnnotationFor(
      t.tenantId,
      t.chatwootInstanceId,
      row.id,
    );
    const unseen =
      row.visuals.length > 0 &&
      !(
        stashed?.imageDescription ||
        stashed?.extractedText ||
        stashed?.attachmentsUnread ||
        stashed?.bodyRead
      ) &&
      !row.visuals.every((v) => Boolean(v.imageDescription || v.extractedText));
    if (vision.enabled && unseen && (await allowed(row.id))) {
      try {
        const read = await extractMessageVisuals({
          tenantId: t.tenantId,
          instanceId: t.chatwootInstanceId,
          conversationId: t.chatwootConversationId,
          messageId: row.id,
          visuals: row.visuals,
          cfg: vision,
          base,
          flow,
          signal: args.signal,
          stillAllowed: () => allowed(row.id),
          usageNode: "occurrence_vision",
          convLabel: label,
          deps: {
            makeClient: args.deps?.makeChatwootClient,
            fetchImpl: args.deps?.visionFetch,
          },
        });
        if (read) {
          if (read.imageDescription)
            row.imageDescription = read.imageDescription;
          if (read.extractedText) row.extractedText = read.extractedText;
          row.attachmentsUnread = read.attachmentsUnread;
          row.unreadFiles = read.unreadFiles;
          if (read.bodyRead) row.bodyRead = true;
        }
      } catch (err) {
        logger.warn(
          { tenantId: String(t.tenantId), err },
          `occurrence reading: the files of ${label} could not be read again`,
        );
      }
    }
  }
}
