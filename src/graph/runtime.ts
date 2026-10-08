import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import {
  mayCloseConversation,
  postedOutcomeFor,
  silenceIsUnexplained,
} from "@/graph/close-intent";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { agentStillSpeaks } from "@/modules/agents/speaks";
import {
  overlayMediaAnnotations,
  stashMediaAnnotation,
} from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  describeClosedGate,
  type GateCloseDetail,
} from "@/modules/chatwoot/gate-close";
import { conversationOwnershipNow } from "@/modules/chatwoot/human-takeover";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import { literalForChatwoot } from "@/modules/chatwoot/liquid";
import {
  buildQuoteResolver,
  parseChatwootMessages,
  pendingIncoming,
} from "@/modules/chatwoot/messages";
import {
  awaitsTranscription,
  firstAudioAttachment,
  incomingRenderable,
  isIncomingMessage,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { recordSends } from "@/modules/chatwoot/record-sends";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import type { AuthContext } from "@/modules/contact-auth/check";
import { withAuthContextSection } from "@/modules/contact-auth/context";
import { recordConversationError } from "@/modules/conversations/error";
import { armNothingToAnswer } from "@/modules/conversations/nothing-to-answer";
import {
  type ObservedConversation,
  observeBeforeClose,
  recordResolutionOrigin,
} from "@/modules/conversations/record-resolution";
import {
  advanceHandledWatermark,
  claimReplyBurst,
  foreignReplyBoundary,
  readSelectionState,
  selectOpenMessages,
} from "@/modules/debounce/watermark";
import { emitCapacityWait } from "@/modules/flowlog/capacity";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { ourSideHasSpoken } from "@/modules/followups/eligibility";
import {
  buildGuardrailGate,
  chatwootNoteSink,
  guardrailTripped,
  screenedByOperator,
  screenedText,
} from "@/modules/guardrails/gate";
import {
  applyGuardrailHandoff,
  GuardrailHandoffFailedError,
} from "@/modules/guardrails/handoff";
import type { ImageFetchDeps } from "@/modules/images/fetch";
import { armCompaction } from "@/modules/memory/compact";
import { signatureFor } from "@/modules/signature/service";
import { deliverReply, type ReplyDelivery } from "@/modules/split/service";
import type { TtsCheckConfig } from "@/modules/tts/check";
import { plannedReplyIsAudio, spokenNoticeFor } from "@/modules/tts/modality";
import { synthesizeReply } from "@/modules/tts/service";
import { shouldReplyWithAudio } from "@/modules/tts/settings";
import { logTextInsteadOfAudio, planAudioReply } from "@/modules/tts/speakable";
import {
  attendanceHasStarted,
  claimAttendanceBoundary,
  needsAttendanceStartProbe,
} from "./attendance-boundary";
import {
  chatwootThreadId,
  getCheckpointer,
  resolveGraphThreadId,
} from "./checkpointer";
import {
  lastAssistantText,
  recursionLimitFor,
  replyWrittenThisTurn,
  type SilenceRetryOutcome,
} from "./graph";
import { owesHandbackNote } from "./handback";
import { clearTurnInFlight, markTurnInFlight } from "./inflight";
import { drainPendingIngest } from "./ingest-drain";
import {
  burstStartStamp,
  conversationDividerMessage,
  conversationStamp,
  humanHandbackMessage,
  sentAtStamp,
  turnWasCalledOff,
} from "./markers";
import type { ResolvedModelConfig } from "./models";
import { withOwnershipFence } from "./ownership-fence";
import {
  type AgentConfig,
  buildCallbacks,
  buildModelAndGraph,
  buildSpeechNormalizer,
  buildToolset,
  loadAgentConfig,
} from "./prepare";
import { undoRefusedTurn } from "./refused-turn";
import { burstReopenedResolved } from "./reopened-by-burst";
import { stillInSameEpisode } from "./reset-episode";
import {
  applyResolveLabels,
  type ResolveLabelsResult,
  resolveLabelsFor,
} from "./resolve-labels";
import {
  chosenSilence,
  customerFacingReply,
  silenceWasChosen,
} from "./silence";
import { applySkipHandover, skipHandoverKind } from "./skip-handover";
import { AgentStatusReporter } from "./status";
import {
  clearTurnOwning,
  markTurnOwning,
  type ThreadOwner,
  type TurnHold,
  turnWaitDeadline,
  WAIT_AGAIN,
  waitForTurnToClear,
} from "./thread-claim";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";
import { ToolFlowLogger } from "./tool-flowlog";
import type { McpLoadDeps } from "./tools/mcp";
import {
  buildNativeTools,
  type HandoffTurnState,
  handoffAnsweredTheTurn,
  handoffDeclaredSilence,
  ownerChangedByTurn,
  ownTransfer,
  type TurnState,
  turnDeliveredToCustomer,
  turnReachedTheCustomer,
} from "./tools/native";
import type { ReplyChoice } from "./tools/reply-as-text";
import type { UsagePersist } from "./usage";

// The agent runtime: resolve the inbox's agent config, build the model, run the LangGraph thread,
// re-check the live owner, post the reply via the bot token. Network I/O stays outside every
// transaction; scoped reads are short and DB-only. `runLoadedTurn` is the tail shared by the direct
// webhook path and the debounce flush, whose `shouldPost` hook can suppress the reply at the last
// moment so the re-armed flush answers the whole burst once. See docs/graph.md, "Pieces".

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// What the post gate saw, not what the turn did: its two refusals have opposite bookkeeping (more
// is coming vs. it is over), so a boolean would make each caller rebuild the difference.
// `postBlocked` translates the fact into an outcome; outcome words here would also make the
// `refused-turn-callsites` guard read these returns as refusals escaping `refuse()`.
export type PostVerdict =
  | "post"
  // A newer message arrived mid-turn: becomes `superseded`, and its flush answers the whole burst.
  | "newer-message"
  // A person answered this burst and nothing follows: becomes the terminal `answered-elsewhere`.
  | "answered-by-other";

export type RunAgentTurnOutcome =
  | "posted"
  // Part of the turn reached the customer and the rest is not coming. Read like "posted" (burst
  // consumed, watermark advanced, ledger settled: a re-run would send that part twice), except it
  // must not clear the operator's error badge, hence its own word. Produced by `postedOutcomeFor`.
  | "posted-partial"
  | "skipped"
  // No agent is bound to this inbox (the mirror creates a row for any inbox with traffic); the
  // caller reports it. Its sibling below is a binding that exists and cannot answer.
  | "no-agent"
  // Bound, but the config would not load (agent switched off, or its row gone), or the agent was
  // switched off or set to monitoring while the turn ran (`agentStillSpeaks` at the send fence).
  // Not "stale", whose bookkeeping is /reset's (burst left unmarked): this one asks the caller to
  // read the agent again and, for an observer, fold the burst into memory and mark it handled.
  | "agent-unavailable"
  | "empty"
  | "taken-over"
  // The run was called off while it worked (/reset retired its job, or `agentStillSpeaks` said no
  // at a send fence). Unlike "superseded", which a newer message re-answers, the burst was withdrawn
  // with the thread: one bit for both would have a caller re-arm work the operator cancelled.
  | "stale"
  // The thread was already held when this turn took the claim and the caller asked to stand down
  // (`standDownIfThreadHeld`). Nothing was written and the claim is released; the burst is still
  // owed. A read cannot tell two simultaneous starts apart: only the acquiring statement in
  // ./thread-claim.ts sees the other one, and reports it as `heldBefore`.
  | "thread-busy"
  // A person took the conversation over while this turn waited for the thread, so it stopped
  // before the invoke with nothing written, and the customer message is still owed. Unlike
  // `taken-over` (invoke ran, message in the channel, only the send suppressed), the message is in
  // no memory yet: so this word stays out of the watermark advance, and the receiver treats it like
  // the observer (no settlement at the gate, ingestion takes the message, then the row closes).
  | "taken-over-unread"
  | "superseded"
  // Someone other than us answered the burst. Shaped like `superseded` (nothing posted, turn
  // undone) with the opposite bookkeeping: nobody comes after, so leaving the ledger `PROCESSING`
  // would make it eligible for recovery, which replays the turn on an answered conversation
  // (`recover-delivery.ts` only refuses a replay before a newer CUSTOMER message). So it stays out of
  // `coalesceAndRunTurn`'s exclusion list: it advances the mark and settles as `consumed`, never
  // `answered`.
  | "answered-elsewhere"
  | "blocked";

export interface RuntimeDeps {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  makeClient?: (
    cfg: ConstructorParameters<typeof ChatwootClient>[0],
  ) => Promise<ChatwootClient>;
  checkpointer?: BaseCheckpointSaver;
  persistUsage?: UsagePersist;
  mcp?: McpLoadDeps;
  // Injectable fetch for the TTS provider (tests); real fetch in production.
  ttsFetch?: typeof fetch;
  // The corrupted-audio check (tests): its settings in place of `config.ttsCheck`, and its own fetch
  // so the detector is faked apart from the TTS provider.
  ttsCheck?: TtsCheckConfig;
  ttsCheckFetch?: typeof fetch;
  // Injectable fetch for the contact-authorization check (tests); real fetch in production.
  contactAuthFetch?: typeof fetch;
  // Injectable fetch for the vision provider (tests); real fetch in production.
  visionFetch?: typeof fetch;
  // Injectable fetch for the STT provider (tests); real fetch in production.
  sttFetch?: typeof fetch;
  // How long a debounce flush waits for a voice note of its burst whose transcription is still in
  // flight (tests shorten it); `FLUSH_TRANSCRIPTION_WAIT_MS` otherwise.
  transcriptionWaitMs?: number;
  // Injectable download + SSRF assertion for send_image (tests); the real ones in production.
  imageDeps?: ImageFetchDeps;
  // Injectable for tests: where a document tool writes and reads its rendered PDF.
  documentsStorageDir?: string;
  // Injectable LLM speech normalizer (tests); production builds one from the agent's model when the
  // agent enables tts.normalize. Best-effort: synthesizeReply falls back to raw text on failure.
  normalizeSpeech?: (text: string) => Promise<string>;
  // Injectable sleep for the split/typing pacing (tests pass a no-op); real setTimeout otherwise.
  sleep?: (ms: number) => Promise<void>;
  // Injectable clock (tests); `new Date()` otherwise. The proactive path reads it only for the 24h
  // service window, which tests assert on both sides of a model call: real time cannot cross that
  // boundary reliably.
  now?: () => Date;
  // The ceiling on waiting for the thread, read by the nudge. Injectable because past it the
  // proactive turn proceeds beside the reader, minutes away on the wall clock. Production uses
  // `turnWaitDeadline`.
  turnWaitDeadline?: () => number;
  // The ownership read after the thread wait, injectable because the case it covers is its own
  // failure. Production uses `conversationOwnershipNow`, the webhook's reader.
  ownershipRead?: (p: {
    tenantId: bigint;
    instanceId: bigint;
    conversationId: number;
    ourAgentBotId: number | null;
    base: PrismaClient;
  }) => Promise<
    // `closed` rides with `false` because the caller writes the `handoff` line from it; a
    // second read would describe another moment (the rule `describeClosedGate` states).
    { ours: true } | { ours: false; closed: GateCloseDetail | null }
  >;
}

// The error badge for a delivery that ended incomplete, written wherever the turn returns
// "posted-partial". The callers cannot write it: they read the outcome as an answer and
// clear the badge. The cause stays in the flow log (`stage: "split"`); best-effort like
// `recordConversationError`, so a delivered half-answer never becomes a thrown turn.
async function notePartialDelivery(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  base: PrismaClient;
  // Whether the loss is a fact or a doubt: after a send timeout the message may already be in the
  // conversation, and "part did not arrive" would have the operator post a duplicate by hand.
  unproven?: boolean;
}): Promise<void> {
  await recordConversationError({
    tenantId: params.tenantId,
    instanceId: params.instanceId,
    chatwootConversationId: params.conversationId,
    error: new Error(
      params.unproven
        ? "não foi possível confirmar a entrega: o envio foi rejeitado e o Chatwoot não respondeu à releitura, então parte da resposta pode ou não ter chegado ao cliente. Confira a conversa antes de reenviar."
        : "a entrega ficou incompleta: parte do que o turno prometeu não chegou ao cliente, e não será reenviada",
    ),
    base: params.base,
  });
}

export interface RunLoadedTurnParams {
  loaded: AgentConfig;
  // The signal of the scheduler job this turn runs for. When the job's deadline ends it,
  // the graph's model call and tool boundary stop, and the turn writes nothing outward from then on
  // (no send, no silence, no receipt) unless its first send had already been claimed.
  signal?: AbortSignal;
  // Whether the customer's message ended up in the thread: called at most once, right after the
  // invoke returns. The outcome word cannot stand in (the input guardrail answers `posted` before
  // the invoke, the output guardrail `blocked` after it). The caller writes it to the ledger here,
  // since a later TTS or send failure skips the settlement. Awaited and best-effort.
  onFoldedIn?: () => void | Promise<void>;
  // What the authorization endpoint said about this contact on the check that let THIS turn happen,
  // or null when the gate is off (or this path has no verdict of its own). Required, not optional:
  // every path that reaches here asks the gate immediately before it, and a path that forgot to
  // forward the answer would silently drop the block from the prompt instead of failing.
  authContext: AuthContext | null;
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentBotId: number | null;
  threadId: string;
  // What happens to this turn if `graph.invoke` throws, from the caller that would run it again.
  // `retry`: the debounce job has attempts left and runs the burst again. `dead_letter`: this is the
  // job's last attempt, and its death writes the line that says the customer went unanswered
  // (../modules/debounce/handler.ts, `announceDeadDebounceFlush`). Either way the `generate` failure
  // line is `info`, so a turn the next run answers pages nobody and the lost one pages once. Absent
  // (a direct turn, the re-engage): nothing runs the turn again, and the line stays `error`.
  afterThrow?: "retry" | "dead_letter";
  // Optional turn correlation id. The debounce flush passes the same id it used for its own
  // `debounce` flow line, so the coalescing and the turn's stages group together in the logs.
  turnId?: string;
  // The user text to feed the graph (a single message, or the coalesced burst from a debounce flush).
  text: string;
  // Chatwoot id of the triggering message, surfaced to HTTP tools as {{message_id}}. Direct path: the
  // incoming message id; debounce flush: the burst watermark. Omitted ⇒ {{message_id}} stays unset.
  messageId?: number;
  // Every inbound message this turn answers, for the WhatsApp read receipt (empty: no receipt).
  // Required so a new coalescing entry point cannot compile while acknowledging only the newest.
  readMessageIds: number[];
  // Whether the customer's turn included a voice note; drives the "mirror" TTS reply mode.
  userSentAudio?: boolean;
  base?: PrismaClient;
  deps?: RuntimeDeps;
  // Optional last-moment gate, after the assignee re-check and before the post. Anything but
  // `"post"` suppresses the reply and decides the outcome, since only the gate knows which of its
  // two refusals it is. Supersede only: the at-most-once claim is `claimReply` below.
  shouldPost?: () => Promise<PostVerdict>;
  // Which burst this turn claims; required and nullable because it is what makes two posting paths
  // exclusive (`null`: nothing anyone else could post, e.g. the playground). Claimed here, not by
  // the caller, so one column decides for every path that sends.
  claimReply: {
    conversationDbId: bigint;
    toMessageId: number;
    // The ids this turn is exclusive over, one row each; disjoint lists do not exclude each other.
    // `toMessageId` is where the scalar column moves to, for readers below the per-message floor.
    messageIds: readonly number[];
    // Who asked, forwarded to the claim: only the operator's re-engage may overturn a deliberate
    // silence.
    initiatedBy: "automatic" | "operator";
    // Why the claim was lost. The outcome word cannot carry it: every loss stands down the same way,
    // but a partial conflict leaves messages nobody claimed and nothing scheduled for them.
    onLost?: (reason: "claimed" | "handled" | "dispensed" | "partial") => void;
    // How far the handled watermark may have moved with the claim still standing, checked under the
    // claim's row lock so a skip cannot land between the read and the claim. The direct turn and the
    // flush pass `toMessageId - 1`; the manual re-engage (which answers a tail the mark covers)
    // passes the mark it read on the way in, where null means "no mark was there", not "no ceiling".
    maxHandledAllowed: number | null;
  } | null;
  // Whether the run that queued this turn is still wanted, asked inside the `ingest:` section and
  // before each post. `strict` (inside the section, before any write) stops the run on an unreadable
  // answer, since "still wanted" there recreates what /reset cleared; elsewhere it guards a send and
  // an unreadable answer continues, fenced by the final CAS. Required and nullable so each caller
  // answers; `null` for a webhook turn, which no job can call off.
  stillWanted: ((opts: { strict: boolean }) => Promise<boolean>) | null;
  // Stand down as "thread-busy", writing nothing, when the claim reports another invoke already
  // reading the thread (`heldBefore`). Optional because only the debounce flush can defer; the
  // exclusion is not in `markTurnOwning` because that claim counts on purpose (appends and
  // compaction reservations share a thread with a turn). See docs/graph.md, "Pieces".
  standDownIfThreadHeld?: boolean;
  // Wait out an invoke already on the thread, then read a channel holding its answer: of two
  // overlapping invokes, the one finishing second undoes the first. Opt-in because the debounce
  // flush defers instead; `runAgentTurn` sets it. The nudge waits too, unflagged (./nudge.ts).
  // See docs/graph.md, "Pieces" (the thread-claim entries).
  waitForThreadTurn?: boolean;
  // Whether the ownership gate after the wait acts (absent or `true`: whenever a wait happened).
  // Separate from `waitForThreadTurn`: the wait is about the thread, the gate about what it cost.
  recheckOwnershipAfterWait?: boolean;
  // This turn already waited before arriving here for something other than the thread queue (the
  // re-engage extracting unopened attachments, up to 60s each). The ownership gate exists for that
  // window: the post-generation recheck suppresses the send but cannot undo a tool's side effects.
  waitedBeforeInvoke?: boolean;
}

// What the hand-over asks of the conversation row, read live at the end of the turn:
// whether anyone on our side has ever spoken in it (the predicate the follow-up gate uses,
// `ourSideHasSpoken`; a human reply that landed while the model ran counts), and whether the bot
// still owns it. The second is the post-generation recheck asked AGAIN, because moderation and
// attachment delivery sit between that recheck and here, and an operator who resolved or snoozed the
// conversation in that window must not see it reopened. A row that cannot be found answers "spoken"
// and "not ours", the reading that changes nothing.
export async function handoverRow(
  base: PrismaClient,
  tenantId: bigint,
  conversationDbId: bigint | null,
  ourBot: number | null,
): Promise<{ spoken: boolean; ours: boolean }> {
  if (conversationDbId === null) return { spoken: true, ours: false };
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.conversation.findUnique({
      where: { id: conversationDbId },
      select: {
        lastRepliedMessageId: true,
        chatwootFirstReplyAt: true,
        lastProactiveAt: true,
        assigneeType: true,
        assigneeId: true,
        status: true,
      },
    }),
  );
  if (!row) return { spoken: true, ours: false };
  return {
    spoken: ourSideHasSpoken(row),
    ours: shouldBotHandle(
      {
        assigneeType: row.assigneeType,
        assigneeId: row.assigneeId,
        status: row.status,
      },
      { ourAgentBotId: ourBot },
    ),
  };
}

// Whether this turn answers the customer messages that reopened a resolved conversation, read off
// Chatwoot's activity trail on a fresh page (./reopened-by-burst.ts). An unreadable page answers no.
export async function answersTheReopen(
  client: Pick<ChatwootClient, "getMessages">,
  conversationId: number,
  messageIds: readonly number[] | undefined,
): Promise<boolean> {
  if (!messageIds || messageIds.length === 0) return false;
  try {
    const page = parseChatwootMessages(
      await client.getMessages(conversationId),
    );
    return burstReopenedResolved(page, messageIds);
  } catch (err) {
    logger.warn(
      { err, conversationId },
      "reopen check: page read failed; leaving the conversation as it is",
    );
    return false;
  }
}

// Same line the tool's side-effect reporter writes (prepare.ts onSideEffectError), so the Logs page
// and the alert see the deferred close's label trouble where they see the immediate one's.
function reportResolveLabels(flow: FlowContext, result: ResolveLabelsResult) {
  const warn = (
    phase: string,
    detail: Record<string, unknown>,
    msg: string,
    level: "warn" | "info" = "warn",
  ) =>
    emitFlowEvent(flow, {
      stage: "tool",
      level,
      status: "error",
      detail: { ...detail, tool: "resolve_conversation", phase },
      errorMessage: msg,
    });
  if (result.unknown.length > 0)
    warn(
      "resolve_labels_unknown",
      { labels: result.unknown },
      `resolve labels not in the account: ${result.unknown.join(", ")}`,
    );
  if (result.outcome === "failed" || result.heldBy === "unread")
    warn(
      "resolve_labels",
      {},
      result.error instanceof Error
        ? result.error.message
        : String(result.error),
      // NOTE: Held back on a contact whose open case could not be ruled out: the close went through,
      // so `info`, the same split the immediate close makes.
      result.outcome === "failed" ? "warn" : "info",
    );
}

// Applies a deferred resolve_conversation intent after the reply is delivered: toggling mid-turn
// would make the recheck read our own resolve as a takeover, and posting reopens it anyway.
// Called only on "posted" and "empty". Failures inside are caught and reported as a flow warn,
// leaving the conversation pending. Answers whether the toggle landed.
async function applyDeferredResolve(
  client: ChatwootClient,
  conversationId: number,
  turnState: TurnState,
  flow: FlowContext,
  origin: {
    tenantId: bigint;
    instanceId: bigint;
    base: PrismaClient;
    // What the ownership recheck saw, status and version together. Read from the row BEFORE the
    // toggle, because after it the mirror may already carry our own close and a re-read could not
    // tell it from somebody else's.
    observed: ObservedConversation;
    // The run's ownership-aware fence (a takeover as well as a withdrawal). The label write is a wait
    // after the caller's last ask, so it is asked inside the label queue and again before the toggle.
    stillWanted?: () => Promise<boolean>;
  },
): Promise<boolean> {
  if (!turnState.resolveRequested) return false;
  // Read before the intent is cleared: it is what says the labels belong to this close.
  const labels = resolveLabelsFor(turnState);
  turnState.resolveRequested = false;
  let closed = false;
  try {
    // Read live, not from `origin.observed` (taken before a slow delivery): a close landing in
    // that window would otherwise be credited to the agent.
    const observed = await observeBeforeClose(
      client,
      conversationId,
      origin.observed,
    );
    // NOTE: Labels go before the toggle, since Chatwoot reads the survey rules on the status change.
    // A label that could not be written does not keep the conversation open.
    reportResolveLabels(
      flow,
      await applyResolveLabels({
        client,
        tenantId: origin.tenantId,
        conversationId,
        // NOTE: Somebody else's close already landed; a label would claim it for the agent.
        labels: observed.status === "resolved" ? [] : labels,
        caseHold: turnState.resolveCaseHold,
        stillWanted: origin.stillWanted,
      }),
    );
    // NOTE: Only a close that waited on labels asks again.
    if (
      labels.length > 0 &&
      origin.stillWanted &&
      !(await origin.stillWanted())
    ) {
      return false;
    }
    await client.toggleStatus(conversationId, "resolved");
    // NOTE: Closed from here on, whatever the bookkeeping below does.
    closed = true;
    // NOTE: The Resolution funnel counts this close as the agent's; every other path to "resolved"
    // records its own origin, or none outside our code.
    await recordResolutionOrigin({
      tenantId: origin.tenantId,
      conversation: {
        chatwootInstanceId: origin.instanceId,
        chatwootConversationId: conversationId,
      },
      origin: "agent",
      observed,
      base: origin.base,
    });
    emitFlowEvent(flow, {
      stage: "handoff",
      status: "ok",
      detail: { outcome: "resolved" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      "deferred resolve failed (conv=%s): %s",
      String(conversationId),
      msg,
    );
    emitFlowEvent(flow, {
      stage: "handoff",
      level: "warn",
      status: "error",
      detail: { outcome: "resolved" },
      errorMessage: msg,
    });
  }
  return closed;
}

// What a batch of queued attachments did. Several fields rather than one bit because "nothing
// arrived" has distinct causes: a failed send is a turn error the operator is told about, a
// revocation is their own click, and a called-off run is the conversation being cleared.
interface AttachmentDelivery {
  // Something reached the customer.
  sent: boolean;
  // At least one attachment was attempted and did not get through. Neither a revocation nor a
  // called-off run is a failure: nothing was attempted for either.
  failed: boolean;
  // The run was retired part-way through the batch. Read with `sent`: reporting "stale" after a
  // picture already left would hand the burst to the next flush, which sends it again.
  calledOff: boolean;
  // Another turn holds the reply claim on this burst, so the batch never started. Always with
  // `sent: false`: the ask is one statement before the first send, and the gate is memoized, so a
  // batch that delivered anything had already won the claim.
  lostClaim: boolean;
}

// Delivers the files the agent queued this turn after the reply's gates, best-effort per file.
// Called only on the "posted" and "empty" outcomes; other outcomes drop the queue.
async function deliverPendingAttachments(
  client: ChatwootClient,
  conversationId: number,
  turnState: TurnState,
  flow: FlowContext,
  document?: { tenantId: bigint; base: PrismaClient },
  // Asked before each attachment: a run called off after the second file must not post the third.
  calledOff: () => Promise<boolean> = async () => false,
  // Asked right before the first send, so a batch that sends nothing never marks the burst
  // answered. Memoized by the caller.
  claimBeforeSend: () => Promise<boolean> = async () => true,
): Promise<AttachmentDelivery> {
  // Sorted by the model's tool-call order, not by the order the downloads finished in: the
  // batch runs concurrently, and a caption only makes sense next to the picture it was written for.
  const queued = turnState.pendingAttachments
    .splice(0)
    .sort((a, b) => a.order - b.order);
  let sent = false;
  let failed = false;
  let stopped = false;
  let lostClaim = false;
  for (const file of queued) {
    // NOTE: A queued document is bytes, so revocation is re-read right before the send. The instant
    // between this read and the HTTP call stays open on purpose: a lock across a Chatwoot call would
    // make revocation wait behind the system it stops, and a late revoke still kills the link.
    if (file.documentId && document) {
      // Fails closed and locally: a database error must not throw out of the loop and cost the
      // customer the reply.
      const live = await runScopedOn(
        document.base,
        { tenantId: document.tenantId, userId: null, role: "TENANT_ADMIN" },
        (db) =>
          db.issuedDocument.findUnique({
            where: { id: file.documentId as bigint },
            select: { revoked: true },
          }),
      ).catch((e: unknown) => {
        logger.warn(
          "document %s: revocation recheck failed before delivery — not sending: %s",
          String(file.documentId),
          e instanceof Error ? e.message : String(e),
        );
        return null;
      });
      if (live?.revoked !== false) {
        // `revoked` is the operator's decision; anything else (lookup failed, row gone) is a
        // failure. The caller's bit and the operator's line are decided here together so they agree.
        const revoked = live?.revoked === true;
        if (!revoked) failed = true;
        emitFlowEvent(flow, {
          stage: "tool",
          ...(revoked
            ? {
                status: "skipped" as const,
                detail: { tool: file.tool, outcome: "revoked_before_delivery" },
              }
            : {
                level: "warn" as const,
                status: "error" as const,
                detail: { tool: file.tool, outcome: "revocation_unknown" },
                errorMessage:
                  "could not confirm whether this document was revoked; it was not sent",
              }),
        });
        continue;
      }
    }
    // NOTE: Asked after the revocation lookup: no I/O may sit between an ask and the write it guards
    // (the rule in ./nudge.ts).
    if (await calledOff()) {
      stopped = true;
      break;
    }
    // NOTE: The claim goes last, one statement before the send that answers an attachment-only turn.
    if (!(await claimBeforeSend())) {
      lostClaim = true;
      break;
    }
    try {
      await client.sendFileAttachment(
        conversationId,
        file.bytes,
        file.fileName,
        file.mime,
        // NOTE: The caption is the model's text, escaped for Chatwoot's Liquid.
        {
          caption:
            file.caption === undefined
              ? undefined
              : literalForChatwoot(file.caption),
        },
      );
      sent = true;
      emitFlowEvent(flow, {
        stage: "tool",
        status: "ok",
        // NOTE: The queueing tool, not a constant, so the operator finds the line under the tool
        // they granted.
        detail: { tool: file.tool, outcome: "sent" },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(
        "%s delivery failed (conv=%s): %s",
        file.tool,
        String(conversationId),
        msg,
      );
      emitFlowEvent(flow, {
        stage: "tool",
        level: "warn",
        status: "error",
        detail: { tool: file.tool, outcome: "failed" },
        errorMessage: msg,
      });
      failed = true;
    }
  }
  return { sent, failed, calledOff: stopped, lostClaim };
}

// Takes the reply claim, here because the direct turn, the debounce flush and the manual re-engage
// all share this tail, and at-most-once holds only while they claim the same column. The claim is
// never given back: a failed send leaves the burst marked, trading a lost reply (surfaced by
// `lastError` and the re-engage button) for never sending a duplicate. A release on failure would
// change that trade for every posting path. See docs/graph.md, "The reply claim".
export async function runLoadedTurn(
  params: RunLoadedTurnParams,
): Promise<RunAgentTurnOutcome> {
  const target = params.claimReply;
  if (!target) return runTurnBody(params);
  const base = params.base ?? basePrisma;
  // Memoized and asked by the first site one statement before a real send, not by the
  // supersede gate: turns that then say nothing (guardrail, empty reply, revoked document) must
  // leave the column untouched. Two racing turns still meet in one atomic CAS.
  let decided: boolean | null = null;
  const claimBeforeSend = async (): Promise<boolean> => {
    if (decided !== null) return decided;
    const claim = await claimReplyBurst({
      tenantId: params.tenantId,
      conversationDbId: target.conversationDbId,
      toMessageId: target.toMessageId,
      maxHandledAllowed: target.maxHandledAllowed,
      messageIds: target.messageIds,
      initiatedBy: target.initiatedBy,
      base,
    });
    if (!claim.won) {
      target.onLost?.(claim.reason);
      logger.info(
        "turn: %s (conv=%s target=%s), deferring",
        claim.reason === "handled"
          ? "the burst was already handled"
          : claim.reason === "dispensed"
            ? "the burst was deliberately dispensed"
            : claim.reason === "partial"
              ? "another turn holds part of this burst"
              : "another turn holds the reply claim",
        String(params.conversationId),
        String(target.toMessageId),
      );
    }
    decided = claim.won;
    return decided;
  };
  return runTurnBody({ ...params, claimBeforeSend });
}

// `RunLoadedTurnParams` plus the claim gate the wrapper above built. Not on the public type because
// no caller may supply it; absent (the playground, no triggering message), it answers yes.
type RunTurnBodyParams = RunLoadedTurnParams & {
  claimBeforeSend?: () => Promise<boolean>;
};

// Whether a read receipt on this channel can reach anything. Unknown counts as WhatsApp: the
// mirrored `channelType` stays null until a sync, and the cost of guessing wrong is one request
// Chatwoot answers 200 and drops for channels without `read_messages`, while the strict check would
// silently drop the tick on a real WhatsApp conversation.
function channelCanReadReceipt(channelType: string | null): boolean {
  return channelType === null || channelType === "Channel::Whatsapp";
}

// Builds the client, tools and graph from an already-loaded AgentConfig, invokes the thread,
// re-checks the live assignee, consults `shouldPost`, then posts via the bot token.
async function runTurnBody(
  params: RunTurnBodyParams,
): Promise<RunAgentTurnOutcome> {
  // The turn's wall time starts here, before the config is read.
  const turnStartedAt = performance.now();
  // The closing line is owed to a turn that reached a model or left a message, not to one a
  // gate stopped first.
  let reachedModel = false;
  // Every real send here is one statement after an ask on this; the default sends.
  const askClaim = params.claimBeforeSend ?? (async () => true);
  // Once a send is claimed the burst is this turn's, and a reply on its way finishes past the
  // deadline.
  let sendClaimed = false;
  // Set further down. A completed transfer is as spent as a send: a retry would find the
  // conversation a person's, so its promised line is this run's to deliver.
  let handoffOf: HandoffTurnState | undefined;
  // Whether the job's deadline has ended this run for what is still unsent.
  const pastDeadline = (): boolean =>
    params.signal?.aborted === true &&
    !sendClaimed &&
    handoffOf?.completed !== true;
  const claimBeforeSend = async (): Promise<boolean> => {
    // NOTE: A run past its deadline was failed and its retry answers this burst. Asked before the
    // first send only: once claimed, the retry finds the burst taken, and stopping a split reply
    // halfway would leave a truncated answer no retry can complete.
    if (pastDeadline()) {
      logger.info(
        "turn: the job's deadline ended this run (conv=%s), not sending",
        String(params.conversationId),
      );
      return false;
    }
    const won = await askClaim();
    if (won) sendClaimed = true;
    return won;
  };
  // Applied before anything reads the config, so the model, the output guardrail and the
  // audited row all see the same prompt.
  const loaded = withAuthContextSection(params.loaded, params.authContext);
  const { tenantId, instanceId, conversationId, agentBotId, threadId, text } =
    params;
  const base = params.base ?? basePrisma;

  // One turnId correlates every stage; source "inbox" means warn/error may page an alert.
  const flow: FlowContext = {
    tenantId,
    turnId: params.turnId ?? crypto.randomUUID(),
    source: "inbox",
    conversationId: loaded.conversationDbId,
    agentId: loaded.agentId,
    inboxId: loaded.inboxDbId,
    threadId,
    base,
    fullDetail: loaded.fullDetail,
  };

  // The bot token is the persona's, so replies are attributed to its Agent Bot. Wrapped so the
  // turn knows which messages it created, whoever sent them.
  const recorded = recordSends(
    await loadChatwootClient(tenantId, instanceId, {
      base,
      makeClient: params.deps?.makeClient,
      botToken: loaded.agentBotToken ?? undefined,
    }),
  );
  const client = recorded.client;

  // Asked at each outward write, never upstream of it: a round trip grows between an ask and
  // its effect. It also carries the operator switching the agent off or to monitoring, since the
  // loaded config is waits old by the last send. `silenced` latches which refusal it was ("stale"
  // leaves the burst unmarked, "agent-unavailable" has the caller re-read the agent); the episode
  // is asked first, so a run that lost both answers "stale". See docs/graph.md, "Asked at the write".
  let silenced = false;
  const writeCalledOff = async (): Promise<boolean> => {
    if (
      params.stillWanted !== null &&
      !(await params.stillWanted({ strict: false }))
    ) {
      return true;
    }
    if (!(await agentStillSpeaks(tenantId, loaded.agentId, base))) {
      silenced = true;
      return true;
    }
    // NOTE: Past its deadline, any write (a silence, a guardrail refusal, a receipt) would settle the
    // burst its retry answers, so it reads as a withdrawal. Read after the reads above, where the
    // deadline can fire; not once a send was claimed.
    return pastDeadline();
  };
  const standDown = (): "stale" | "agent-unavailable" =>
    silenced ? "agent-unavailable" : "stale";

  // Who owns the conversation per the mirror right now; the receiver's answer is old by the
  // time a write lands, and no later recheck can unwrite a message. Throws when it cannot answer:
  // `botOwnsItNow` reads a failure as "not ours" (the hand-back note stays owed), while the
  // guardrail's transfer wants the opposite default and decides for itself.
  const ownershipNow = async (): Promise<boolean> =>
    await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const conv = await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        },
        select: { assigneeType: true, assigneeId: true, status: true },
      });
      return shouldBotHandle(
        {
          assigneeType: conv?.assigneeType ?? null,
          assigneeId: conv?.assigneeId ?? null,
          status: conv?.status ?? null,
        },
        { ourAgentBotId: loaded.agentBotId ?? agentBotId },
      );
    });
  const botOwnsItNow = async (): Promise<boolean> =>
    await ownershipNow().catch((err) => {
      logger.warn(
        { err, conv: conversationId },
        "hand-back note: ownership read failed; leaving the note owed",
      );
      return false;
    });

  // NOTE: The WhatsApp read receipt, in the tail both entry points share; a turn here has read the
  // messages, and the tick promises no reply. Not driven by `lastHandledMessageId`, which also moves
  // for bursts nobody read. As an outward write it asks, at the write: a real conversation (the
  // playground is id 0), a channel that can show it, `writeCalledOff`, `botOwnsItNow` (fail-closed),
  // and `markRead` skips an empty list. Never the reply claim: a receipt observes, it does not
  // consume. Best-effort. See docs/graph.md, "The read receipt".
  if (
    params.conversationId > 0 &&
    channelCanReadReceipt(loaded.channelType) &&
    !(await writeCalledOff()) &&
    (await botOwnsItNow())
  ) {
    // NOTE: try/catch, not `.catch()`: a client that predates the method throws TypeError
    // synchronously while invoking, which `.catch()` does not see.
    try {
      await client.markRead(params.conversationId, params.readMessageIds);
    } catch {
      // NOTE: Swallowed on purpose: see above.
    }
  }

  // The gates before a post (the fences are the asks at the sends). `writeCalledOff` goes
  // first because `shouldPost` can advance the handled watermark, so a retired run would mark a burst
  // it never answered. Asked again after it: `shouldPost` is a Chatwoot round trip, and a /reset on
  // the entry conversation retires the widget's flush with nothing new on the widget's page. A burst
  // retired in that window is consumed unanswered, accepted over posting into a reset conversation.
  const postBlocked = async (): Promise<
    "stale" | "agent-unavailable" | "superseded" | "answered-elsewhere" | null
  > => {
    if (await writeCalledOff()) return standDown();
    if (params.shouldPost) {
      // The gate reports what it saw; this is the one place that maps it to an outcome.
      const verdict = await params.shouldPost();
      if (verdict === "newer-message") return "superseded";
      if (verdict === "answered-by-other") return "answered-elsewhere";
    }
    if (await writeCalledOff()) return standDown();
    return null;
  };

  // Per-turn mutable state shared with the native tools (deferred resolve intent).
  const turnState: TurnState = {
    resolveRequested: false,
    pendingAttachments: [],
    imagesInFlight: 0,
    documentsInFlight: 0,
    attachmentsSeq: 0,
  };
  // The reply's modality is planned once, before the model runs, and the model is told from
  // it. Delivery re-asks with the preference at the end of the turn and logs a `tts` line when the
  // two differ.
  const plannedAudio = plannedReplyIsAudio(loaded.ttsConfig, {
    userSentAudio: params.userSentAudio ?? false,
    contactVoiceReply: loaded.contactVoiceReply,
    channelType: loaded.channelType,
  });
  const replyChoice: ReplyChoice = { textChosen: false };
  // The modality right now, for each round's notice: the plan until `set_voice_preference` or
  // a text choice changes it, so the instruction never contradicts what the model was just told.
  let audioNow = plannedAudio;
  const handoffState: HandoffTurnState = {
    customerMessage: null,
    completed: false,
    declinedToSpeak: false,
  };
  handoffOf = handoffState;
  // The tool boundary's fence is the same `writeCalledOff` every send reads (the agent switch
  // and mode can change under any turn), plus whether the conversation is still the bot's against
  // its owner at turn start (./ownership-fence.ts says when it asks).
  const ownershipFence = withOwnershipFence(
    async () => !(await writeCalledOff()),
    {
      // NOTE: Unreadable is not ours: the fence then never asks, so a failing read lets tools run.
      ownedAtStart: await ownershipNow().catch(() => false),
      ownerChangedByThisTurn: () => ownerChangedByTurn(handoffState),
      // NOTE: The shared reader, which carries the closed gate's detail with its "no".
      ownsNow: () =>
        conversationOwnershipNow({
          tenantId,
          instanceId,
          conversationId,
          ourAgentBotId: loaded.agentBotId ?? agentBotId,
          base,
        }),
      conversationId,
    },
  );
  const stillWantedFence = ownershipFence.ask;

  const tools = await buildToolset(
    loaded,
    {
      tenantId,
      instanceId,
      base,
      client,
      conversationId,
      threadId,
      checkpointer: params.deps?.checkpointer,
      // NOTE: The slow-tool ack's send is a wait after the graph's ask at the tool boundary.
      stillWanted: stillWantedFence,
      messageId: params.messageId,
      imageDeps: params.deps?.imageDeps,
      documentsStorageDir: params.deps?.documentsStorageDir,
      turnState,
      handoffState,
      replyChoice,
      replyIsAudioWith: (voiceReply) => {
        audioNow = plannedReplyIsAudio(loaded.ttsConfig, {
          userSentAudio: params.userSentAudio ?? false,
          contactVoiceReply: voiceReply,
          channelType: loaded.channelType,
        });
        return audioNow && !replyChoice.textChosen;
      },
      // NOTE: The gate and the transfer are built below; a tool only runs inside the invoke, after
      // both exist. A `handoff` verdict takes the reply's own transfer, with the policy's line as the
      // handoff's closing line.
      screenCustomerText: async (text) => {
        const d = await runGuardrail("output", text);
        if (!guardrailTripped(d)) return "send";
        if (d.kind !== "handed-off") return "drop";
        const handed = await ownTransfer(
          handoffState,
          () => handOverForGuardrail("output"),
          (r) => r === "handed",
        );
        // NOTE: A transfer that did not land is not a dropped line: the case must not open (nor
        // `resolveOrigin` close the origin) as if no person had been asked for.
        if (handed === "failed") return "failed";
        if (handed !== "handed") return "drop";
        handoffState.customerMessage = d.reply;
        handoffState.lineByOperator = true;
        handoffState.declinedToSpeak = d.reply === null;
        return "handed";
      },
    },
    { buildNativeTools, mcp: params.deps?.mcp, flow },
  );

  // Whether an unexplained silence was asked once more, for the warn that still fires when
  // the second answer said nothing too.
  let silenceRetried = false;
  let silenceRetryOutcome: SilenceRetryOutcome | null = null;
  const graph = await buildModelAndGraph(loaded, tools, {
    // NOTE: Asked by the graph when the silence retry would run. A completed transfer or something
    // already delivered is not a silence: the same facts `silenceIsUnexplained` reads at the end.
    retrySilence: () =>
      loaded.retrySilence &&
      !handoffState.completed &&
      !turnDeliveredToCustomer(turnState, handoffState),
    // NOTE: Written after the invoke: a retry that called tools only declared silence once
    // `skip_reply` ran and left its mark.
    onSilenceRetry: ({ outcome }) => {
      silenceRetried = true;
      silenceRetryOutcome = outcome;
    },
    makeModel: params.deps?.makeModel,
    checkpointer: params.deps?.checkpointer,
    spokenNotice: () =>
      spokenNoticeFor(loaded.ttsConfig, audioNow && !replyChoice.textChosen),
    // NOTE: The one ask inside the invoke, at the tool boundary, so tools do not write onto a
    // conversation a /reset just cleared. Non-strict, like `writeCalledOff`: it guards a write to the
    // world, and an unreadable mark is not a withdrawal. See docs/graph.md, "The tool boundary,
    // when the turn was called off".
    stillWanted: stillWantedFence,
    // NOTE: Hard tool-call limit reached: a warn so the operator sees the agent was forced to answer.
    onToolLimit: ({ maxToolCalls, toolCalls }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: maxToolCalls, toolCalls },
      }),
    // NOTE: A wait past the capacity threshold for a model permit: the instance, not the model, is
    // what the customer is waiting on.
    onModelPermitWait: (wait) =>
      emitCapacityWait(flow, "model_semaphore", wait),
    // NOTE: To the graph's model call and tool boundary, never to `graph.invoke` (see
    // BuildAgentGraphParams.signal).
    signal: params.signal,
    // NOTE: A turn recovered from an empty provider response must not read like a clean one in the
    // Logs, or the fault's rate is invisible.
    onModelRetry: ({ attempt, provider, model }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "ok",
        // NOTE: The retry can happen on either model; the labels ride on the event, so there is no
        // default here to get wrong.
        provider,
        model,
        // NOTE: Written before the retry runs, so it is `info` with `willRetry`: a retry that also
        // comes back empty fails the turn, and that failure is the line that alerts.
        detail: { retriedEmptyResponse: attempt, willRetry: true },
      }),
    // NOTE: A fallback that answers is a successful turn, so this warn is the operator's one signal
    // that the primary provider is not taking their traffic.
    onModelFallback: ({ provider, model, reason, failure }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        provider,
        model,
        detail: {
          fallbackFrom: loaded.mc.provider,
          fallbackReason: reason,
          primaryFailure: failure,
        },
      }),
    // NOTE: The fallback failed too. Attribution, not a second alarm: the wrapping `generate` stage
    // already emits the error (labelled with the primary), and alert coalescing keys on (channel,
    // stage, level), so a second error would page twice. `info` names which model died; `status`
    // stays "error".
    onModelFallbackFailed: ({ provider, model, reason, failure }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "error",
        provider,
        model,
        detail: { fallbackFailed: reason, failure },
        errorMessage: reason,
      }),
    // NOTE: A configured fallback that cannot be built, reported once per turn build rather than on
    // a failure, when it would be too late to warn.
    onModelFallbackUnavailable: ({ provider, model, reason }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        provider,
        model,
        detail: { fallbackUnavailable: reason },
      }),
    // NOTE: Info, not warn: the turn that left the calls unanswered already failed where it was
    // killed, and this one answers. The line is what ties a "No tool output found" in the provider's
    // logs to the turn that cleared it.
    onDanglingToolCalls: ({ calls }) =>
      emitFlowEvent(flow, {
        stage: "memory",
        level: "info",
        status: "ok",
        detail: { reason: "repaired_dangling_tool_call", calls },
      }),
    // NOTE: Info, not warn: a working history ceiling trims on nearly every turn of a long thread and
    // warn pages. Counts only, never a fragment of what was dropped.
    onHistoryTrim: ({ kept, dropped, tokens }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "ok",
        detail: {
          historyKept: kept,
          historyDropped: dropped,
          historyTokens: tokens,
        },
      }),
  });
  const callbacks = buildCallbacks(loaded, {
    tenantId,
    threadId,
    base,
    persistUsage: params.deps?.persistUsage,
    // NOTE: Same id as the ExecutionLog turn, so the Langfuse trace correlates 1:1 with our Logs.
    turnId: flow.turnId,
    tools,
  });

  // The graph thread is per contact-inbox; the per-conversation `threadId` stays the
  // flow/debounce/watermark key.
  const graphThreadId = resolveGraphThreadId(
    tenantId,
    instanceId,
    conversationId,
    loaded.contactInboxId,
  );

  // One reader for the two surfaces that label a silence (the trail and the live bubble).
  // Only the silence tool's line and live step ask it, so `silenceAsked` records whether this turn
  // owes the closing fact below.
  let silenceAsked = false;
  const turnDelivered = () => {
    silenceAsked = true;
    return turnDeliveredToCustomer(turnState, handoffState);
  };
  // The live "agent is working" indicator; `finished` in the finally clears it on every exit.
  const status = new AgentStatusReporter({
    tenantId,
    conversationDbId: loaded.conversationDbId,
    turnDelivered,
  });
  // Logs each tool call under this turn's flow group.
  const toolLogger = new ToolFlowLogger(flow, {
    logValues: loaded.logToolValues,
    tools,
    turnDelivered,
    handedOff: () => handoffState.completed === true,
  });

  // One guardrail gate, shared with the proactive path. A trip logs a `guardrail` line and
  // posts a private note, so a blocked or replaced reply is never invisible.
  const runGuardrail = buildGuardrailGate({
    cfg: loaded.guardrails,
    apiKey: loaded.guardrailsApiKey,
    credentialBaseUrl: loaded.guardrailsCredentialBaseUrl,
    announce: chatwootNoteSink(client, conversationId),
    flow,
    systemPrompt: loaded.systemPrompt,
    // NOTE: The raw inbound text, never a system marker the customer did not write.
    customerMessage: text,
    makeModel: params.deps?.makeModel,
    // NOTE: The same usage sink as the turn's own callbacks.
    persistUsage: params.deps?.persistUsage,
    langfuseCfg: loaded.langfuseCfg,
  });
  // The transfer a guardrail `handoff` verdict asks for, gated after the judge's model call:
  // not called off, not superseded, still the bot's. Not the reply claim, which means "answered";
  // two racing transfers are harmless, and only the line takes the claim, where it is sent. The
  // resolve falls with the verdict, and a landed transfer is marked so the silence hand-over does
  // not write a second note.
  const handOverForGuardrail = async (
    direction: "input" | "output",
  ): Promise<"handed" | "failed" | RunAgentTurnOutcome> => {
    turnState.resolveRequested = false;
    const blocked = await postBlocked();
    if (blocked) return blocked;
    // NOTE: A failed read lets the transfer go ahead: the policy asked for a person.
    if (!(await ownershipNow().catch(() => true))) return "taken-over";
    // NOTE: Asked again after that read: no later check can undo the status change below.
    if (await writeCalledOff()) return standDown();
    const handed = await applyGuardrailHandoff({
      client,
      conversationId,
      instanceId,
      handoff: loaded.handoffConfig,
      direction,
      flow,
      stillWanted: async () => !(await writeCalledOff()),
    });
    handoffState.completed = handed;
    if (await writeCalledOff()) return standDown();
    return handed ? "handed" : "failed";
  };

  // The `tts` line of a reply that leaves its planned modality. Written from `deliverText`,
  // which a turn reaches once (a transfer's closing line takes the reply's place).
  const noteSentAsText = (reason: "contact_preference" | "model_choice") =>
    emitFlowEvent(flow, {
      stage: "tts",
      level: "info",
      status: "skipped",
      detail: { sentAsText: reason },
    });
  // One piece of customer-facing text, as audio when the modality calls for it, otherwise as
  // typing-paced balloons. Returns the balloons that landed (1 for audio) and whether part is
  // missing, since `deliverReply` reports a partial send without throwing. A synthesis failure
  // falls back to text.
  const deliverText = async (
    text: string,
    voiceReply: boolean | null,
    // NOTE: False when the text is the operator's (a guardrail's template or hand-over message).
    modelText = true,
  ): Promise<ReplyDelivery | "stale" | "superseded"> => {
    const asked = shouldReplyWithAudio(
      loaded.ttsConfig.mode,
      params.userSentAudio ?? false,
      voiceReply,
    );
    // NOTE: The reply leaves its planned modality when the customer's preference changed during the
    // turn (it wins) or the model chose text.
    if (plannedAudio && !asked) noteSentAsText("contact_preference");
    const chosenText = asked && replyChoice.textChosen;
    if (chosenText) noteSentAsText("model_choice");
    const wantAudio = asked && !chosenText;
    // A URL or an e-mail address is never said: it follows the voice note in writing, or the
    // whole reply goes as text when only its introduction would be said, or when it is built to be
    // read (too long, a list, a run of prices).
    const spoken = planAudioReply(text, loaded.ttsConfig);
    if (wantAudio) logTextInsteadOfAudio(flow, spoken);
    if (wantAudio && !spoken.textOnly) {
      try {
        // Its callbacks are built fresh (same usage/trace identity, different node and model),
        // giving a nested Langfuse generation instead of a second root update.
        const normalizeSpeech =
          params.deps?.normalizeSpeech ??
          buildSpeechNormalizer(loaded, {
            makeModel: params.deps?.makeModel,
            callbacks: {
              tenantId,
              threadId,
              base,
              persistUsage: params.deps?.persistUsage,
              turnId: flow.turnId,
            },
            flow,
          });
        const tts = await synthesizeReply({
          tenantId,
          cfg: loaded.ttsConfig,
          text: spoken.speech,
          channelType: loaded.channelType,
          base,
          deps: {
            fetchImpl: params.deps?.ttsFetch,
            normalizeSpeech,
            checkFetchImpl: params.deps?.ttsCheckFetch,
          },
          flow,
          check: params.deps?.ttsCheck,
          // NOTE: A regeneration after the audio check is one more billed synthesis and one more
          // wait, not worth paying for a reply this turn will not send.
          shouldStop: writeCalledOff,
        });
        // NOTE: Asked again after the normalizer's model call and the synthesis.
        if (await writeCalledOff()) return "stale";
        if (tts) {
          if (!(await claimBeforeSend())) return "superseded";
          const sent = await client.sendAudioMessage(
            conversationId,
            tts.audio,
            tts.fileName,
            tts.mime,
            {
              transcribedText: spoken.speech,
              // NOTE: What the channel gets as text if it refuses the audio: the speech has holes
              // where the items were, and the reply does not.
              ...(spoken.speech === text ? {} : { replyText: text }),
              // NOTE: The operator's words keep Chatwoot's Liquid in that text.
              ...(modelText ? {} : { byOperator: true }),
            },
          );
          // Upstream Chatwoot drops `attachments_metadata` and `content` cannot carry a caption
          // on WhatsApp audio, so the words go to the same overlay the inbound STT pass writes: a
          // flush or recovery re-reading the page then sees the reply as words.
          const sentId =
            sent && typeof sent === "object" && "id" in sent
              ? Number((sent as { id?: unknown }).id)
              : Number.NaN;
          if (Number.isSafeInteger(sentId)) {
            stashMediaAnnotation(
              { tenantId, instanceId, messageId: sentId },
              { transcribedText: spoken.speech },
            );
          }
          logger.info(
            "chatwoot agent replied (audio): conv=%s thread=%s len=%d",
            String(conversationId),
            threadId,
            text.length,
          );
          // NOTE: The voice note landed (a rejected one falls back to text below), so a stand-down
          // from here still reports it delivered. `deliverReply` with split off never asks
          // `calledOff`, so the check is made here.
          if (spoken.written.length === 0 || (await writeCalledOff())) {
            return { delivered: 1, failed: false, unproven: false };
          }
          // One balloon, unsigned: it is the rest of the voice note, not a reply of its own.
          const items = await deliverReply(
            client,
            conversationId,
            spoken.written.join("\n"),
            { ...loaded.splitConfig, enabled: false },
            params.deps?.sleep,
            flow,
            writeCalledOff,
            Number.isSafeInteger(sentId) ? sentId : null,
            null,
            modelText,
          );
          return { ...items, delivered: 1 + items.delivered };
        }
      } catch (e) {
        logger.warn(
          "tts failed (conv=%s), falling back to text: %s",
          String(conversationId),
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    const sig = signatureFor(
      loaded.signatureConfig,
      loaded.promptVars,
      loaded.promptOpts,
    );
    const signed = sig
      ? {
          text: sig,
          position: loaded.signatureConfig.position,
          separator: loaded.signatureConfig.separator,
          frequency: loaded.signatureConfig.frequency,
        }
      : null;
    // NOTE: Asked again for the text path, reached directly or after a failed TTS attempt.
    if (await writeCalledOff()) return "stale";
    if (!(await claimBeforeSend())) return "superseded";
    const balloons = await deliverReply(
      client,
      conversationId,
      text,
      loaded.splitConfig,
      params.deps?.sleep,
      flow,
      writeCalledOff,
      // NOTE: Where the read-back stops when the first send fails: the message this turn answers.
      params.claimReply?.toMessageId ?? null,
      // NOTE: The operator's signature, attached inside `deliverReply` after the cut (both separators
      // are what the splitter cuts on). The reply and the handoff's closing line carry it; audio does
      // not. See docs/signature.md.
      signed,
      modelText,
    );
    logger.info(
      "chatwoot agent replied: conv=%s thread=%s len=%d balloons=%d partial=%s",
      String(conversationId),
      threadId,
      text.length,
      balloons.delivered,
      String(balloons.failed),
    );
    return balloons;
  };

  // Balloons the reply was delivered as, surfaced on `finished` so the UI can hold a
  // "delivering" indicator. 1 for audio or a single send; null on no post.
  let deliveredBalloons: number | null = null;
  // Whether a file reached the customer; an attachment-only turn leaves the balloons null.
  let sentAttachment = false;
  // The reply is text an earlier message of this turn carried; it rides on the closing line
  // only if it reached the customer.
  let replyRecovered = false;

  // The contact's voice preference now: `set_voice_preference` writes it during the invoke.
  // Best-effort, falling back to the snapshot, because the closing line must leave even when the
  // database will not answer.
  const currentVoiceReply = async (): Promise<boolean | null> => {
    if (loaded.contactDbId == null) return loaded.contactVoiceReply;
    try {
      const c = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.contact.findUnique({
          where: { id: loaded.contactDbId as bigint },
          select: { voiceReply: true },
        }),
      );
      return c?.voiceReply ?? null;
    } catch {
      return loaded.contactVoiceReply;
    }
  };

  // The sentence the transfer promised, delivered on the way out of the turn whatever that
  // way is: once the tool set `open`, every retry stops at its ownership gate. Two exclusive call
  // sites (the failure path rethrows); a third would own the at-most-once question.
  const deliverHandoffPromise = async (): Promise<void> => {
    if (!handoffAnsweredTheTurn(handoffState)) return;
    const line = handoffState.customerMessage;
    try {
      const guarded = await runGuardrail("output", line);
      // NOTE: A trip here drops the queued images too, as the main gate below does: a verdict on
      // this turn's customer-facing text applies to every artefact.
      if (guardrailTripped(guarded)) turnState.pendingAttachments.length = 0;
      const screened = screenedText(guarded, line);
      if (screened === null) return;
      const delivered = await deliverText(
        screened,
        await currentVoiceReply(),
        guardrailTripped(guarded)
          ? !screenedByOperator(guarded)
          : handoffState.lineByOperator !== true,
      );
      // NOTE: This line leaves before the later gates, so a called-off run stops here; the transfer
      // stays done. A partial send is not raised (the delivery is best-effort), and "superseded"
      // means another turn holds the claim, so nothing was sent.
      if (
        delivered === "stale" ||
        delivered === "superseded" ||
        delivered.delivered === 0
      )
        return;
      deliveredBalloons = delivered.delivered;
    } catch (e) {
      // NOTE: Best-effort: the transfer succeeded, so an error would stamp lastError on a thread a
      // human already owns, and on the failure path would mask the error that ended the turn.
      logger.warn(
        "handoff closing line failed to deliver (conv=%s): %s",
        String(conversationId),
        e instanceof Error ? e.message : String(e),
      );
      emitFlowEvent(flow, {
        stage: "split",
        status: "error",
        level: "warn",
        detail: { outcome: "handoff_closing_line_undelivered" },
        errorMessage: e instanceof Error ? e.message : String(e),
      });
    }
  };

  status.started();
  // NOTE: In-flight, so a concurrent follow-up backs off; cleared in the finally (./inflight.ts).
  markTurnInFlight(threadId);
  // The durable claim against a concurrent append, taken inside the try below so the `finally`
  // releases it even when the checkpointer, divider or marker throws; a leaked claim backs off
  // every follow-up and compaction for the contact until restart.
  let graphOwner: ThreadOwner | null = null;
  let graphHold: TurnHold | null = null;
  // A flag, not a throw: the `ingest:` section has to finish before this function returns.
  let calledOff = false;
  // Set by the stand-down inside the `ingest:` section; like `calledOff`, nothing was written.
  let threadBusy = false;
  // The same shape, for a takeover during the wait; nothing was written.
  let takenOverUnread = false;
  // What a token-silenced turn produced, rolled back in the `finally` after the in-flight flag
  // the rollback refuses on is released.
  let silenceProduced: BaseMessage[] | null = null;
  // A guardrail hand-over that did not land: the turn ends through its ordinary refusal and
  // throws on the way out, after every release, since only a throw keeps the message owed.
  let handoffFailed: "input" | "output" | null = null;
  // The hand-back note was owed but an older invoke was reading the channel, so it rides in
  // this turn's own invoke input: the durable write waits, the correction does not.
  let handbackDeferred = false;
  try {
    // NOTE: Attendance boundary. A new conversation on this thread is claimed inside the `ingest:`
    // section ingestion also takes: the divider is written as its own message and the marker
    // advances together, then the replaced attendance is armed for compaction. See docs/graph.md,
    // "Pieces" (the attendance boundary entry).
    if (loaded.contactInboxId != null) {
      const contactInboxId = loaded.contactInboxId;
      // Barrier: a queued ingestion job may still hold a message this thread lacks, so it is
      // drained before the section and the claim (the drain takes the same key). Its outcome is
      // discarded here and at the nudge, where a customer waits; compaction refuses to read on it.
      const checkpointerForDivider =
        params.deps?.checkpointer ?? (await getCheckpointer());
      const dividerGraph = buildThreadStateGraph(checkpointerForDivider);
      const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
      // One deadline across every attempt, armed before the first wait, so a turn that loses
      // the acquiring race does not get a fresh budget.
      const turnWaitUntil = params.waitForThreadTurn
        ? turnWaitDeadline()
        : null;
      // Serialized by the process-local queue, not a transaction-scoped advisory lock: the
      // section spans the checkpointer's separate pool, and a Prisma transaction held across it
      // drains the main pool. Reads and the write are short transactions of their own.
      let closedConversationId: number | null = null;
      for (;;) {
        // NOTE: Waited out here, outside the `ingest:<thread>` queue: the previous turn's rollback
        // takes that key after releasing the thread, and waiting inside it would starve the rollback,
        // so this turn would load the undone answer or silence token as history.
        if (turnWaitUntil !== null)
          await waitForTurnToClear(owner, base, turnWaitUntil);
        // NOTE: After the wait: draining before a wait of minutes reads a thread already stale.
        await drainPendingIngest(tenantId, graphThreadId, base);
        const attempt = await withKeyedQueue(
          `ingest:${graphThreadId}`,
          async (): Promise<number | null | typeof WAIT_AGAIN> => {
            // NOTE: Asked here because everything below writes (the divider, the compaction arm, the
            // invoke's channel): a run whose job /reset retired must not recreate the cleared thread.
            // Inside the critical section; no transaction encloses it, so the ask opens its own scope.
            if (
              params.stillWanted &&
              !(await params.stillWanted({ strict: true }))
            ) {
              calledOff = true;
              return null;
            }
            // Per-thread marker (AgentThread keyed by contact-inbox), so a multi-channel contact
            // never gets a divider from activity on another channel.
            const key = {
              tenantId_chatwootInstanceId_contactInboxId: {
                tenantId,
                chatwootInstanceId: instanceId,
                contactInboxId,
              },
            };
            // NOTE: Claimed for every turn inside the section a compaction rewrite also enters, so the
            // two exclude each other; taken in the row too, for other replicas, and it waits out an
            // append in flight (./thread-claim.ts). Released in the `finally` on every exit.
            graphHold = await markTurnOwning(owner, base);
            graphOwner = owner;
            // NOTE: The acquiring statement decides the wait: of two turns that both read "free",
            // exactly one gets `heldBefore` false, and the other gives its hold back (kept, it would
            // stop the winner's release reaching zero) and waits again. Past the deadline it proceeds
            // beside whoever is there (./thread-claim.ts).
            if (
              turnWaitUntil !== null &&
              graphHold.heldBefore &&
              Date.now() < turnWaitUntil
            ) {
              const giveBack = graphHold;
              graphHold = null;
              graphOwner = null;
              await clearTurnOwning(owner, base, giveBack);
              return WAIT_AGAIN;
            }
            // NOTE: Only the acquiring UPDATE sees a simultaneous start. Nothing is written yet and
            // the `finally` releases the claim, so standing down costs a reschedule.
            if (params.standDownIfThreadHeld && graphHold.heldBefore) {
              threadBusy = true;
              return null;
            }
            // NOTE: Asked again because the claim can wait on an append's lease and on the row lock
            // /reset takes, which releases straight into this waiter: without this the turn would
            // rewrite the divider and marker over the clear. `graphOwner` is set, so the `finally`
            // releases the claim.
            if (
              params.stillWanted &&
              !(await params.stillWanted({ strict: true }))
            ) {
              calledOff = true;
              return null;
            }
            // NOTE: Who owns the conversation, after a wait that can last the whole ceiling: the model
            // and its tools run below, and the post-generation recheck cannot undo their side effects.
            // Only where a wait can happen (`turnWaitUntil`, not a count of waits, since
            // `markTurnOwning` blocks uncounted), and fail-open, unlike `botOwnsItNow`, since a flaky
            // read must not drop the reply. See docs/graph.md, "Ownership after the thread wait".
            if (
              (turnWaitUntil !== null || params.waitedBeforeInvoke === true) &&
              params.recheckOwnershipAfterWait !== false
            ) {
              const posse = await (
                params.deps?.ownershipRead ?? conversationOwnershipNow
              )({
                tenantId,
                instanceId,
                conversationId,
                ourAgentBotId: loaded.agentBotId ?? agentBotId,
                base,
              }).catch((err: unknown) => {
                logger.warn(
                  { err, conv: conversationId },
                  "turn: ownership after the wait could not be read; carrying on rather than standing the turn down",
                );
                return { ours: true as const };
              });
              if (!posse.ours) {
                // NOTE: The same `handoff` line every closed ownership gate writes, from the detail
                // that came with the read. Null `closed` (another AgentBot, no bot id on this route)
                // declares no outcome, and `gate-close.test.ts` forbids inventing one.
                if (posse.closed !== null) {
                  emitFlowEvent(flow, {
                    stage: "handoff",
                    status: "ok",
                    detail: posse.closed,
                  });
                }
                takenOverUnread = true;
                return null;
              }
            }
            // Read after the claim: `markTurnOwning` can wait out an append that writes these
            // markers, and a stale row written back walks `lastSyncedMessageId` backwards. Whether
            // another invoke is reading comes from the claim (./thread-claim.ts).
            const existing = await runScopedOn(base, sysCtx(tenantId), (db) =>
              db.agentThread.findUnique({
                where: key,
                select: {
                  lastConversationId: true,
                  lastSyncedMessageId: true,
                },
              }),
            );
            const anotherInvokeIsReading = graphHold.heldBefore;
            const prev = existing?.lastConversationId ?? null;
            const alreadyStarted = needsAttendanceStartProbe(
              prev,
              conversationId,
              anotherInvokeIsReading,
            )
              ? attendanceHasStarted(
                  (
                    (
                      await dividerGraph.getState({
                        configurable: { thread_id: graphThreadId },
                      })
                    ).values as { messages?: BaseMessage[] } | undefined
                  )?.messages ?? [],
                  conversationId,
                )
              : false;
            const claim = claimAttendanceBoundary({
              previousConversationId: prev,
              conversationId,
              anotherInvokeIsReading,
              attendanceAlreadyStarted: alreadyStarted,
            });
            if (claim.writeDivider) {
              await dividerGraph.updateState(
                { configurable: { thread_id: graphThreadId } },
                { messages: [conversationDividerMessage(conversationId)] },
                THREAD_STATE_NODE,
              );
            }
            // The hand-back note, owed when the bot has the conversation back while the thread
            // reads as a person's. Written here: it lands before the customer's message, inside the
            // section guarding the divider. Derived from the channel (./handback.ts), never a column.
            const channelNow = (
              (
                await dividerGraph.getState({
                  configurable: { thread_id: graphThreadId },
                })
              ).values as { messages?: BaseMessage[] } | undefined
            )?.messages;
            // NOTE: Deferred while another invoke reads, like the divider (it would save over the
            // note); nothing is lost, since the next turn derives the same answer.
            if (
              owesHandbackNote(channelNow ?? []) &&
              // NOTE: Asked again as late as possible: the claim counts rather than excludes, and a
              // second copy of the note is an announcement the model would repeat.
              (anotherInvokeIsReading ||
                owesHandbackNote(
                  (
                    (
                      await dividerGraph.getState({
                        configurable: { thread_id: graphThreadId },
                      })
                    ).values as { messages?: BaseMessage[] } | undefined
                  )?.messages ?? [],
                )) &&
              // NOTE: Asked last, after every checkpointer read: the note says the human attendance
              // ended, and a stale answer would leave a false history no later gate can take back.
              (await botOwnsItNow())
            ) {
              if (anotherInvokeIsReading) {
                handbackDeferred = true;
              } else {
                await dividerGraph.updateState(
                  { configurable: { thread_id: graphThreadId } },
                  { messages: [humanHandbackMessage(conversationId)] },
                  THREAD_STATE_NODE,
                );
              }
            }
            // The turn records the inbound id it handled, on every handled turn (only
            // `lastConversationId` is conditional): ingestion compares an out-of-order message with it
            // (`movesAttendanceFrontier`) for both the boundary and the attendance stamp. The scalar
            // only: `recentSyncedMessageIds` lists what ingestion folded in, and a turn's message is
            // never ingested. See docs/graph.md, "The inbound frontier".
            const inboundId = params.messageId;
            const markedId =
              inboundId === undefined
                ? null
                : Math.max(existing?.lastSyncedMessageId ?? 0, inboundId);
            if (claim.advanceMarker || markedId !== null) {
              await runScopedOn(base, sysCtx(tenantId), (db) =>
                db.agentThread.upsert({
                  where: key,
                  create: {
                    tenantId,
                    chatwootInstanceId: instanceId,
                    contactInboxId,
                    threadId: graphThreadId,
                    lastConversationId: conversationId,
                    ...(markedId === null
                      ? {}
                      : { lastSyncedMessageId: markedId }),
                  },
                  update: {
                    ...(claim.advanceMarker
                      ? { lastConversationId: conversationId }
                      : {}),
                    ...(markedId === null
                      ? {}
                      : { lastSyncedMessageId: markedId }),
                  },
                }),
              );
            }
            return claim.closedConversationId;
          },
        );
        if (attempt !== WAIT_AGAIN) {
          closedConversationId = attempt;
          break;
        }
      }
      // NOTE: Read after the `ingest:` section finished; on these exits it wrote nothing.
      if (threadBusy) {
        logger.info(
          "turn: thread %s was already held by another invoke when this turn claimed it (conv=%s), standing down without writing",
          graphThreadId,
          String(conversationId),
        );
        return "thread-busy";
      }
      if (calledOff) {
        logger.info(
          "turn: the run was retired while it worked (conv=%s), standing down",
          String(conversationId),
        );
        return "stale";
      }
      if (takenOverUnread) {
        logger.info(
          "turn: a person took conversation %s over while this turn waited for the thread, standing down before the invoke; the message is still owed",
          String(conversationId),
        );
        return "taken-over-unread";
      }
      if (closedConversationId !== null) {
        // NOTE: Outside the section: this opens its own transaction.
        await armCompaction({
          tenantId,
          instanceId,
          contactInboxId,
          conversationId: closedConversationId,
          agentId: loaded.agentId,
          reason: "new_attendance",
          enabled: loaded.memoryCompaction,
          base,
        });
      }
    } else {
      // The conversation-keyed fallback thread has no barrier, claim or divider, but a handoff
      // is written by the turn's own invoke on any thread, so the hand-back note applies here too.
      // Best-effort: with no claim the note can be erased, and the next turn derives it again.
      const fallbackGraph = buildThreadStateGraph(
        params.deps?.checkpointer ?? (await getCheckpointer()),
      );
      const channelNow = (
        (
          await fallbackGraph.getState({
            configurable: { thread_id: graphThreadId },
          })
        ).values as { messages?: BaseMessage[] } | undefined
      )?.messages;
      if (owesHandbackNote(channelNow ?? []) && (await botOwnsItNow())) {
        await fallbackGraph.updateState(
          { configurable: { thread_id: graphThreadId } },
          { messages: [humanHandbackMessage(conversationId)] },
          THREAD_STATE_NODE,
        );
      }
    }

    // Input guardrail, before the agent runs. A trip sends the template or a safe reply, or
    // stays silent; anything short of a trip proceeds, including a screening that could not run.
    const inGuard = await runGuardrail("input", text);
    if (inGuard.kind !== "not-run") reachedModel = true;
    // NOTE: Asked after the screening's model call, since its silent branch returns "blocked", which
    // consumes the burst.
    if (await writeCalledOff()) return standDown();
    if (guardrailTripped(inGuard)) {
      const inReply = screenedText(inGuard, text);
      // NOTE: A hand-over passes the same gates a post does; the transfer comes first and the
      // sentence after it, as `handoff_to_human` does.
      if (inGuard.kind === "handed-off") {
        const handed = await handOverForGuardrail("input");
        if (handed !== "handed" && handed !== "failed") return handed;
        // NOTE: The line promises a person, so it goes out only when the transfer landed. A failed
        // one throws on the way out: every outcome word settles the message.
        if (handed === "failed") {
          handoffFailed = "input";
          return "empty";
        }
        if (inReply === null) return "blocked";
        if (!(await claimBeforeSend())) return "superseded";
        await client.sendMessage(conversationId, inReply);
        deliveredBalloons = 1;
        return "posted";
      }
      if (inReply !== null) {
        // The guardrail reply passes the same gates as any post; the claim goes last, one
        // statement before the send.
        const blocked = await postBlocked();
        if (blocked) return blocked;
        if (!(await claimBeforeSend())) return "superseded";
        await client.sendMessage(conversationId, inReply);
        deliveredBalloons = 1;
        return "posted";
      }
      return "blocked";
    }

    // NOTE: This ask guards the invoke, which persists the channel; the one inside the section
    // guards the divider and claim, and does not run at all without a contact-inbox.
    if (params.stillWanted && !(await params.stillWanted({ strict: false }))) {
      logger.info(
        "turn: the run was retired before the invoke (conv=%s), standing down",
        String(conversationId),
      );
      return "stale";
    }

    // NOTE: The same ownership gate for a conversation-keyed thread that waited before the invoke,
    // where the gate inside the section never runs. Fail-open for the same reason, and the same
    // `taken-over-unread`: nothing was written, so the message is still owed.
    if (
      loaded.contactInboxId == null &&
      params.waitedBeforeInvoke === true &&
      params.recheckOwnershipAfterWait !== false
    ) {
      const posse = await (
        params.deps?.ownershipRead ?? conversationOwnershipNow
      )({
        tenantId,
        instanceId,
        conversationId,
        ourAgentBotId: loaded.agentBotId ?? agentBotId,
        base,
      }).catch((err: unknown) => {
        logger.warn(
          { err, conv: conversationId },
          "turn: ownership after the wait could not be read; carrying on rather than standing the turn down",
        );
        return { ours: true as const };
      });
      if (!posse.ours) {
        if (posse.closed !== null) {
          emitFlowEvent(flow, {
            stage: "handoff",
            status: "ok",
            detail: posse.closed,
          });
        }
        logger.info(
          "turn: a person took conversation %s over while this turn read the attachments, standing down before the invoke; the message is still owed",
          String(conversationId),
        );
        return "taken-over-unread";
      }
    }

    // Re-derived right before the invoke: the invoke this deferred to may have appended the
    // note itself. This narrows the window without closing it; the leftover case is two identical
    // system notes that nothing consumes.
    const carriedHandback =
      handbackDeferred &&
      owesHandbackNote(
        (
          (
            await buildThreadStateGraph(
              params.deps?.checkpointer ?? (await getCheckpointer()),
            ).getState({ configurable: { thread_id: graphThreadId } })
          ).values as { messages?: BaseMessage[] } | undefined
        )?.messages ?? [],
      );
    // This invoke's own message, named, so the error path can ask whether these words reached
    // the channel: a count cannot, since another turn on the shared thread can grow it. Needs no
    // before-picture, so the ordinary turn pays nothing. No test separates it from a count; it is
    // kept because matching the id is strictly narrower.
    const inputMessageId = crypto.randomUUID();
    // Reported the moment the message is in the thread, and awaited, so a later throw cannot
    // lose it (the rule `settleDelivery` follows in ../modules/chatwoot/webhook.ts).
    let reportedFoldedIn = false;
    const reportFoldedIn = async (): Promise<void> => {
      if (reportedFoldedIn) return;
      reportedFoldedIn = true;
      try {
        await params.onFoldedIn?.();
      } catch (e) {
        // NOTE: Best-effort: a failed report leaves the null the reader falls back on.
        logger.warn(
          { err: e, conversationId: String(conversationId) },
          "turn: could not report that the message was folded in",
        );
      }
    };
    reachedModel = true;
    const result = await withFlowStage(
      flow,
      "generate",
      {
        provider: loaded.mc.provider,
        model: loaded.mc.model,
        // NOTE: The resolved prompt of this turn is audited, since it is where the contact's data
        // entered (./prompt-audit.ts).
        detail: { systemPrompt: loaded.systemPromptAudit },
        ...(params.afterThrow
          ? {
              failureOf: () => ({
                level: "info" as const,
                detail: { willRetry: params.afterThrow === "retry" },
              }),
            }
          : {}),
      },
      () =>
        graph.invoke(
          {
            messages: [
              // NOTE: The deferred hand-back note, before the customer's message, as the model reads
              // it. If this write does not survive, the next turn derives it again.
              ...(carriedHandback
                ? [humanHandbackMessage(conversationId)]
                : []),
              // NOTE: The conversation stamp is what the compaction cut reads. The sent-at stamp is
              // the instant `{{idade_ultima_mensagem}}` reads (a burst's newest member); unknown
              // stays unstamped, never the turn's clock.
              new HumanMessage({
                id: inputMessageId,
                content: text,
                additional_kwargs: {
                  ...conversationStamp(conversationId),
                  ...sentAtStamp(loaded.promptOpts.messageAt),
                  ...burstStartStamp(loaded.burstStartedAt),
                },
              }),
            ],
          },
          {
            // NOTE: LangGraph counts super-steps and its default 25 runs out near twelve tool rounds,
            // below the budget an operator may set (1-50).
            recursionLimit: recursionLimitFor(loaded.maxToolCalls),
            configurable: { thread_id: graphThreadId },
            callbacks: [...callbacks, status, toolLogger],
          },
        ),
    ).catch(async (e) => {
      toolLogger.settle();
      // NOTE: LangGraph checkpoints as it goes, so a graph that threw may still have written the
      // customer's message; asked of the channel by this invoke's id. A failed read leaves coverage
      // unstated, the safe side (a duplicate line over lost words). A throw still delivers the
      // closing line a handoff already promised.
      try {
        const after = (
          (
            await buildThreadStateGraph(
              params.deps?.checkpointer ?? (await getCheckpointer()),
            ).getState({ configurable: { thread_id: graphThreadId } })
          ).values as { messages?: BaseMessage[] } | undefined
        )?.messages;
        if (after?.some((m) => m.id === inputMessageId)) await reportFoldedIn();
      } catch (readErr) {
        logger.warn(
          { err: readErr, conversationId: String(conversationId) },
          "turn: could not read the channel after a failed invoke; leaving coverage unstated",
        );
      }
      await deliverHandoffPromise();
      throw e;
    });
    // NOTE: The model is done calling tools, so a tool that failed on every call is now the turn's
    // outcome and gets its one `warn`.
    toolLogger.settle();
    // NOTE: The customer's message is in the thread from here on, whatever outcome word follows:
    // every refusal below rolls back what the model produced, never what the customer said.
    await reportFoldedIn();
    // NOTE: The silence retry's outcome, settled against what ran: a batch is `skip_reply` only if
    // it ran and left its mark (`silenceWasChosen`), so one a precondition refused is `tools`.
    if (silenceRetryOutcome) {
      const outcome =
        silenceRetryOutcome === "skip_reply" || silenceRetryOutcome === "tools"
          ? silenceWasChosen(result.messages as BaseMessage[])
            ? "skip_reply"
            : "tools"
          : silenceRetryOutcome;
      emitFlowEvent(flow, {
        stage: "generate",
        status: "ok",
        detail: { silenceRetry: outcome },
      });
    }
    // Every refusal from here down goes out through this (fenced by
    // tests/graph/refused-turn-callsites.test.ts). The invoke already checkpointed the answer, so a
    // suppressed send would leave the next turn reading an unsent reply; `undoRefusedTurn` decides
    // whether to roll back.
    const refuse = async (
      outcome: RunAgentTurnOutcome,
    ): Promise<RunAgentTurnOutcome> => {
      const plan = await undoRefusedTurn({
        checkpointer: params.deps?.checkpointer ?? (await getCheckpointer()),
        graphThreadId,
        produced: result.messages,
        kind: "reactive",
      }).catch((err) => {
        // NOTE: Best-effort, and loudly: throwing would turn a correct refusal into a retried turn.
        logger.warn(
          { err, conversationId: String(conversationId) },
          "turn: could not roll back the refused turn",
        );
        return null;
      });
      if (plan?.action === "remove") {
        logger.info(
          "turn rolled back a refused turn: conv=%s outcome=%s messages=%d",
          String(conversationId),
          outcome,
          plan.ids.length,
        );
      } else if (plan?.reason === "another-invoke-is-reading") {
        // NOTE: The one keep that is a miss: the history still holds a message the customer never
        // received, so it is a warn.
        logger.warn(
          "turn could not roll back a refused turn, another invoke holds the thread: conv=%s outcome=%s",
          String(conversationId),
          outcome,
        );
      }
      return outcome;
    };
    // NOTE: A tool-boundary refusal ends on an empty assistant message like an empty turn, so it is
    // read off the result (a fence may change its mind), before `drafted` treats emptiness as a
    // result. An owner change mid-turn gets the post-generation recheck's outcome and line.
    if (turnWasCalledOff(result.messages)) {
      const lost = ownershipFence.lost();
      if (lost) {
        // NOTE: The detail of the read that refused, not of a second one.
        if (lost.closed !== null) {
          emitFlowEvent(flow, {
            stage: "handoff",
            status: "ok",
            detail: lost.closed,
          });
        }
        return refuse("taken-over");
      }
      return refuse(standDown());
    }

    // The follow-up's silence token can reach this shared thread and be reproduced here. A reply
    // that reduces to it is silence; see docs/graph.md, "Saying nothing". Before the output guardrail,
    // so the judge never screens a marker as the agent's text.
    const drafted = customerFacingReply(lastAssistantText(result.messages));
    let reply = drafted.text;
    // NOTE: A token silence is logged, as `skip_reply` records itself, so it is not mistaken for the
    // agent ignoring a waiting customer.
    if (drafted.bySentinel) {
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { silenceTokenSuppressed: true },
      });
      // NOTE: The token is rolled back out of the checkpoint, or the next turn imitates it. Armed
      // here and run in the `finally`: the rollback refuses while `isTurnInFlight` holds, which is
      // this very turn, so inline it would always keep.
      silenceProduced = result.messages as BaseMessage[];
    }
    // NOTE: A real answer carrying the token goes out unedited (editing it is data loss), so the
    // operator is told here.
    if (drafted.carriesToken) {
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { silenceTokenInReply: true },
      });
    }

    // NOTE: The deferred resolve falls with the transfer, even when its closing line never reached
    // the customer: the human queue's conversation is not ours to close.
    if (handoffState.completed) turnState.resolveRequested = false;
    const handedOff = handoffAnsweredTheTurn(handoffState);
    // NOTE: The model's final text after a handoff duplicates the closing line, and the mirror may
    // still read bot-owned. Blanked, not returned, so queued images still pass every gate below.
    if (handedOff) reply = "";
    // NOTE: The transfer declared that this case gets no reply, so the model's next line is dropped
    // too. The proactive path needs nothing: its ownership probe already reads `open`.
    else if (handoffDeclaredSilence(handoffState)) {
      // NOTE: The queue goes too: "no reply" includes attachments, and a caption tripping the output
      // guardrail would put a replacement back on the wire. The words leave the thread through the
      // deferred rollback the token uses; the reactive plan takes only the trailing assistant text,
      // so the transfer's call and result stay.
      if (reply) silenceProduced = result.messages as BaseMessage[];
      reply = "";
      const dropped = turnState.pendingAttachments.length;
      turnState.pendingAttachments.length = 0;
      logger.info(
        "turn: the handoff declared silence (conv=%s), so nothing goes to the customer (attachments dropped=%d)",
        String(conversationId),
        dropped,
      );
    }
    // NOTE: A reply the model wrote beside a tool call before ending on an empty message becomes the
    // reply here, above every gate. Only when nothing else answers the turn: no transfer, nothing
    // delivered or queued, no `skip_reply`, and a final message that said nothing (`wroteText`, not
    // `reply`). See docs/graph.md, "Saying nothing".
    if (
      !drafted.wroteText &&
      !handoffState.completed &&
      !turnDeliveredToCustomer(turnState, handoffState)
    ) {
      // The same filter as any reply: a line that reduces to the silence token is silence.
      const recovered = customerFacingReply(
        replyWrittenThisTurn(result.messages as BaseMessage[]),
      );
      if (recovered.text) {
        reply = recovered.text;
        replyRecovered = true;
      }
    }
    await deliverHandoffPromise();

    // Re-check the live assignee before posting. A small TOCTOU remains between this read and the
    // POST, which is a network call and cannot share a transaction with the read; single-replica
    // deployments accept it (docs/graph.md, "Pieces"). The same read takes the voice preference
    // `set_voice_preference` may have written during the invoke.
    const ourBot = loaded.agentBotId ?? agentBotId;
    const recheck = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const conv = await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        },
        select: {
          assigneeType: true,
          assigneeId: true,
          status: true,
          chatwootStatusAt: true,
        },
      });
      const ours = shouldBotHandle(
        {
          assigneeType: conv?.assigneeType ?? null,
          assigneeId: conv?.assigneeId ?? null,
          status: conv?.status ?? null,
        },
        { ourAgentBotId: ourBot },
      );
      let voiceReply = loaded.contactVoiceReply;
      if (loaded.contactDbId != null) {
        const c = await db.contact.findUnique({
          where: { id: loaded.contactDbId },
          select: { voiceReply: true },
        });
        voiceReply = c?.voiceReply ?? null;
      }
      return {
        ours,
        voiceReply,
        // NOTE: Carried out so the discard below says why ownership was lost, about this moment.
        assigneeType: conv?.assigneeType ?? null,
        observed: {
          status: conv?.status ?? null,
          statusAt: conv?.chatwootStatusAt ?? null,
        },
      };
    });
    // NOTE: Both gates below drop everything still unsent, queued photos of a handed-off turn
    // included; the closing line already left before them.
    if (!recheck.ours) {
      // NOTE: Two different events share this exit, so the line comes from `describeClosedGate`,
      // the reading every gate closing on this question shares.
      emitFlowEvent(flow, {
        stage: "handoff",
        status: "ok",
        detail: describeClosedGate({
          assigneeType: recheck.assigneeType,
          status: recheck.observed.status,
        }),
      });
      return refuse("taken-over");
    }

    // Last-moment supersede gate: a refusal drops the reply and the deferred resolve intent.
    const blocked = await postBlocked();
    if (blocked) return refuse(blocked);

    // Output guardrail before delivery, over everything the model wrote for the customer
    // (reply, captions, document fields). A trip drops the queue and replaces or suppresses the
    // reply; a suppressed send discards the deferred resolve. Above the empty-reply branch, since a
    // caption is customer-facing even without a final message.
    const modelWritten = turnState.pendingAttachments.flatMap((i) =>
      [i.caption?.trim(), i.screenText?.trim()].filter((c): c is string => !!c),
    );
    const screened = [reply, ...modelWritten].filter(Boolean).join("\n");
    const outGuard = screened ? await runGuardrail("output", screened) : null;
    // Whether what goes out below is the operator's text standing in for the reply.
    let replyByOperator = false;
    // NOTE: `postBlocked` answered before this model call, and the suppressed branch returns
    // "blocked" without a later ask.
    if (await writeCalledOff()) return refuse(standDown());
    if (outGuard && guardrailTripped(outGuard)) {
      turnState.pendingAttachments.length = 0;
      const replacement = screenedText(outGuard, screened);
      // NOTE: The refused reply goes nowhere and the case goes to the team; the transfer is marked,
      // so the empty branch below does not resolve or hand over twice.
      if (outGuard.kind === "handed-off") {
        const handed = await handOverForGuardrail("output");
        if (handed !== "handed" && handed !== "failed") return refuse(handed);
        // NOTE: A landed transfer with nothing to say is `blocked` (policy settled it), not `empty`,
        // which recovery would run again.
        if (handed === "handed" && replacement === null)
          return refuse("blocked");
        // NOTE: A failed transfer throws, like the input side, after the refused reply is rolled out
        // of the checkpoint so the retry does not read it as said.
        if (handed === "failed") {
          handoffFailed = "output";
          return refuse("empty");
        }
        reply = replacement ?? "";
      } else {
        if (replacement === null) return refuse("blocked");
        reply = replacement;
      }
      replyRecovered = false;
      replyByOperator = screenedByOperator(outGuard);
    }

    // NOTE: Empty reply: queued attachments and a deferred resolve still apply. After the recheck and
    // the supersede gate, since resolving under a superseded turn would make the next flush read
    // "resolved" and swallow the newest message. A delivered attachment reports "posted", which
    // clears the error badge.
    if (!reply) {
      // NOTE: Nothing has left this turn yet on this branch, so the whole thing stands down.
      if (await writeCalledOff()) return refuse(standDown());
      // A silence a person has to see (./skip-handover.ts): a reason naming one, or any silence
      // where our side never spoke. Asked on every empty exit unless a transfer or a landed resolve
      // already moved the conversation; a delivered attachment does not stand in the way.
      const handOverIfOwed = async (closed: boolean): Promise<void> => {
        if (closed || handoffState?.completed === true) return;
        if (await writeCalledOff()) return;
        const msgs = result.messages as BaseMessage[];
        const row = await handoverRow(
          base,
          tenantId,
          loaded.conversationDbId,
          ourBot,
        );
        if (!row.ours) return;
        // A slow tool's acknowledgement is our side speaking, and nothing stamps the row for it.
        const kind = skipHandoverKind(
          silenceWasChosen(msgs) ? chosenSilence(msgs) : null,
          row.spoken || turnState.spokeOutsideTheReply === true,
        );
        if (!kind) return;
        await applySkipHandover({
          client,
          conversationId,
          kind,
          detail: chosenSilence(msgs)?.detail ?? null,
          handoff: loaded.handoffConfig,
          instanceId,
          flow,
          stillWanted: async () => !(await writeCalledOff()),
        });
      };
      const queued = turnState.pendingAttachments.length;
      const {
        sent,
        failed,
        calledOff: attachmentsCalledOff,
        lostClaim,
      } = await deliverPendingAttachments(
        client,
        conversationId,
        turnState,
        flow,
        { tenantId: params.tenantId, base },
        writeCalledOff,
        claimBeforeSend,
      );
      sentAttachment ||= sent;
      // NOTE: Another turn holds the burst and nothing went out, so the whole turn stands down.
      if (lostClaim) return refuse("superseded");
      // NOTE: Only when nothing left: after a delivered attachment, "stale" would hand the burst to
      // the next flush, which sends it again.
      if (attachmentsCalledOff && !sent) return refuse(standDown());
      // NOTE: The attachments were the turn and none arrived. With a failure it throws, since callers
      // record a turn error only on a throw; not when a handoff answered, and not when nothing
      // failed (a revocation is the operator's own click). Either way the deferred resolve is
      // skipped: a conversation with no answer must not close.
      if (queued > 0 && !sent && !handedOff) {
        if (failed) {
          throw new Error(
            "envio de anexo: nada foi entregue e o turno não tinha resposta em texto",
          );
        }
        // NOTE: Nothing to close, but a silence that asked for a person still gets one.
        await handOverIfOwed(false);
        return "empty";
      }
      // An empty completion looks like a declared silence here, and must not let the deferred
      // resolve close an unanswered conversation. Read from the tool's mark, bounded at this turn
      // (`silenceWasChosen`): an earlier `skip_reply` in the shared thread authorises nothing now.
      const silenceChosen = silenceWasChosen(result.messages as BaseMessage[]);
      const unexplained = silenceIsUnexplained({
        delivered: sent,
        // NOTE: `completed`, not `handedOff`: that one asks whether the transfer supplied text, while
        // here the question is whether a person now owns it, which a silent transfer also answers.
        handedOff: handoffState?.completed === true,
        silenceChosen,
      });
      if (unexplained) {
        // One warn for both exits, saying whether a resolve was discarded, since the operator's
        // next move differs. The intent is left unused, not cleared: the `!unexplained` gate below
        // skips it.
        const resolveDiscarded = turnState.resolveRequested;
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          detail: {
            silenceUnexplained: true,
            resolveDiscarded,
            silenceRetried,
          },
        });
      }
      // NOTE: A thank-you after a close: an `acknowledged` silence, with no transfer, answering the
      // burst that reopened a resolved conversation (./reopened-by-burst.ts) puts it back to
      // `resolved`, so the follow-up does not nudge the customer who said thanks. The gates below
      // still decide. See docs/graph.md, "Saying nothing".
      if (
        handoffState?.completed !== true &&
        silenceChosen &&
        chosenSilence(result.messages as BaseMessage[])?.reason ===
          "acknowledged" &&
        (await answersTheReopen(
          client,
          conversationId,
          params.claimReply?.messageIds,
        ))
      ) {
        turnState.resolveRequested = true;
      }
      // The close is skipped, not returned on, when the run was called off (something may have
      // reached the customer) or the batch was partial (./close-intent.ts, shared by all three
      // closing sites).
      let closed = false;
      if (
        !unexplained &&
        mayCloseConversation({
          replyPartial: false,
          attachmentFailed: failed,
        }) &&
        !(await writeCalledOff())
      ) {
        closed = await applyDeferredResolve(
          client,
          conversationId,
          turnState,
          flow,
          {
            tenantId,
            instanceId,
            base,
            observed: recheck.observed,
            stillWanted: stillWantedFence,
          },
        );
      }
      await handOverIfOwed(closed);
      if (!sent && !handedOff) return "empty";
      const postedFiles = postedOutcomeFor({
        replyPartial: false,
        attachmentFailed: failed,
      });
      if (postedFiles === "posted-partial") {
        await notePartialDelivery({
          tenantId,
          instanceId,
          conversationId,
          base,
        });
      }
      return postedFiles;
    }

    // NOTE: The image lands before the text that talks about it, and before the TTS branch.
    if (await writeCalledOff()) return refuse(standDown());
    const attachments = await deliverPendingAttachments(
      client,
      conversationId,
      turnState,
      flow,
      { tenantId: params.tenantId, base },
      writeCalledOff,
      claimBeforeSend,
    );
    sentAttachment ||= attachments.sent;
    if (attachments.lostClaim) return refuse("superseded");
    // NOTE: Called off mid-batch: report what was delivered, since "stale" would replay a burst whose
    // attachment the customer already has.
    if (attachments.calledOff)
      return attachments.sent ? "posted" : refuse(standDown());

    const delivered = await deliverText(
      reply,
      recheck.voiceReply,
      !replyByOperator,
    );
    // NOTE: Another turn holds the claim; the memoized gate means no attachment went out either.
    if (delivered === "superseded") return refuse("superseded");
    // NOTE: Nothing landed and a send failed: the one partial shape that throws, since nothing can be
    // duplicated and a throw is how callers record a turn error. Not when an attachment already went
    // out, which a re-run would send again.
    if (
      delivered !== "stale" &&
      delivered.failed &&
      delivered.delivered === 0
    ) {
      // NOTE: And only when "nothing landed" is a fact: `unproven` means the reply may be in the
      // conversation, and a throw hands the row to recovery, which re-runs every tool. The badge
      // below reports it instead.
      if (!attachments.sent && !delivered.unproven) {
        throw new Error(
          "envio da resposta: nenhum balão foi entregue ao cliente",
        );
      }
    }
    // NOTE: Zero is the split loop standing down on its first balloon: a stale turn, unless an
    // attachment already went out (then "stale" would have the next flush send it again).
    if (delivered === "stale" || delivered.delivered === 0) {
      // NOTE: An unproven zero is reported, not stood down: the next flush would answer it again.
      if (delivered !== "stale" && delivered.unproven) {
        await notePartialDelivery({
          tenantId,
          instanceId,
          conversationId,
          base,
          unproven: true,
        });
        return "posted-partial";
      }
      if (!attachments.sent) return refuse(standDown());
      // The attachment is the answer the customer got; a failed text send makes it partial.
      // `stale` is not partial (nothing was attempted after the fence, and it would put `lastError`
      // back on a conversation /reset cleared), but a file that failed before the fence still counts.
      const postedOnFiles = postedOutcomeFor({
        replyPartial: delivered !== "stale" && delivered.failed,
        attachmentFailed: attachments.failed,
      });
      if (postedOnFiles === "posted-partial") {
        await notePartialDelivery({
          tenantId,
          instanceId,
          conversationId,
          base,
        });
      }
      return postedOnFiles;
    }
    deliveredBalloons = delivered.delivered;
    // An attendance the customer did not fully receive (text or files) does not close, while
    // the outcome still settles the burst, since a re-run would send the delivered part twice.
    const posted = postedOutcomeFor({
      replyPartial: delivered.failed,
      attachmentFailed: attachments.failed,
    });
    if (posted === "posted-partial") {
      await notePartialDelivery({
        tenantId,
        instanceId,
        conversationId,
        base,
        // NOTE: Part landed and one send is unaccounted for: a doubt, not a fact.
        unproven: delivered.unproven,
      });
      return posted;
    }
    // NOTE: The reply is out; the resolve is a separate write.
    if (await writeCalledOff()) return "posted";
    await applyDeferredResolve(client, conversationId, turnState, flow, {
      tenantId,
      instanceId,
      base,
      observed: recheck.observed,
      stillWanted: stillWantedFence,
    });
    return "posted";
  } finally {
    clearTurnInFlight(threadId);
    if (graphOwner) {
      const heldOwner: ThreadOwner = graphOwner;
      try {
        await clearTurnOwning(
          heldOwner,
          base,
          graphHold ?? { epoch: null, heldBefore: false },
        );
      } catch (err) {
        logger.warn(
          { err, thread: heldOwner.graphThreadId },
          "failed to release the durable turn claim; its lease will expire",
        );
      }
    }
    // NOTE: Last, after both claims are released: `markTurnInFlight(threadId)` and the durable
    // `markTurnOwning` on `graphThreadId`, a different key whenever there is a contact-inbox.
    // Earlier, the rollback reads this turn's own claim and silently keeps. Tests without a
    // contact-inbox collapse the two keys and cannot catch the order.
    if (silenceProduced) {
      const produced = silenceProduced;
      try {
        const plan = await undoRefusedTurn({
          checkpointer: params.deps?.checkpointer ?? (await getCheckpointer()),
          graphThreadId,
          produced,
          kind: "reactive",
          // NOTE: The released claim, taken again for the write so a turn starting on another
          // replica waits; null without a contact inbox (process-local check only, ./thread-claim.ts).
          owner: graphOwner,
          base,
        });
        if (plan?.action === "remove") {
          logger.info(
            "turn rolled back a token-silenced turn: conv=%s messages=%d",
            String(conversationId),
            plan.ids.length,
          );
        } else if (plan?.reason === "already-gone") {
          // NOTE: Not a miss: a refusal after the silence ran `refuse`'s own rollback, which races
          // this one (`return refuse(...)` is not awaited). Reading the outcome, not the order, is
          // what makes the answer stable.
          logger.info(
            "turn: the token-silenced turn was already taken back out: conv=%s",
            String(conversationId),
          );
        } else {
          // NOTE: Named rather than silent: the history still holds a message the customer never
          // received.
          logger.warn(
            "turn could not roll back a token-silenced turn: conv=%s reason=%s",
            String(conversationId),
            plan?.reason ?? "unknown",
          );
        }
      } catch (err) {
        logger.warn(
          { err, conversationId: String(conversationId) },
          "turn: could not roll back a token-silenced turn",
        );
      }
    }
    // The closing line of a turn that reached a model or sent something: its duration and sent ids,
    // for the conversation screen. When the silence tool asked, it also carries what actually went
    // out: a lone `skip_reply` does not end the turn, so its own stamp can precede a delivered line.
    const sentMessageIds = recorded.sentIds();
    if (reachedModel || sentMessageIds.length > 0)
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "ok",
        detail: {
          turnMs: Math.round(performance.now() - turnStartedAt),
          ...(sentMessageIds.length > 0 ? { sentMessageIds } : {}),
          ...(replyRecovered && deliveredBalloons ? { replyRecovered } : {}),
          ...(silenceAsked
            ? {
                turnDelivered: turnReachedTheCustomer({
                  balloons: deliveredBalloons,
                  attachment: sentAttachment,
                  spokeOutsideTheReply: turnState.spokeOutsideTheReply,
                }),
              }
            : {}),
        },
      });
    status.finished(deliveredBalloons);
    // NOTE: Last, so nothing above is skipped by it.
    // biome-ignore lint/correctness/noUnsafeFinally: the throw replaces the settling outcome on purpose
    if (handoffFailed) throw new GuardrailHandoffFailedError(handoffFailed);
  }
}

export interface RunAgentTurnParams {
  // See `RunLoadedTurnParams.onFoldedIn`; forwarded verbatim.
  onFoldedIn?: () => void | Promise<void>;
  tenantId: bigint;
  instanceId: bigint;
  agentBotId: number | null;
  event: NormalizedChatwootEvent;
  base?: PrismaClient;
  deps?: RuntimeDeps;
  // The authorization verdict from the gate the webhook ran on this delivery, for the prompt block.
  // Optional here and required one layer down: the gate is the caller's business.
  authContext?: AuthContext | null;
}

// Nothing to answer on the direct path: the message renders to nothing, no turn runs, and the word
// stays `skipped`. Arms the delayed judgement for the inbox's agent on the mirrored conversation;
// the job decides later whether our side ever spoke there.
async function armNothingToAnswerDirect(
  params: RunAgentTurnParams,
  conversationId: number,
  inboxId: number,
): Promise<void> {
  const { tenantId, instanceId } = params;
  const base = params.base ?? basePrisma;
  const threadId = chatwootThreadId(tenantId, instanceId, conversationId);
  const found = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inboxId,
        },
      },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return null;
    const conv = await db.conversation.findFirst({
      where: {
        tenantId,
        chatwootInstanceId: instanceId,
        chatwootConversationId: conversationId,
      },
      select: { id: true },
    });
    return conv ? { agentId: inbox.agentId, conversationDbId: conv.id } : null;
  });
  if (!found) return;
  await armNothingToAnswer({
    tenantId,
    instanceId,
    threadId,
    conversationId,
    conversationDbId: found.conversationDbId,
    agentId: found.agentId,
    agentBotId: params.agentBotId,
    triggerMessageId: params.event.message?.id ?? null,
    base,
  });
}

// Direct (no-debounce) entry: one incoming message → resolve the inbox's Agent → run the turn.
export async function runAgentTurn(
  params: RunAgentTurnParams,
): Promise<RunAgentTurnOutcome> {
  const { tenantId, instanceId, agentBotId, event: n } = params;
  const base = params.base ?? basePrisma;

  if (n.conversationId == null || n.inboxId == null) return "skipped";
  if (!isIncomingMessage(n)) return "skipped";
  // Rendered as the flush renders it; `incomingRenderable` is shared with the spend-ceiling
  // gate, which asks the same question before it refuses.
  const renderable = incomingRenderable(n);
  let text = renderInboundMessage(renderable);
  if (!text) {
    await armNothingToAnswerDirect(params, n.conversationId, n.inboxId);
    return "skipped";
  }
  const conversationId = n.conversationId;
  const inboxId = n.inboxId;
  const threadId = chatwootThreadId(tenantId, instanceId, conversationId);

  // NOTE: A message that quotes another re-renders with the quoted snippet, as the flush does.
  // Best-effort, and only a reply pays the extra fetch.
  if (n.message?.inReplyTo != null) {
    try {
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: params.deps?.makeClient,
      });
      const page = parseChatwootMessages(
        await client.getMessages(conversationId),
      );
      // NOTE: On upstream Chatwoot the meta write-back never lands, so a quoted voice note only
      // resolves to its transcription through the in-process overlay.
      overlayMediaAnnotations(tenantId, instanceId, page);
      const withQuote = renderInboundMessage(renderable, {
        resolveQuoted: buildQuoteResolver(page),
      });
      if (withQuote) text = withQuote;
    } catch (e) {
      logger.warn(
        "quote resolve failed (conv=%s): %s",
        String(conversationId),
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Binding and config are read in one scope and reported apart (the caller writes a `route`
  // line off the answer), so a rebind cannot land between two reads.
  const resolved = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const inbox = await db.inbox.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootInboxId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: inboxId,
        },
      },
      select: { agentId: true },
    });
    if (!inbox?.agentId) return { bound: false as const, config: null };
    return {
      bound: true as const,
      config: await loadAgentConfig(db, {
        tenantId,
        instanceId,
        conversationId,
        agentId: inbox.agentId,
        threadId,
        // NOTE: The instant of the message this turn answers, off the triggering payload.
        lastIncomingAt: n.message?.createdAt ?? null,
      }),
    };
  });
  if (!resolved.bound) return "no-agent";
  const loaded = resolved.config;
  // NOTE: Bound but not loadable (switched off, or the row is gone): not the silence above.
  if (!loaded) return "agent-unavailable";

  // Post gate, as on the flush: concurrent direct turns each generate a reply, and the stale
  // one must not post. This re-fetch asks whether something newer arrived or a person answered; the
  // claim below settles "already handled" and "someone else answering" together under one row lock.
  // A failed re-fetch is non-fatal.
  const triggerId = n.message?.id ?? null;
  const convDbId = loaded.conversationDbId;
  const shouldPost =
    triggerId !== null && convDbId !== null
      ? async (): Promise<PostVerdict> => {
          try {
            const client = await loadChatwootClient(tenantId, instanceId, {
              base,
              makeClient: params.deps?.makeClient,
            });
            const latest = parseChatwootMessages(
              await client.getMessages(conversationId),
            );
            // Asked by identity, not by comparing ids: a newer message another turn already
            // answered is not a customer waiting. The flush's own selector, so the two cannot drift.
            const state = await readSelectionState({
              tenantId,
              conversationDbId: convDbId,
              messageIds: pendingIncoming(latest, null).map((m) => m.id),
              base,
            });
            const open = selectOpenMessages({
              page: latest,
              scalarFloor: null,
              state,
              // NOTE: The loaded persona, which sends with `loaded.agentBotToken`, not the route's
              // bot: after a rebind, its own messages would read as a third party's.
              purpose: "reply",
              managedBotId: loaded.agentBotId,
              // NOTE: A reply typed on the paired phone has no sender; only the provider says whether
              // it is an agent or the echo of our own reply.
              whatsappProvider: loaded.whatsappProvider,
            });
            // Two questions: is anything newer still open, and did a person already answer
            // this trigger. The second is asked as the foreign-reply boundary, not as membership in
            // the open set, where a message another turn claimed is also missing and the claim decides.
            const openAbove = open.some((m) => m.id > triggerId);
            const answeredByOther =
              triggerId <=
              foreignReplyBoundary(latest, {
                managedBotId: loaded.agentBotId,
                whatsappProvider: loaded.whatsappProvider,
              });
            // NOTE: `openAbove` wins when both hold: the newer message's turn still decides the
            // whole burst, while a person's answer has nobody coming after it.
            if (openAbove) {
              logger.info(
                "direct turn: superseded mid-turn (conv=%s), deferring",
                String(conversationId),
              );
              return "newer-message";
            }
            if (answeredByOther) {
              logger.info(
                "direct turn: answered by somebody else (conv=%s), standing down",
                String(conversationId),
              );
              return "answered-by-other";
            }
          } catch (e) {
            logger.warn(
              "direct turn: supersede re-fetch failed (conv=%s): %s",
              String(conversationId),
              e instanceof Error ? e.message : String(e),
            );
          }
          return "post";
        }
      : undefined;

  const outcome = await runLoadedTurn({
    ...(params.onFoldedIn ? { onFoldedIn: params.onFoldedIn } : {}),
    // NOTE: The direct entry has nowhere to defer and a customer waiting, so it waits out a turn
    // already on the thread; joining it would send two replies, the second undoing the first's
    // channel.
    waitForThreadTurn: true,
    // NOTE: The ownership gate after the wait does not act on a voice note still awaiting its
    // transcription: standing down sends it to ingestion, whose dedup would then drop the late
    // transcription on the same id. The test is whether more content is coming, not whether the
    // message has words. See docs/graph.md, "Ownership after the thread wait".
    recheckOwnershipAfterWait: !awaitsTranscription(n),
    // NOTE: The direct path answers exactly one message, so the receipt set is that message.
    readMessageIds: typeof n.message?.id === "number" ? [n.message.id] : [],
    // NOTE: No job queued this turn, so the run is named by its episode, read off the message it
    // answers (./reset-episode.ts); a /reset then stops its tools. `null` without a mirrored
    // conversation, where nothing can reset it.
    stillWanted:
      convDbId === null
        ? null
        : stillInSameEpisode({
            tenantId,
            conversationDbId: convDbId,
            // NOTE: The id the supersede gate claims with: it names this run in the source's order.
            triggerMessageId: triggerId,
            base,
          }),
    loaded,
    authContext: params.authContext ?? null,
    tenantId,
    instanceId,
    conversationId,
    agentBotId,
    threadId,
    text,
    messageId: n.message?.id ?? undefined,
    userSentAudio: firstAudioAttachment(n) !== null,
    base,
    deps: params.deps,
    shouldPost,
    // NOTE: This turn answers one message, so that message is the burst it claims.
    claimReply:
      triggerId !== null && convDbId !== null
        ? {
            conversationDbId: convDbId,
            toMessageId: triggerId,
            messageIds: [triggerId],
            // NOTE: A webhook delivery is never a person pressing a button.
            initiatedBy: "automatic",
            // NOTE: A mark already covering this message means somebody else settled it.
            maxHandledAllowed: triggerId - 1,
          }
        : null,
  });
  // NOTE: Watermark tail for every outcome but two, read by exclusion (a word not named here
  // advances the mark). Left behind, the first flush after debounce is enabled re-answers the page.
  // "stale" advances too: on this path only /reset calls a run off and the ledger row settles as
  // consumed. "superseded" stays for the newer message's turn; "taken-over-unread" stays because
  // nobody read the message. Best-effort. See docs/graph.md, "The direct path's watermark".
  if (
    outcome !== "superseded" &&
    outcome !== "taken-over-unread" &&
    n.message?.id != null &&
    loaded.conversationDbId !== null
  ) {
    try {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: loaded.conversationDbId,
        toMessageId: n.message.id,
        // NOTE: What this turn closed without answering. A posted turn already wrote its claim row;
        // any other outcome here consumed the message deliberately and must record it by id, or it
        // reads as open and is answered again later.
        dispensed:
          outcome === "posted" || outcome === "posted-partial"
            ? { kind: "claimed" }
            : { kind: "messages", messageIds: [n.message.id] },
        base,
      });
    } catch (e) {
      logger.warn(
        "advance handled watermark failed (conv=%s): %s",
        String(conversationId),
        e instanceof Error ? e.message : String(e),
      );
    }
  }
  return outcome;
}
