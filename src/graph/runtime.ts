import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import type { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { mayCloseConversation, postedOutcomeFor } from "@/graph/close-intent";
import { withKeyedQueue } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { overlayMediaAnnotations } from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { describeClosedGate } from "@/modules/chatwoot/gate-close";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  buildQuoteResolver,
  maxIncomingId,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  firstAudioAttachment,
  incomingRenderable,
  isIncomingMessage,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import type { NormalizedChatwootEvent } from "@/modules/chatwoot/types";
import type { AuthContext } from "@/modules/contact-auth/check";
import { withAuthContextSection } from "@/modules/contact-auth/context";
import { recordConversationError } from "@/modules/conversations/error";
import {
  type ObservedConversation,
  observeBeforeClose,
  recordResolutionOrigin,
} from "@/modules/conversations/record-resolution";
import {
  advanceHandledWatermark,
  claimReplyBurst,
} from "@/modules/debounce/watermark";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  buildGuardrailGate,
  chatwootNoteSink,
  guardrailTripped,
  screenedText,
} from "@/modules/guardrails/gate";
import type { ImageFetchDeps } from "@/modules/images/fetch";
import { armCompaction } from "@/modules/memory/compact";
import { deliverReply, type ReplyDelivery } from "@/modules/split/service";
import { synthesizeReply } from "@/modules/tts/service";
import { shouldReplyWithAudio } from "@/modules/tts/settings";
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
import { lastAssistantText } from "./graph";
import { owesHandbackNote } from "./handback";
import { clearTurnInFlight, markTurnInFlight } from "./inflight";
import { drainPendingIngest } from "./ingest-drain";
import {
  conversationDividerMessage,
  conversationStamp,
  humanHandbackMessage,
} from "./markers";
import type { ResolvedModelConfig } from "./models";
import {
  type AgentConfig,
  buildCallbacks,
  buildModelAndGraph,
  buildSpeechNormalizer,
  buildToolset,
  loadAgentConfig,
} from "./prepare";
import { undoRefusedTurn } from "./refused-turn";
import { stillInSameEpisode } from "./reset-episode";
import { customerFacingReply } from "./silence";
import { AgentStatusReporter } from "./status";
import {
  clearTurnOwning,
  markTurnOwning,
  type ThreadOwner,
  type TurnHold,
} from "./thread-claim";
import { buildThreadStateGraph, THREAD_STATE_NODE } from "./thread-state";
import { ToolFlowLogger } from "./tool-flowlog";
import type { McpLoadDeps } from "./tools/mcp";
import {
  buildNativeTools,
  handoffAnsweredTheTurn,
  type TurnState,
} from "./tools/native";
import type { UsagePersist } from "./usage";

// The agent runtime: an incoming Chatwoot message (gate=act) → resolve the inbox's Agent config
// → build the model (key from the vault) → run the LangGraph thread (history persisted by the
// checkpointer keyed on the conversation) → re-check the live assignee → post the reply via the
// bot token. ALL network I/O is outside any transaction; the scoped reads are short and DB-only.
//
// runLoadedTurn is the shared tail used by BOTH entry points: the direct webhook path (runAgentTurn,
// one message) and the debounce flush (a coalesced burst). The flush passes a `shouldPost` hook so
// it can suppress the reply at the last moment (a newer message arrived during the LLM call → let
// the re-armed flush answer the full burst instead of double-replying).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export type RunAgentTurnOutcome =
  | "posted"
  // PART of what the turn promised reached the customer, and the rest is not coming (issue #429).
  // Everything that keys off "did this turn answer" reads it like "posted" — the burst is consumed,
  // the watermark advances, the ledger row is settled — because the customer HAS part of it and a
  // re-run would send that part twice. The one thing it must NOT do is clear the operator's error
  // badge, which is why it is a separate word instead of a boolean the callers would each have to
  // remember to ask for. Produced by `postedOutcomeFor` from the same two bits that decide whether
  // the turn may close the conversation.
  | "posted-partial"
  | "skipped"
  // NO AGENT IS BOUND to this inbox. The mirror creates a row for any inbox that sends traffic, so
  // this is the state a channel connected in Chatwoot and never bound here sits in, and the caller
  // reports it (issue #318). Its sibling below is the binding that EXISTS and cannot answer.
  | "no-agent"
  // Bound, and the config would not load: the agent is switched off (the common one, and deliberate)
  // or its row is gone. Same silence, different repair, and deliberately not the same word.
  | "agent-unavailable"
  | "empty"
  | "taken-over"
  // The run was CALLED OFF while it worked — today only by /reset retiring the job that queued it.
  // Distinct from "superseded" on purpose: both leave the watermark where it is, but superseded says
  // "a newer message will re-answer this burst" and this one says "the burst was withdrawn along
  // with the thread". Reading one bit for both questions is how a caller ends up re-arming work the
  // operator just cancelled.
  | "stale"
  | "superseded"
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
  // Injectable fetch for the contact-authorization check (tests); real fetch in production.
  contactAuthFetch?: typeof fetch;
  // Injectable download + SSRF assertion for send_image (tests); the real ones in production.
  imageDeps?: ImageFetchDeps;
  // Injectable for tests: where a document tool writes and reads its rendered PDF.
  documentsStorageDir?: string;
  // Injectable LLM speech normalizer (tests); production builds one from the agent's model when the
  // agent enables tts.normalize. Best-effort — synthesizeReply falls back to raw text on failure.
  normalizeSpeech?: (text: string) => Promise<string>;
  // Injectable sleep for the split/typing pacing (tests pass a no-op); real setTimeout otherwise.
  sleep?: (ms: number) => Promise<void>;
  // Injectable clock (tests); `new Date()` otherwise. The proactive path reads the wall clock in
  // exactly one place, the 24h service window, and that read has to be asserted on both sides of a
  // model call. A fixed sleep cannot assert it: the window is an hour at its narrowest, and a test
  // that leans on real time to cross the boundary passes for the wrong reason the moment the
  // machine is slow enough to cross it before the first read.
  now?: () => Date;
}

// THE BADGE FOR A DELIVERY THAT ENDED INCOMPLETE, written at the two sites that can produce one (a
// reply, attachments alone) so `"posted-partial"` is never a word without the line that explains it.
//
// It exists because the callers cannot write it: past the return the turn is a word, and both of
// them read that word as an answer and CLEAR the badge. Measured against a real Chatwoot before this
// existed — a reply whose second balloon failed and whose retry failed too came back "posted", the
// flush cleared `lastError`, and a customer holding one of three balloons sat on a conversation
// whose only operator-visible state said the last turn went fine. The cause stays in the flow log
// (`stage: "split"`, `outcome: "send_failed"`); this is the badge that sends an operator to look.
//
// Best-effort by contract (see recordConversationError): bookkeeping must never turn a half-answer
// that WAS delivered into a thrown turn.
async function notePartialDelivery(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  base: PrismaClient;
}): Promise<void> {
  await recordConversationError({
    tenantId: params.tenantId,
    instanceId: params.instanceId,
    chatwootConversationId: params.conversationId,
    error: new Error(
      "a entrega ficou incompleta: parte do que o turno prometeu não chegou ao cliente, e não será reenviada",
    ),
    base: params.base,
  });
}

export interface RunLoadedTurnParams {
  loaded: AgentConfig;
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
  // Optional turn correlation id. The debounce flush passes the same id it used for its own
  // `debounce` flow line, so the coalescing and the turn's stages group together in the logs.
  turnId?: string;
  // The user text to feed the graph (a single message, or the coalesced burst from a debounce flush).
  text: string;
  // Chatwoot id of the triggering message, surfaced to HTTP tools as {{message_id}}. Direct path: the
  // incoming message id; debounce flush: the burst watermark. Omitted ⇒ {{message_id}} stays unset.
  messageId?: number;
  // Whether the customer's turn included a voice note — drives the "mirror" TTS reply mode.
  userSentAudio?: boolean;
  base?: PrismaClient;
  deps?: RuntimeDeps;
  // Optional last-moment gate, called AFTER the assignee re-check and BEFORE the post. Returning
  // false suppresses the reply (outcome "superseded"). Used by the posting paths to drop a reply
  // when a newer message arrived mid-turn; the re-armed flush then answers the full burst. It is
  // the SUPERSEDE question only — the at-most-once claim is `claimReply` below, taken here rather
  // than by each caller.
  shouldPost?: () => Promise<boolean>;
  // WHICH BURST THIS TURN CLAIMS, and it is asked of every caller (nullable, never defaulted)
  // because the answer is what makes two posting paths exclusive. `null` says this turn posts
  // nothing anyone else could also post — the playground, and a direct turn with no mirrored
  // conversation or no triggering message.
  //
  // Claimed HERE and not by the caller: the claim's own correctness is that ONE column decides for
  // every path that sends, and a per-caller claim is how the flush and the manual re-engage came to
  // contend on different rows and both answer the same burst (issue #452). Whoever adds the next
  // posting path gets the protocol by construction, including the release.
  claimReply: {
    conversationDbId: bigint;
    toMessageId: number;
    // HOW FAR THE HANDLED WATERMARK MAY HAVE MOVED and this claim still stand — the second question
    // the claim settles, under the same row lock, because a skip landing between a separate read of
    // the watermark and the claim is exactly the window the CAS this replaced used to close for
    // free.
    //
    // A NUMBER rather than a flag, because the two kinds of caller differ by degree and not in kind
    // (issue #452). The direct turn and the flush answer messages ABOVE the mark, so anything at or
    // past their target says somebody else settled these: they pass `toMessageId - 1`. The manual
    // re-engage answers a tail the mark ALREADY covers — that is its whole job — but it is not
    // entitled to ignore a skip that lands while the model is running, so it passes the watermark it
    // read on the way IN — and null is THAT reading ("no mark was there"), not the absence of a
    // ceiling: any mark standing at claim time was written after the read and refuses the claim.
    maxHandledAllowed: number | null;
  } | null;
  // Whether the run that queued this turn is still wanted. Asked INSIDE the `ingest:` critical
  // section, and again immediately before each post — the two moments this function writes
  // something the customer or the next turn can see.
  //
  // It takes no `db`: the section is a process-local queue now rather than one pinned transaction,
  // so the ask opens its own short scope instead of borrowing an enclosing connection.
  //
  // `strict` says WHICH of the two questions is being asked, because they want opposite answers when
  // the read itself fails. Inside the critical section, before anything is written, an unreadable
  // answer must stop the run: guessing "still wanted" there recreates the state /reset just cleared,
  // and no later fence catches it. Everywhere else the ask guards a SEND, and throwing would abandon
  // the bookkeeping of a message already delivered, so an unreadable answer lets the run continue and
  // be fenced by the CAS at the end.
  //
  // REQUIRED and nullable rather than optional, because the compiler is the only thing that will ask
  // a future caller the question. `null` is the honest answer for a turn that arrives straight from
  // a webhook: there is no job to call it off, and nothing else names this run.
  stillWanted: ((opts: { strict: boolean }) => Promise<boolean>) | null;
}

// Applies a deferred resolve_conversation intent AFTER the reply is delivered. The tool only
// records the intent (see tools/native.ts TurnState): toggling mid-turn makes the webhook mirror
// flip Conversation.status before the recheck, which then reads our own resolve as a human
// takeover and discards the generated reply — and posting into a resolved conversation reopens
// it anyway (same invariant as nudge.ts applyPostActions). Invariant: called ONLY on the
// "posted" and "empty" outcomes; the intent is discarded on taken-over / superseded / blocked /
// throw. Best-effort, never throws: the reply is already out, so a failed toggle only leaves the
// conversation pending (flow warn pages the operator).
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
  },
): Promise<void> {
  if (!turnState.resolveRequested) return;
  turnState.resolveRequested = false;
  try {
    // NOTE: Read live before the toggle, not from `origin.observed`. That snapshot is the ownership
    // recheck's, taken BEFORE delivery, and delivery is not quick on this path: the output guardrail
    // is a model round-trip, TTS synthesises audio, and split delivery is typing-paced on purpose.
    // An operator or a timer closing in that window makes the toggle below a silent no-op, and the
    // stale value would credit the agent for their close.
    const observed = await observeBeforeClose(
      client,
      conversationId,
      origin.observed,
    );
    await client.toggleStatus(conversationId, "resolved");
    // NOTE: The one closing the Resolution funnel counts: the agent called resolve_conversation, so it
    // judged the customer's request handled. Every other way a conversation reaches "resolved" is
    // recorded under its own origin, or not at all when it happens outside our code.
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
}

// Delivers the files the agent queued this turn (an image, a document), AFTER the same gates the
// reply passes. Best-effort per file: one failed attachment must not cost the customer the reply that
// follows it. Invariant: called only on the "posted" and "empty" outcomes — a superseded, taken-over
// or blocked turn drops the queue, exactly like the deferred resolve intent.
//
// THREE answers, not one bit. "Did the customer receive something?" is what makes an
// attachment-only turn count as answered — but the caller also has to know WHY nothing arrived, and
// those are different events: a delivery that failed is a turn error the operator has to be told
// about (private note, lastError, alert), a document they revoked while the model was still writing
// is their own decision landing, and a run called off mid-batch is the operator clearing the
// conversation out from under it. One flag answered all three, so an attachment-only turn whose
// document the operator withdrew alerted them about their own click, and a /reset that landed
// between two pictures put `lastError` back on the conversation it had just cleared.
interface AttachmentDelivery {
  // Something reached the customer.
  sent: boolean;
  // At least one attachment was attempted and did not get through. Neither a revocation nor a
  // called-off run is a failure: nothing was attempted for either.
  failed: boolean;
  // The run was retired part-way through the batch, so the rest was never attempted. Read together
  // with `sent`, because what already left decides the turn's word: a batch stopped after its second
  // picture has delivered one, and reporting "stale" would hand the burst back to the next flush,
  // which would send that picture again.
  calledOff: boolean;
  // Another turn holds the reply claim on this burst, so the batch never started. Always with
  // `sent: false`: the ask is one statement before the first send, and the gate is memoized, so a
  // batch that delivered anything had already won the claim.
  lostClaim: boolean;
}

async function deliverPendingAttachments(
  client: ChatwootClient,
  conversationId: number,
  turnState: TurnState,
  flow: FlowContext,
  document?: { tenantId: bigint; base: PrismaClient },
  // Asked before EACH attachment, not once before the batch: every send here is a separate write
  // separated from the last by a Chatwoot round trip, so a run called off after the second file
  // would go on posting the third into a conversation the operator was told had been cleared.
  calledOff: () => Promise<boolean> = async () => false,
  // Asked immediately before the FIRST send of the batch, for the same reason `calledOff` is asked
  // before each one: a batch whose files were all revoked, or that never got to send, must not mark
  // the burst answered. Memoized by the caller, so the files after the first cost nothing.
  claimBeforeSend: () => Promise<boolean> = async () => true,
): Promise<AttachmentDelivery> {
  // NOTE: Sorted by the model's tool-call order, not by the order the downloads finished in — the
  // batch runs concurrently, and a caption only makes sense next to the picture it was written for.
  const queued = turnState.pendingAttachments
    .splice(0)
    .sort((a, b) => a.order - b.order);
  let sent = false;
  let failed = false;
  let stopped = false;
  let lostClaim = false;
  for (const file of queued) {
    // A document is queued as BYTES, and bytes cannot say whether the row is still deliverable. The
    // operator can revoke between the tool issuing it and this loop running — the model still had a
    // response to finish — and that window is seconds wide, which is where a revocation realistically
    // lands. Asked here, immediately before the send, because anywhere earlier widens it.
    //
    // WHAT IS NOT CLOSED, deliberately: the instant between this read and the HTTP request. The send
    // is a call to Chatwoot, not a write in our transaction, so no lock makes the two atomic — and a
    // lock held across it would make revocation, the operator's stop button, wait behind the very
    // system it is trying to stop. A revoke committing inside that instant delivers, and the document
    // is revoked from that moment on: the link stops serving it, which is the part that lasts.
    if (file.documentId && document) {
      // Fails CLOSED and, just as importantly, fails LOCALLY: a transient database error here must
      // not throw out of the loop, because the loop is also what delivers the model's text reply.
      // Losing an answer the customer was owed, over a lookup about an attachment, would be a worse
      // outcome than the one this check exists to prevent.
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
        // Two events wearing one shape. From here they look identical — nothing was delivered — and
        // they are not the same thing: `revoked` is the operator's own click arriving, and anything
        // else is this check being unable to answer (the lookup failed, or the row is gone). Only
        // the first is a decision.
        //
        // The bit the caller reads and the line the operator reads are decided HERE, together. They
        // were written as two statements once, and drifted: the turn counted the failure while the
        // trail reported an intentional revocation, so the one place an operator would look to find
        // out why the file never arrived told them somebody meant it.
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
    // ASKED LAST, after the revocation lookup rather than before it. THE RULE these asks follow
    // (./nudge.ts) is one ask per stretch of I/O that precedes a write, and never any I/O between an
    // ask and the write it guards — and the lookup above is I/O. Asking first and reading second
    // would put a database round trip inside the very window this exists to close.
    //
    // Reported back rather than folded into `sent`, because "nothing was delivered" now answers
    // three different questions: every attachment failed, the operator revoked one, or the run was
    // called off. The attachment-only branch throws on the first, which would put `lastError` back
    // on a conversation /reset had just cleared.
    if (await calledOff()) {
      stopped = true;
      break;
    }
    // AND THE CLAIM LAST OF ALL, after both asks above and one statement before the send: this is
    // the first thing in the turn that reaches the customer on an attachment-only answer, so it is
    // where the burst stops being anybody else's to answer.
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
        { caption: file.caption },
      );
      sent = true;
      emitFlowEvent(flow, {
        stage: "tool",
        status: "ok",
        // NOTE: the queueing tool, not a constant. An operator filtering the trail for the tool they
        // granted has to find the line it produced, and a document reported as send_image sends them
        // to the image host allowlist to debug a PDF read off our own disk.
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

// THE REPLY CLAIM, taken here because this is the tail every posting path shares (issue #452): the
// direct webhook turn, the debounce flush and the manual re-engage all arrive at this function, and
// at-most-once only holds while the three claim the same column.
//
// TAKEN BEFORE THE SEND AND NEVER GIVEN BACK, which is the contract this file already had when the
// claim was the watermark's own CAS: a burst is marked the moment a turn commits to answering it, so
// a send that fails leaves it marked and nothing re-answers it. That trades a lost reply for never
// sending a duplicate, deliberately and unchanged — the reply a customer already has cannot be taken
// back, while a burst nobody answered is exactly what `lastError`, the console's error badge and the
// re-engage button exist to surface.
//
// A release on failure was built here and then removed. It is a real improvement — a send that
// failed SHOULD become retryable — but it changes that trade for every posting path, which is a
// different change from this one, and five review rounds of consequences said so: which throws prove
// non-delivery, what "stale" means for a claim, what a restored predecessor does to a later retry,
// and whether an in-flight claim may be read as an answer. It belongs in an issue of its own.
export async function runLoadedTurn(
  params: RunLoadedTurnParams,
): Promise<RunAgentTurnOutcome> {
  const target = params.claimReply;
  if (!target) return runTurnBody(params);
  const base = params.base ?? basePrisma;
  // MEMOIZED, AND ASKED BY WHOEVER IS ABOUT TO SEND. Not by the supersede gate: that gate runs
  // before the output guardrail and before the empty-reply branch, so a claim taken there is taken
  // by turns that then say NOTHING — a guardrail silencing the reply, a model returning empty, a
  // batch whose only document was revoked. Marking those bursts answered is the reported bug wearing
  // a different cause: the tail stays unanswered and the operator's click can never reach it again.
  //
  // So the first site that is one statement away from a real send asks, and the answer stands for
  // the rest of the turn. That keeps the exclusion exactly as strong — two turns racing one burst
  // still meet in one atomic CAS, and the loser has sent nothing when it loses — while a turn that
  // never sends leaves the column untouched.
  let decided: boolean | null = null;
  const claimBeforeSend = async (): Promise<boolean> => {
    if (decided !== null) return decided;
    const claim = await claimReplyBurst({
      tenantId: params.tenantId,
      conversationDbId: target.conversationDbId,
      toMessageId: target.toMessageId,
      maxHandledAllowed: target.maxHandledAllowed,
      base,
    });
    if (!claim.won) {
      logger.info(
        "turn: %s (conv=%s target=%s), deferring",
        claim.reason === "handled"
          ? "the burst was already handled"
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

// Builds the client + tools + graph from an already-loaded AgentConfig, invokes the thread, re-checks
// the live assignee, optionally consults `shouldPost`, then posts via the bot token.
// The body's own input: `RunLoadedTurnParams` plus the gate the wrapper above built. It is not on
// the public type because no caller may supply it — the claim belongs to the wrapper, which is what
// makes it ONE column for every posting path. Absent (the playground, a turn with no triggering
// message) it stands aside and answers yes.
type RunTurnBodyParams = RunLoadedTurnParams & {
  claimBeforeSend?: () => Promise<boolean>;
};

async function runTurnBody(
  params: RunTurnBodyParams,
): Promise<RunAgentTurnOutcome> {
  // Every real send in this function is one statement after an ask on this. The default is what a
  // turn with nothing to be exclusive about wants: send.
  const claimBeforeSend = params.claimBeforeSend ?? (async () => true);
  // Applied HERE, before anything reads the config, so the prompt the model is built on, the one
  // the output guardrail judges adherence against, and the one the audited row records are the same
  // prompt. Appending it later, at the graph build, would leave the other two describing a turn
  // that did not happen.
  const loaded = withAuthContextSection(params.loaded, params.authContext);
  const { tenantId, instanceId, conversationId, agentBotId, threadId, text } =
    params;
  const base = params.base ?? basePrisma;

  // Execution-flow telemetry context: one turnId correlates every stage of this turn. Source is
  // real (inbox) traffic — warn/error stages may page an alert channel.
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

  // Load the client + tools (network, outside the tx). The bot token is the PERSONA's, so replies are
  // attributed to this persona's Agent Bot in Chatwoot.
  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    makeClient: params.deps?.makeClient,
    botToken: loaded.agentBotToken ?? undefined,
  });
  // The question, and it is asked AT each outward write rather than somewhere upstream of it. Four
  // review rounds found the same defect in four different places, and every one of them was an ask
  // that sat next to its effect when it was written and then had a round trip grow between the two:
  // the output guardrail, the supersede re-fetch, the speech normalizer, the synthesis call.
  // Adjacency is not something a call site can be trusted to keep — it has to be where the question
  // is asked.
  const writeCalledOff = async (): Promise<boolean> =>
    params.stillWanted !== null &&
    !(await params.stillWanted({ strict: false }));

  // The two gates that stand between this turn and a post, and neither is the fence — the fences are
  // the asks at the sends themselves. This is where a run that is already called off stops before
  // spending the rest of the turn on nobody.
  //
  // `stillWanted` first, and that is not the cheap-question-first reflex: `shouldPost` CLAIMS the
  // burst, advancing the handled watermark as its CAS. Asked only the other way round, a retired run
  // would declare a burst handled on its way to standing down — messages nothing ever answered,
  // marked as if something had.
  //
  // And asked AGAIN on the way out, because the ask above is not the fence: `shouldPost` re-fetches
  // the conversation from Chatwoot and then runs the CAS, so between the first answer and the
  // caller's send sits a round trip — the same shape as every other place this PR closed. The
  // supersede gate does not cover the window: a /reset typed on the ENTRY conversation retires the
  // WIDGET's flush (webhook.ts sweeps both sides of the pair), and the re-fetch reads the widget's
  // messages, where nothing new arrived.
  //
  // The second ask can only answer after the claim, so a burst retired in that window is consumed
  // without being answered — the outcome the first ask exists to avoid, accepted here because the
  // alternative is posting into a conversation the customer just reset. It is also not new: the
  // output-guardrail path has returned "stale" past this same claim since the ask after that model
  // call was added.
  const postBlocked = async (): Promise<"stale" | "superseded" | null> => {
    if (await writeCalledOff()) return "stale";
    if (params.shouldPost && !(await params.shouldPost())) return "superseded";
    if (await writeCalledOff()) return "stale";
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
  const handoffState = {
    customerMessage: null as string | null,
    completed: false,
  };
  const tools = await buildToolset(
    loaded,
    {
      tenantId,
      instanceId,
      base,
      client,
      conversationId,
      threadId,
      messageId: params.messageId,
      imageDeps: params.deps?.imageDeps,
      documentsStorageDir: params.deps?.documentsStorageDir,
      turnState,
      handoffState,
    },
    { buildNativeTools, mcp: params.deps?.mcp, flow },
  );

  // Build model + graph + cost/trace callbacks.
  const graph = await buildModelAndGraph(loaded, tools, {
    makeModel: params.deps?.makeModel,
    checkpointer: params.deps?.checkpointer,
    // Hard tool-call limit reached → surface a warn in the turn trail/Logs so the operator sees the
    // agent was forced to answer (vs silently looping or erroring with GraphRecursionError).
    onToolLimit: ({ maxToolCalls, toolCalls }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { toolLimitHit: maxToolCalls, toolCalls },
      }),
    // A turn recovered from an empty provider response must not read like a clean one: without this
    // line the fault is invisible and its rate (issue #63 measured 1 in 184 on one install) can
    // never be told apart from a turn that simply worked.
    onModelRetry: ({ attempt, provider, model }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        // NOTE: the retry can happen on either model, and the row names the one that made it. The
        // labels ride on the event rather than being defaulted here, so there is no default to get
        // wrong — which is what two of the four emitters did while they were optional.
        provider,
        model,
        detail: { retriedEmptyResponse: attempt },
      }),
    // A fallback that ANSWERS produces a successful turn, so nothing else on it would ever say the
    // primary was down: the reply went out, the customer was served, and the only trace would be a
    // usage row under another model's name. Warn rather than info — this is the operator's one
    // signal that a provider they are paying for is not taking their traffic.
    onModelFallback: ({ provider, model, reason }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        provider,
        model,
        detail: { fallbackFrom: loaded.mc.provider, fallbackReason: reason },
      }),
    // The turn's real ending when there was a second provider and it failed too. `error` rather
    // than `warn`: the customer got nothing. The stage line that wraps the call is labelled with the
    // primary by construction, so without this the last thing an operator reads is an error against
    // the model that never made the second call.
    // ATTRIBUTION, NOT A SECOND ALARM, which is why this one line is `info` while the failure it
    // describes is an error. The `generate` stage this call sits inside emits its OWN error when the
    // turn throws, and alert coalescing keys on (channel, stage, level): two `generate`/`error` events
    // for one failed turn bump one delivery to "×2" — or, losing the race on the coalesce window, send
    // two — so the operator is paged twice for one outage and the Logs show two errors for one failure.
    // The stage owns the alarm; this line exists only to say WHICH model died, because the stage is
    // labelled with the primary by construction and would otherwise blame the model that never made
    // the second call. `status` stays "error": the call did fail.
    onModelFallbackFailed: ({ provider, model, reason }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "info",
        status: "error",
        provider,
        model,
        detail: { fallbackFailed: reason },
      }),
    // The mirror image, and it fires BEFORE any failure: a fallback the operator configured and that
    // cannot be built leaves the turn with nothing behind it, which is indistinguishable from having
    // configured none. Reported once per turn build rather than on the failure, because by then it
    // is too late to be the warning it needs to be.
    onModelFallbackUnavailable: ({ provider, model, reason }) =>
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        provider,
        model,
        detail: { fallbackUnavailable: reason },
      }),
    // The history ceiling dropped older attendances from this turn. INFO, not warn: emitFlowEvent
    // fans warn/error out to the alert channels, and a correctly configured ceiling trims on nearly
    // every turn of a long thread, so a warn here would page the operator forever for working.
    // Counts only, never a fragment of what was dropped.
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
    // Same id as the ExecutionLog turn → the Langfuse trace correlates 1:1 with our Logs.
    turnId: flow.turnId,
    tools,
  });

  // Per-CONTACT-INBOX memory: the graph thread spans the conversations a contact has on ONE channel
  // (continuity, without mixing parallel channels), while the per-conversation threadId stays the
  // flow/debounce/watermark key. When a NEW conversation reuses the thread, prepend a divider so the
  // model treats it as a fresh attendance.
  const graphThreadId = resolveGraphThreadId(
    tenantId,
    instanceId,
    conversationId,
    loaded.contactInboxId,
  );

  // The live "agent is working" indicator on the per-tenant realtime channel:
  // `started` before the first token (instant feedback), `step` events from the
  // graph callbacks (thinking / tool), and a GUARANTEED `finished` in the finally
  // (every exit — posted, empty, taken-over, superseded, or thrown — clears it).
  const status = new AgentStatusReporter({
    tenantId,
    conversationDbId: loaded.conversationDbId,
  });
  // Logs each tool call (name/status/duration) under this turn's flow group.
  const toolLogger = new ToolFlowLogger(flow, {
    logValues: loaded.logToolValues,
    tools,
  });

  // Guardrails (input/output moderation): one gate, shared with the proactive path (see
  // modules/guardrails/gate.ts). A trip logs a `guardrail` flow line (warn → may alert) + posts a
  // private operator note, so a blocked/replaced reply is never invisible.
  const runGuardrail = buildGuardrailGate({
    cfg: loaded.guardrails,
    apiKey: loaded.guardrailsApiKey,
    credentialBaseUrl: loaded.guardrailsCredentialBaseUrl,
    announce: chatwootNoteSink(client, conversationId),
    flow,
    systemPrompt: loaded.systemPrompt,
    // The raw inbound text, not `turnText`: on the first turn of a new conversation the latter
    // carries CONVERSATION_DIVIDER, and handing the guardrail a system marker as the customer's
    // words would make it judge the reply against something nobody said.
    customerMessage: text,
    makeModel: params.deps?.makeModel,
    // The same sink the turn's own callbacks use. A test that injects one and leaves guardrails on
    // would otherwise capture the agent's row and send the guardrail's to the real database.
    persistUsage: params.deps?.persistUsage,
  });

  // One piece of customer-facing text, delivered the way this agent delivers text: as audio when the
  // modality calls for it, otherwise split into typing-paced balloons. Returns how many balloons
  // landed (1 for audio) AND whether part of the reply is missing — `deliverReply` no longer reports
  // a partial send by throwing (issue #429), so the two have to travel together for the callers
  // below to keep deciding what a total failure means. TTS is best-effort — a synthesis failure
  // falls back to text and never drops the message.
  const deliverText = async (
    text: string,
    voiceReply: boolean | null,
  ): Promise<ReplyDelivery | "stale" | "superseded"> => {
    const wantAudio = shouldReplyWithAudio(
      loaded.ttsConfig.mode,
      params.userSentAudio ?? false,
      voiceReply,
    );
    if (wantAudio) {
      try {
        // Opt-in LLM speech normalization (or the injected normalizer in tests). Its callbacks are
        // built fresh rather than reusing this turn's array: same usage/trace identity, different
        // node and model, and a nested Langfuse generation instead of a second root update.
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
          text,
          channelType: loaded.channelType,
          base,
          deps: { fetchImpl: params.deps?.ttsFetch, normalizeSpeech },
          flow,
        });
        // Synthesis is a network call of its own, and the speech normalizer above it is a MODEL
        // call, so an answer taken before them is an answer about a different moment.
        if (await writeCalledOff()) return "stale";
        if (tts) {
          if (!(await claimBeforeSend())) return "superseded";
          await client.sendAudioMessage(
            conversationId,
            tts.audio,
            tts.fileName,
            tts.mime,
            { transcribedText: text },
          );
          logger.info(
            "chatwoot agent replied (audio): conv=%s thread=%s len=%d",
            String(conversationId),
            threadId,
            text.length,
          );
          return { delivered: 1, failed: false };
        }
      } catch (e) {
        logger.warn(
          "tts failed (conv=%s), falling back to text: %s",
          String(conversationId),
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    // And again for the text path, which is reached either directly or after the whole TTS attempt
    // above has failed and fallen through — the longest wait of the two.
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

  // How many balloons the (text) reply was delivered as, surfaced on `finished` so the UI can hold a
  // "delivering" indicator until the paced balloons land. 1 for audio / single send; null on no post.
  let deliveredBalloons: number | null = null;

  // The sentence the transfer promised the customer, delivered on the way OUT of the turn — whatever
  // the way out is. Nothing downstream may take it back, and nothing downstream can be retried into
  // sending it: the conversation reads `open` from the moment the tool set it, so every later
  // attempt stops at its own ownership gate. Four findings on this change were this one loss
  // arriving through four different failures, which is why the delivery sits outside the flow
  // instead of each failure getting a fence.
  //
  // Two call sites, and they are exclusive: the failure path always rethrows, so the normal one is
  // unreachable after it. Anything that adds a third owns the at-most-once question, because a
  // promise delivered twice is the duplicate #158 was about.
  // The contact's voice preference as of NOW. `set_voice_preference` writes it DURING the invoke, so
  // the pre-turn snapshot is stale for a customer who asked for audio in the very turn that handed
  // them over — the reply path already rereads it (inside the ownership recheck below, in that
  // read's transaction), and the closing line has the same claim to the fresh value.
  //
  // Best-effort, which is the difference from that one: this read sits on the path that must not
  // fail. The promised sentence has to leave even when the database will not answer, so a failure
  // falls back to the snapshot instead of ending the turn.
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

  const deliverHandoffPromise = async (): Promise<void> => {
    if (!handoffAnsweredTheTurn(handoffState)) return;
    const line = handoffState.customerMessage;
    try {
      const guarded = await runGuardrail("output", line);
      // A trip here drops the turn's queued images, which is the rule the main gate below already
      // keeps ("the safe reply replaces what the model wrote, images included"). The closing line is
      // screened on its own because it leaves before that gate, but a verdict on this turn's
      // customer-facing text means the same thing wherever it is reached: a `silent` action that
      // suppressed the goodbye and then let a photo through would be the operator's policy applied
      // to one artefact and not the other.
      if (guardrailTripped(guarded)) turnState.pendingAttachments.length = 0;
      const screened = screenedText(guarded, line);
      if (screened === null) return;
      const delivered = await deliverText(screened, await currentVoiceReply());
      // The closing line the transfer already promised, and the one send this turn makes that no
      // later gate can catch — it leaves before them. A run called off during the model call reaches
      // exactly here, so this is where it stops. The transfer itself stays done: the tool ran, the
      // conversation is the human queue's, and withholding the sentence is the part still ours.
      //
      // NOTE: a partial send is not raised here, unlike the reply path below. This whole delivery is
      // best-effort by design (the catch around it says why), so a missing half of the goodbye must
      // not become a turn error on a conversation that was answered and correctly handed over.
      // "superseded" here means another turn holds the claim on this burst, so nothing was sent and
      // there is nothing to report: the transfer itself already happened, and the sentence is the
      // only part that was still ours to withhold.
      if (
        delivered === "stale" ||
        delivered === "superseded" ||
        delivered.delivered === 0
      )
        return;
      deliveredBalloons = delivered.delivered;
    } catch (e) {
      // Best-effort, the semantics the line had while the tool sent it. The transfer succeeded, so
      // branding the turn as errored would stamp lastError and announce "a human has to take over"
      // on a thread a human already owns — and on the failure path this must never mask the error
      // that actually ended the turn.
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
  // Mark this conversation's turn as in-flight so a concurrently-fired follow-up backs off instead
  // of nudging mid-turn (cleared in the finally on every exit). See ./inflight.
  markTurnInFlight(threadId);
  // Released in the `finally` below, which is why the claim below lives INSIDE this try and not
  // above it: `getCheckpointer`, the divider write and the marker upsert can all throw, and a claim
  // that outlives its turn keeps every follow-up and every compaction for this contact backing off
  // until the process restarts.
  // The thread this turn holds against a concurrent append, DURABLY (issue #203). Null until the
  // claim is taken, and it is what the `finally` releases: the contact-inbox id it needs goes out of
  // scope long before then.
  let graphOwner: ThreadOwner | null = null;
  let graphHold: TurnHold | null = null;
  // Set inside the `ingest:` lock when the ask below says this run was called off. A flag and not a
  // throw: the lock's transaction has to commit and release before this function can return.
  let calledOff = false;
  // What the turn produced, kept when the TOKEN silenced it, and consumed in the `finally` once the
  // in-flight flag the rollback refuses on has been released. The messages travel rather than a
  // boolean because the rollback runs outside the scope that has them.
  let silenceProduced: BaseMessage[] | null = null;
  // Set when the hand-back note was OWED and could not be appended durably, because an older invoke
  // was reading the channel. It then rides in this turn's own invoke input instead (issue #457,
  // review round 6): deferring the durable write is right, but deferring the CORRECTION would leave
  // this turn reading a transfer with no ending — which is the silence this whole PR is about, on
  // the first turn after the return, for the customer who is waiting right now.
  let handbackDeferred = false;
  // WHO OWNS IT ACCORDING TO THE MIRROR, RIGHT NOW (issue #457, review round 7). The receiver's gate
  // proved bot ownership before this turn was queued, and the note is written much later — after the
  // toolset is built, after the ingestion drain, and after a claim that WAITS on an append's lease
  // and on the row lock a /reset holds. A person taking the conversation over inside that window
  // leaves the gate's answer saying the bot owns it, and the note would then state that a human
  // attendance ended while the human is in it. The post-generation recheck suppresses the SEND and
  // cannot unwrite a message. Same read that recheck makes, asked at the moment this writes; a read
  // that fails leaves the note OWED, which costs nothing because nothing is consumed to write it.
  const botOwnsItNow = async (): Promise<boolean> =>
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
    }).catch((err) => {
      logger.warn(
        { err, conv: conversationId },
        "hand-back note: ownership read failed; leaving the note owed",
      );
      return false;
    });
  try {
    // ── Attendance boundary. A NEW conversation reusing this contact-inbox thread gets the
    //    "fresh attendance" divider, and the attendance it replaced becomes compactable.
    //
    //    Claimed ATOMICALLY, and the divider written as its own message rather than smuggled into the
    //    customer's turn text, because the three things have to be all-or-nothing:
    //
    //      - Two deliveries for the same new conversation can run at once (debounce off is the common
    //        setup). Both would read the same marker and both would prepend a divider; compaction cuts
    //        at the LAST one, so the first exchange of the OPEN attendance would be summarized away as
    //        if it had ended. The lock — the same one ingestion takes on this thread — makes exactly
    //        one turn the claimant.
    //      - The marker must not advance without the divider landing. It used to advance here while
    //        the divider only reached the checkpointer if the invoke ran, so an input guardrail that
    //        answered before the model, or a throw, left a boundary nothing could ever find again.
    //        Writing the divider inside the claim removes the dependency on the turn succeeding.
    //      - And with the divider durable at claim time, compaction can be armed right here instead of
    //        waiting for the invoke.
    //
    //    The divider being its own message (the ingestion mechanism, same graph) is also why the
    //    guardrails now see the customer's raw words on BOTH directions: there is no longer a turn text
    //    carrying a system marker the customer never wrote.
    if (loaded.contactInboxId != null) {
      const contactInboxId = loaded.contactInboxId;
      // BARRIER (issue #194). Continuous ingestion is a queued job now, so a message the agent stayed
      // silent on may still be a row rather than a turn in this thread. Folded in here, BEFORE the
      // lock and the in-flight claim below: the drain takes that same lock, and it is also the last
      // moment at which the append is not the thing this turn erases.
      //
      // Its outcome is DISCARDED, and only here and at the nudge. A turn that finds ingestion still
      // owed has nowhere to wait — a customer is holding the line, and the message it is missing
      // reaches the thread for the next turn. Compaction consults the same answer and refuses to
      // read on it, because there the same message is summarised out of existence.
      await drainPendingIngest(tenantId, graphThreadId, base);
      const checkpointerForDivider =
        params.deps?.checkpointer ?? (await getCheckpointer());
      const dividerGraph = buildThreadStateGraph(checkpointerForDivider);
      // Serialized by the process-local queue, not by a transaction-scoped advisory lock. The
      // section below spans the checkpointer, which is a SEPARATE Postgres pool, and holding a Prisma
      // transaction open across it drained the main pool and made every other query in the process
      // wait out `maxWait` (issue #225). The reads and the write are short transactions of their own
      // now; the ordering between them is what the queue provides.
      const closedConversationId = await withKeyedQueue(
        `ingest:${graphThreadId}`,
        async () => {
          // THE ASK, and this is the boundary it belongs at: everything below writes — the divider
          // is a real message, the claim arms compaction, and the invoke that follows persists the
          // channel. A turn queued by a job the command retired must not recreate the thread the
          // command just cleared, with input from before it.
          //
          // Still inside the critical section, which is what the exclusion needs; what changed is
          // that the section is no longer one pinned transaction. The reason #202 gave for running
          // this on the enclosing transaction's connection was that `runScopedOn` had pinned it and
          // a nested scope would ask the pool for a second one and time out under `DB_POOL_MAX=1`.
          // With the queue there is no enclosing transaction to nest inside, so the ask opens its
          // own short one and the hazard it was avoiding cannot arise.
          if (
            params.stillWanted &&
            !(await params.stillWanted({ strict: true }))
          ) {
            calledOff = true;
            return null;
          }
          // Per-THREAD marker (AgentThread keyed by contact-inbox): a different display_id ⇒ a new
          // conversation reusing the thread. Per-thread and not per-contact, so a multi-channel
          // contact never gets a spurious divider from activity on another channel.
          const key = {
            tenantId_chatwootInstanceId_contactInboxId: {
              tenantId,
              chatwootInstanceId: instanceId,
              contactInboxId,
            },
          };
          // Claim the thread against a memory-compaction rewrite, inside the critical section the
          // rewrite also enters while it checks. That makes the two exclusive rather than merely
          // staggered: the rewrite either completes before this claim, and the invoke below then
          // loads the rewritten channel, or it finds the thread claimed and stands down. Claimed for
          // EVERY turn, not only the ones that cross a boundary, because what has to be excluded is
          // the invoke, and every turn has one. Released in the `finally` below, on every exit.
          // Taken in the ROW as well as in this process, so a replica that does not share this Map
          // still reads the thread as busy. It also WAITS OUT an append in flight, which is what
          // makes the two exclusive rather than merely staggered across processes: the append's
          // check and its write are not one step (../graph/thread-claim.ts).
          const owner = { tenantId, instanceId, contactInboxId, graphThreadId };
          graphHold = await markTurnOwning(owner, base);
          graphOwner = owner;
          // ASKED AGAIN, because the claim above can WAIT. The ask before it is still the right
          // first ask (a run already retired takes no claim it would have to release), but
          // `markTurnOwning` blocks on an append's lease and on the row lock /reset itself takes,
          // so by the time the claim lands its answer can be dozens of seconds old. The lock case
          // is not merely possible, it is ORDERED: a reset holding that row releases it straight
          // into this waiter, so the turn resumes IMMEDIATELY after the clear and writes the
          // divider and the marker back over it, arming compaction on a thread the operator was
          // told was cleared. Everything below writes, so this is the last moment the question is
          // still about a turn that has written nothing. The `finally` releases the claim:
          // `graphOwner` is set above.
          if (
            params.stillWanted &&
            !(await params.stillWanted({ strict: true }))
          ) {
            calledOff = true;
            return null;
          }
          // READ AFTER THE CLAIM, never before it. `markTurnOwning` can wait out an append that is
          // mid-flight on another replica, and that append writes exactly these markers: a row read
          // before the wait is stale by the time it is used, and writing it back walks
          // `lastSyncedMessageId` backwards, which is the frontier regression the markers exist to
          // prevent. Whether ANOTHER invoke was already reading comes from the claim itself, for the
          // reason ../graph/thread-claim.ts gives: two replicas starting together both read "nobody"
          // if they ask separately.
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
          // THE HAND-BACK NOTE, and this is the turn that owes it (issue #457): the conversation is
          // back with the bot — it got here, so the gate said so — and the thread still reads as if a
          // person were handling it. Written here rather than when ownership changed, for three
          // reasons: an ownership change that never leads to a turn owes no note; here it lands
          // BEFORE the customer's message, which is the order the model has to read it in; and this
          // is inside the same section that guards the divider, so it cannot be erased by an invoke
          // that started earlier.
          //
          // Whether it is owed is DERIVED from the channel (./handback.ts), never from a column
          // tracking ownership: the evidence is what the model itself is looking at, and the note
          // sitting after it is what makes a second announcement impossible.
          const channelNow = (
            (
              await dividerGraph.getState({
                configurable: { thread_id: graphThreadId },
              })
            ).values as { messages?: BaseMessage[] } | undefined
          )?.messages;
          // DEFERRED WHILE ANOTHER INVOKE IS READING, the same rule the divider follows and for the
          // same reason: that invoke saves the channel it LOADED, so a note appended beside it is
          // erased. Deferring costs nothing here, and that is the derived model paying off — there
          // is no marker to advance and nothing to lose, so the next turn asks the same question of
          // the same thread and writes it then.
          if (
            owesHandbackNote(channelNow ?? []) &&
            // Asked LAST, after the channel read above: that read is a round trip to the
            // checkpointer's own store, and a takeover during it would make an earlier answer stale
            // in exactly the same way.
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
          // THE TURN RECORDS THE INBOUND ID IT HANDLED (issue #194). Ingestion decides whether an
          // out-of-order message may still speak for the thread's attendance by comparing it with
          // the newest inbound id the thread has seen (./attendance-boundary.ts,
          // movesAttendanceFrontier), and this writer used to leave no id at all — so the frontier
          // was blind to the most ordinary way a new attendance opens, which is the customer
          // writing and the bot ANSWERING. A delayed message from the previous conversation then
          // compared newer than a stale mark, walked the marker back and armed compaction for the
          // conversation being served.
          //
          // ON EVERY HANDLED TURN, and `lastConversationId` alone stays conditional. An earlier
          // round cut this back to boundaries only, reasoning that the frontier merely suppresses a
          // boundary claim — which was already false by then, because the same change had given it
          // a second job: it also decides whether the message may carry an attendance STAMP. And
          // `advanceMarker` is false in two different situations, not one. The second is a boundary
          // DEFERRED because another invoke is reading (./attendance-boundary.ts, case 1): the
          // conversation really is new, this turn really is handling its first message, and the
          // marker deliberately stays behind. Recording nothing there leaves the frontier back in
          // the previous attendance, so a delayed message from it reads as current, stamps itself
          // at the end of the channel, and the compaction cut then treats the live conversation as
          // the closed prefix.
          //
          // The scalar only. `recentSyncedMessageIds` is ingestion's own ledger of what IT folded
          // in, and the two never overlap by construction — a message a turn answers is never
          // ingested (../modules/chatwoot/webhook.ts) — so putting a turn's id in that set would
          // describe an append that never happened.
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
      // Out here, where the lock's transaction has committed: nothing was claimed, nothing was
      // written, and the thread stays as the command left it.
      if (calledOff) {
        logger.info(
          "turn: the run was retired while it worked (conv=%s), standing down",
          String(conversationId),
        );
        return "stale";
      }
      if (closedConversationId !== null) {
        // Outside the lock: this opens its own transaction, and nesting one inside an advisory-lock
        // transaction would hold that lock across a second connection's work.
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
      // THE CONVERSATION-KEYED FALLBACK THREAD, which has none of the bookkeeping above: no
      // ingestion barrier, no claim, no divider. It still carries the one piece of evidence this
      // decision needs, because a successful handoff is written by the turn's OWN invoke whatever
      // the thread is keyed by — so leaving it out would leave issue #457 unfixed on a path the
      // runtime supports.
      //
      // Best-effort, and the derived model is what makes that acceptable: with no claim there is no
      // way to know whether another invoke is reading, so a note appended here can be erased — and
      // the next turn asks the same question of the same thread and writes it again. Nothing is
      // consumed, so nothing is lost.
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

    // INPUT guardrail: screen the customer message BEFORE the agent processes it. On a violation,
    // send the configured template / a guardrails-generated safe reply and skip the graph, or stay
    // silent (send nothing). Anything short of a trip proceeds as normal — including a screening
    // that could not run, which is the fail-open half of the policy.
    const inGuard = await runGuardrail("input", text);
    // Asked on the way OUT of the screening, not only before the send it may lead to. The verdict
    // costs a model call, and its silent branch returns "blocked" — a word that says the burst was
    // consumed, so the watermark advances. A run the command called off during that call would be
    // the one path that reports a retired burst as handled.
    if (await writeCalledOff()) return "stale";
    if (guardrailTripped(inGuard)) {
      const inReply = screenedText(inGuard, text);
      if (inReply !== null) {
        // NOTE: The guardrail reply is a post like any other, so it passes the same two gates:
        // without them, two concurrent deliveries that both trip the guardrail each post their
        // template, and a stale one posts over newer customer input. The claim is asked second and
        // last, one statement before the send.
        const blocked = await postBlocked();
        if (blocked) return blocked;
        if (!(await claimBeforeSend())) return "superseded";
        await client.sendMessage(conversationId, inReply);
        deliveredBalloons = 1;
        return "posted";
      }
      return "blocked";
    }

    // The second ask, and it is not a repeat of the one inside the lock: that one guards the divider
    // and the claim, this one guards the INVOKE, which persists the channel. Between them sit the
    // state read, the toolset build and the prompt resolution, and on a conversation with no
    // contact-inbox the lock block does not run at all — so an invoke that inherited the lock's
    // answer would be a turn fenced only where it happens to have been convenient.
    if (params.stillWanted && !(await params.stillWanted({ strict: false }))) {
      logger.info(
        "turn: the run was retired before the invoke (conv=%s), standing down",
        String(conversationId),
      );
      return "stale";
    }

    // Invoke the thread (network: LLM + any tool calls). The checkpointer resumes prior history.
    //
    // Wrapped so a throw from INSIDE the graph still delivers what a handoff already promised: the
    // tool can complete the transfer and the model's next step can then fail, and the exception
    // leaves through here with the line still unsent and no later attempt able to send it.
    // RE-DERIVED IMMEDIATELY BEFORE THE INVOKE (issue #457, review round 10). Between the decision
    // above and here, the other invoke — the one this deferred to — can finish and append the note
    // itself. Carrying ours as well would put two of them in the channel, which is the idempotence
    // this design promises. The question is the same one, asked of the thread as it is now: if the
    // note is there, nothing is owed and nothing is carried.
    //
    // It NARROWS the window rather than closing it: the invoke below loads the channel again, so an
    // append landing between this read and that load is still possible. The remaining duplicate is
    // two identical system notes, and nothing consumes either.
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
    const result = await withFlowStage(
      flow,
      "generate",
      {
        provider: loaded.mc.provider,
        model: loaded.mc.model,
        // The prompt the agent was given THIS turn (item 15), audited: the RESOLVED one is not the
        // tenant's own config, it is where the contact's name, phone and attributes entered. See
        // prompt-audit.ts.
        detail: { systemPrompt: loaded.systemPromptAudit },
      },
      () =>
        graph.invoke(
          {
            messages: [
              // The deferred hand-back note, carried by the invoke that owes it rather than by a
              // durable append beside an older invoke that would erase it. BEFORE the customer's
              // message, which is the order the model has to read it in, and durable only insofar as
              // this invoke's own write survives — if it does not, nothing was consumed and the next
              // turn asks the same question of the same thread.
              ...(carriedHandback
                ? [humanHandbackMessage(conversationId)]
                : []),
              // Stamped with the conversation it belongs to: that stamp, not the divider, is what the
              // compaction cut reads to find where this attendance starts.
              new HumanMessage({
                content: text,
                additional_kwargs: conversationStamp(conversationId),
              }),
            ],
          },
          {
            configurable: { thread_id: graphThreadId },
            callbacks: [...callbacks, status, toolLogger],
          },
        ),
    ).catch(async (e) => {
      await deliverHandoffPromise();
      throw e;
    });
    // EVERY REFUSAL FROM HERE DOWN GOES OUT THROUGH THIS, and the fence in
    // tests/graph/refused-turn-callsites.test.ts is what keeps that true.
    //
    // The invoke above checkpointed as it ran, so the customer's message and the assistant's answer
    // are in the thread's history the moment it returned. Everything below suppresses the SEND and
    // nothing removes what was written: an operator took the conversation, a newer message arrived
    // mid-turn, a `/reset` retired the run, the output guardrail replaced the reply with nothing. The
    // customer never received it and the next turn reads it as something they were told — on
    // `superseded` that next turn is guaranteed, because the re-armed flush answers the whole burst
    // with the abandoned reply already in its context (issue #315).
    //
    // It never decides WHETHER to roll back: `undoRefusedTurn` reads the channel and answers that,
    // so a refusal is one word here and the judgement lives in one place.
    const refuse = async (
      outcome: RunAgentTurnOutcome,
    ): Promise<RunAgentTurnOutcome> => {
      const plan = await undoRefusedTurn({
        checkpointer: params.deps?.checkpointer ?? (await getCheckpointer()),
        graphThreadId,
        produced: result.messages,
        kind: "reactive",
      }).catch((err) => {
        // NOTE: best-effort, and loudly. The send was already suppressed, so a failed rollback costs
        // the next turn a message the customer never saw — the defect this exists to close, and
        // nothing more. Throwing would turn a correct refusal into a retried turn.
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
        // NOTE: the one keep that is a MISS rather than a decision about this turn. The history still
        // holds a message the customer never received. Logged at warn so the case has a name instead
        // of looking like a rollback that ran.
        logger.warn(
          "turn could not roll back a refused turn, another invoke holds the thread: conv=%s outcome=%s",
          String(conversationId),
          outcome,
        );
      }
      return outcome;
    };
    // The follow-up's silence token is not vocabulary of this path, but it IS in this thread: the
    // memory is keyed per contact-inbox, so every silent follow-up leaves an assistant turn whose
    // whole content is the token, and the model reproduces it here (issue #454). Reduced to it, the
    // reply is silence — the shape `skip_reply` produces, and the one the `!reply` branch below
    // already handles; carrying it, the reply keeps its text and loses the token. Before the output
    // guardrail on purpose: the judge would otherwise be asked to screen a marker as if it were
    // something the agent wrote for the customer.
    const drafted = customerFacingReply(lastAssistantText(result.messages));
    let reply = drafted.text;
    // NOTE: Silence the operator can explain. `skip_reply` records itself in the timeline, and a turn that
    // went quiet because the model emitted the token would otherwise be indistinguishable from the
    // agent ignoring a customer who is waiting.
    if (drafted.bySentinel) {
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { silenceTokenSuppressed: true },
      });
      // NOTE: ...and the turn must not leave the token behind, or the defect FEEDS itself: the raw message
      // is already checkpointed (graph.invoke persisted it before this line), the thread is shared
      // per contact-inbox, and the next turn reads one more sentinel answer — reinforcing exactly the
      // condition that produced this one.
      //
      // ARMED here and run in the `finally`, not called here, and that is not tidiness: the rollback
      // takes the ingest queue and REFUSES while `isTurnInFlight` holds, which is this very turn.
      // Called inline it returns `keep` every time and silently does nothing — measured, the message
      // stayed in the channel with the test green on everything else.
      silenceProduced = result.messages as BaseMessage[];
    }
    // NOTE: The other half, and it exists because the rule REFUSES to edit the token out of a real answer
    // (that is the data loss `docs/graph.md` prohibits). So the reply goes out carrying it, and the
    // operator hears about it here rather than from the customer — a cosmetic leak that is reported
    // is a different thing from one that is silent.
    if (drafted.carriesToken) {
      emitFlowEvent(flow, {
        stage: "generate",
        level: "warn",
        status: "ok",
        detail: { silenceTokenInReply: true },
      });
    }

    // The deferred resolve falls with the TRANSFER, not with the suppression of the final text: a
    // conversation the human queue now owns is not ours to close, and that holds even when the
    // closing line never reached the customer. The two questions have different answers exactly
    // there.
    if (handoffState.completed) turnState.resolveRequested = false;
    const handedOff = handoffAnsweredTheTurn(handoffState);
    // The model's own final text after a handoff is a second copy of a line the customer is about to
    // read (#158), and the mirror recheck below cannot catch it: Chatwoot's open/assignee event may
    // still be in flight and the row still reads bot-owned. Blanked rather than returned early, so
    // everything ELSE the turn produced still passes every gate below — a queued image is not a
    // duplicate of anything, and its caption is model-written customer-facing text the output
    // guardrail has to screen.
    if (handedOff) reply = "";
    await deliverHandoffPromise();

    // Re-check the live assignee (mirror) before posting: a human may have taken over during
    // the LLM call. NOTE: small TOCTOU between this read and the POST (the post is network and
    // cannot share the tx); acceptable for the single-replica MVP.
    const ourBot = loaded.agentBotId ?? agentBotId;
    // Re-read the live assignee AND the contact's current voice preference in the same scoped read.
    // set_voice_preference writes Contact.voiceReply DURING the invoke, so the pre-turn snapshot
    // (loaded.contactVoiceReply) is stale — using the fresh value lets "prefiro texto" take effect in
    // THIS same turn instead of only the next one.
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
        // Carried out so the discard below can say WHY ownership was lost. Read here rather than
        // re-read there: a second query would answer about a different moment.
        assigneeType: conv?.assigneeType ?? null,
        observed: {
          status: conv?.status ?? null,
          statusAt: conv?.chatwootStatusAt ?? null,
        },
      };
    });
    // Both gates below drop what is no longer wanted: a human took the conversation, or a newer
    // customer message made this answer obsolete. Neither can reach the closing line, which left
    // before them — and neither has a carve-out, because a handed-off turn arrives here holding only
    // what it has no special claim to: a queued photo is not something the transfer promised, and
    // over a human who is already answering it is exactly what should not land.
    if (!recheck.ours) {
      // NOTE: TWO different events wear this one exit, and calling both "taken_over" is what sent
      // an incident investigation to the wrong half of the system (issue #225). The reading is the
      // gates' shared one now (issue #271): this is the last of the gates that close on the same
      // question, and an operator filtering the log for one outcome has to get every one.
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

    // Last-moment supersede gate (debounce): a newer message arrived mid-turn → drop this reply
    // AND any deferred resolve intent (the re-armed flush re-decides over the full burst).
    const blocked = await postBlocked();
    if (blocked) return refuse(blocked);

    // OUTPUT guardrail: screen the model's reply BEFORE delivery. On a violation, replace it with the
    // template / a guardrails-generated safe reply, or suppress the send entirely ("silent"). A
    // suppressed send also discards the deferred resolve intent — resolving a conversation whose
    // goodbye was blocked would strand the customer with no reply and no human.
    // NOTE: Everything the MODEL wrote for the customer rides along into the screening, not just the
    // reply: a caption, and the values a model put inside a document (its field text and line-item
    // descriptions). All of it is text the customer reads, so moderating the reply while the rest
    // goes out unread would be a hole — and the document version of that hole is worse, because it
    // reaches them as a numbered PDF they keep. A trip drops the queue — the safe reply replaces what
    // the model wrote, attachments included. This sits ABOVE the empty-reply branch because a caption
    // is customer-facing text even when the model produced no final message of its own (skip_reply
    // with an image is a legitimate shape).
    const modelWritten = turnState.pendingAttachments.flatMap((i) =>
      [i.caption?.trim(), i.screenText?.trim()].filter((c): c is string => !!c),
    );
    const screened = [reply, ...modelWritten].filter(Boolean).join("\n");
    const outGuard = screened ? await runGuardrail("output", screened) : null;
    // Same wait, same reason: `postBlocked` answered before this model call, and the suppressed
    // branch below returns "blocked" without passing any later ask.
    if (await writeCalledOff()) return refuse("stale");
    if (outGuard && guardrailTripped(outGuard)) {
      turnState.pendingAttachments.length = 0;
      const replacement = screenedText(outGuard, screened);
      if (replacement === null) return refuse("blocked");
      reply = replacement;
    }

    // Empty reply: no text to post, but the queued images and a deferred resolve intent still apply
    // (both are legitimate shapes with no final text). This runs AFTER the recheck and the supersede
    // gate on purpose: resolving under a takeover belongs to the human, and resolving under a
    // superseded turn would make the next flush's gate read "resolved" and swallow the customer's
    // newest message via the watermark.
    // NOTE: An image that reached the customer IS an answer, so the turn reports "posted" — the
    // callers key the error-cleared/answered bookkeeping off that word, and an image-only turn that
    // reported "empty" would leave a stale turn error on a conversation that was just answered.
    if (!reply) {
      // Nothing has left this turn yet on this branch, so the whole thing stands down.
      if (await writeCalledOff()) return refuse("stale");
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
      // The files WERE this turn, and another turn holds the burst: nothing went out, and the whole
      // turn stands down rather than reporting an empty answer it did not choose.
      if (lostClaim) return refuse("superseded");
      // Only when NOTHING left. A batch called off after its second attachment already reached the
      // customer, and "stale" would leave the watermark where it is — handing the same burst to the
      // next flush, which would send that attachment again. What was delivered decides the word, the
      // same rule the reply below follows.
      if (attachmentsCalledOff && !sent) return refuse("stale");
      // NOTE: The attachments WERE the turn and none of them reached the customer. That is a failed
      // turn, not a silent one: returning "empty" here would let the deferred resolve close a
      // conversation nobody answered, and the callers only record a turn error (private note,
      // lastError, alert) when the turn THROWS. Best-effort per file still holds where a reply
      // carries the turn.
      // NOTE: ...unless a handoff already answered. Then the files were NOT the turn, and a throw
      // would record a turn error (private note, lastError, alert) on a conversation that was both
      // answered and correctly handed to a human.
      // NOTE: ...or unless nothing FAILED. A document the operator revoked while the model was
      // still writing held itself back on purpose, and reporting their own decision as a turn error
      // alerts them about their own click. Nothing was delivered either way, so the turn is empty —
      // and the deferred resolve is skipped with it, because a conversation the customer never
      // heard back on must not close.
      if (queued > 0 && !sent && !handedOff) {
        if (failed) {
          throw new Error(
            "envio de anexo: nada foi entregue e o turno não tinha resposta em texto",
          );
        }
        return "empty";
      }
      // Skipped, not returned on: closing a conversation the operator has just cleared is a write
      // of its own, and by here something may already have reached the customer — the outcome still
      // has to describe that.
      //
      // AND SKIPPED ON A PARTIAL BATCH: the customer holds some of what the turn owed them, so a
      // `resolved` conversation tells the operator this attendance is finished when the agent knows
      // it is not. The rule itself lives in ./close-intent.ts, asked the same way at all three
      // sites — it was answered differently at each until a review round found them one by one.
      if (
        mayCloseConversation({
          replyPartial: false,
          attachmentFailed: failed,
        }) &&
        !(await writeCalledOff())
      ) {
        await applyDeferredResolve(client, conversationId, turnState, flow, {
          tenantId,
          instanceId,
          base,
          observed: recheck.observed,
        });
      }
      // Partial here too, and the same rule: a batch where one file failed is an attendance the
      // customer did not fully receive, so it neither closes nor clears the badge.
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

    // The image lands before the text that talks about it, and before the TTS branch: an audio
    // reply must not swallow the attachment.
    if (await writeCalledOff()) return refuse("stale");
    const attachments = await deliverPendingAttachments(
      client,
      conversationId,
      turnState,
      flow,
      { tenantId: params.tenantId, base },
      writeCalledOff,
      claimBeforeSend,
    );
    if (attachments.lostClaim) return refuse("superseded");
    // Called off mid-batch with something already out: the text below would stand down anyway, and
    // returning "stale" from there would replay a burst whose attachment the customer has. The turn
    // reports what it delivered and stops here.
    if (attachments.calledOff)
      return attachments.sent ? "posted" : refuse("stale");

    const delivered = await deliverText(reply, recheck.voiceReply);
    // Another turn holds the claim on this burst. Nothing left here — the ask sits one statement
    // before the send — and an attachment cannot have gone out either, because the batch above asks
    // the same memoized gate first, so this stands down whole.
    if (delivered === "superseded") return refuse("superseded");
    // NOTHING LANDED AND A SEND FAILED: a failed turn, and the ONE shape of partial delivery that
    // still throws (issue #429). Nothing reached the customer, so there is nothing a retry could
    // duplicate — which is exactly what makes the throw safe here and unsafe one balloon later. The
    // throw is also the only way the operator hears about it: the callers record a turn error
    // (private note, lastError, alert) on a throw and on nothing else, and the recovery reads it to
    // decide the row is still owed an answer.
    //
    // Same rule as the attachment-only branch above, and stated the same way there: delivered
    // nothing AND failed is a failure; delivered nothing without failing is not.
    //
    // NOTE: ...unless an ATTACHMENT already went out. Then the customer holds part of the answer,
    // and a re-run would send that attachment a second time — the same reason the branch below
    // reports "posted" rather than standing down.
    if (
      delivered !== "stale" &&
      delivered.failed &&
      delivered.delivered === 0
    ) {
      if (!attachments.sent) {
        throw new Error(
          "envio da resposta: nenhum balão foi entregue ao cliente",
        );
      }
    }
    // Zero is the split loop standing down on its FIRST balloon: nothing reached the customer, so
    // this is a stale turn and not a delivered one. Treating every number as posted would advance
    // the handled watermark over a burst nobody answered, and the next flush starts after it.
    //
    // Unless an ATTACHMENT already went out, which is the same rule the two branches above follow
    // and the third place it has to be written: the images were delivered before this line ran, so a
    // command landing in the text send leaves a customer holding part of the answer. "stale" would
    // hand the burst back to the next flush, which sends that attachment again.
    if (delivered === "stale" || delivered.delivered === 0) {
      if (!attachments.sent) return refuse("stale");
      // The attachment IS the answer the customer got, and this is the third shape of a partial
      // delivery rather than a fourth kind of success: a text send that failed outright leaves them
      // holding the file and none of the words, which is exactly what the badge exists to say.
      //
      // `stale` is deliberately NOT partial. Nothing was attempted after the fence, by decision, and
      // reporting the operator's own /reset as an incomplete delivery puts `lastError` back on the
      // conversation they had just cleared — the rule `deliverReply` states for the same case.
      // `attachmentFailed` is still asked on that path, because a file that failed BEFORE the fence
      // failed on its own.
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
    // AN ATTENDANCE THE CUSTOMER DID NOT FULLY RECEIVE DOES NOT CLOSE, and this branch owes the
    // answer for BOTH halves of what the turn promised: the text AND the files that went out ahead
    // of it. Asking only about the text is how a reply that landed while a promised photo did not
    // still closed the conversation.
    //
    // The reply is still `posted` for retry bookkeeping — the customer HAS part of it, and re-running
    // would send that part twice — so the two questions genuinely differ. The flow lines from the
    // failed sends are what tell the operator why the conversation stayed open.
    const posted = postedOutcomeFor({
      replyPartial: delivered.failed,
      attachmentFailed: attachments.failed,
    });
    if (posted === "posted-partial") {
      await notePartialDelivery({ tenantId, instanceId, conversationId, base });
      return posted;
    }
    // Same rule as the branch above: the reply is out, the resolve is a separate write.
    if (await writeCalledOff()) return "posted";
    await applyDeferredResolve(client, conversationId, turnState, flow, {
      tenantId,
      instanceId,
      base,
      observed: recheck.observed,
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
    // NOTE: LAST, and the order is the whole point. `undoRefusedTurn` stands down while the GRAPH thread is
    // in flight, and there are two claims on this turn: `markTurnInFlight(threadId)` cleared at the
    // top of this block, and the durable one `markTurnOwning` takes on `graphThreadId` — which is a
    // DIFFERENT key whenever the conversation has a contact-inbox, i.e. the normal case. Released
    // only by `clearTurnOwning` just above, so anywhere earlier the rollback reads this turn's own
    // claim and answers `another-invoke-is-reading`: a no-op, silently, in exactly the production
    // shape. Round 5 put it after the first clear and the test agreed, because the test seeded a
    // conversation with no contact-inbox and the two keys collapsed into one.
    if (silenceProduced) {
      const produced = silenceProduced;
      try {
        const plan = await undoRefusedTurn({
          checkpointer: params.deps?.checkpointer ?? (await getCheckpointer()),
          graphThreadId,
          produced,
          kind: "reactive",
          // The claim this turn has just released, taken again for the write — so a turn STARTING on
          // another replica waits for it instead of loading the sentinel and saving it back. Null
          // when the conversation has no contact inbox: no row, hence nothing durable to hold, and
          // the process-local check is all there is (thread-claim.ts).
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
          // NOTE: NOT A MISS: the words are not in the thread, which is the whole goal. This is what a
          // REFUSAL after the silence looks like — a takeover, a supersede, a `/reset` — because
          // every refusal exits through `refuse`, whose own rollback removes the same messages.
          //
          // The two race, and this side always loses: `return refuse(...)` is not awaited, so this
          // `finally` runs while that rollback is still in flight, and the `ingest:` queue decides
          // the order. Clearing a flag inside `refuse` cannot fix it — this block has already read
          // it by then (measured, round 25). Reading the OUTCOME instead of the ordering is what
          // makes the answer stable.
          logger.info(
            "turn: the token-silenced turn was already taken back out: conv=%s",
            String(conversationId),
          );
        } else {
          // NOTE: Named rather than silent: the history still holds a message the customer never received,
          // which is the compounding this exists to stop.
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
    status.finished(deliveredBalloons);
  }
}

export interface RunAgentTurnParams {
  tenantId: bigint;
  instanceId: bigint;
  agentBotId: number | null;
  event: NormalizedChatwootEvent;
  base?: PrismaClient;
  deps?: RuntimeDeps;
  // What the authorization endpoint said about this contact, from the gate the webhook ran on THIS
  // delivery (`maybeConsumeCommandOrGate`), for the block the turn appends to its prompt. Optional
  // here and required one layer down: the gate is a caller's business, and every test that runs a
  // turn without one would otherwise have to say so.
  authContext?: AuthContext | null;
}

// Direct (no-debounce) entry: one incoming message → resolve the inbox's Agent → run the turn.
export async function runAgentTurn(
  params: RunAgentTurnParams,
): Promise<RunAgentTurnOutcome> {
  const { tenantId, instanceId, agentBotId, event: n } = params;
  const base = params.base ?? basePrisma;

  if (n.conversationId == null || n.inboxId == null) return "skipped";
  if (!isIncomingMessage(n)) return "skipped";
  // Render the message for the agent (text / transcribed audio / image-or-file marker), mirroring the
  // flush. transcribedText is set by the eager STT pass. The shape itself is `incomingRenderable`,
  // shared with the spend-ceiling gate, which has to ask this same question before it refuses.
  const renderable = incomingRenderable(n);
  let text = renderInboundMessage(renderable);
  if (!text) return "skipped";
  const conversationId = n.conversationId;
  const inboxId = n.inboxId;
  const threadId = chatwootThreadId(tenantId, instanceId, conversationId);

  // Reply context (item 11): when this message quotes another, fetch the thread page once and
  // re-render WITH the quoted snippet, so the agent sees "<em resposta a: …>" just like the flush
  // path. Best-effort and reply-only — a normal message never pays the extra fetch.
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
      // resolves to its transcription through the in-process overlay (issue #49).
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

  // Scoped read (no network): resolve the inbox's Agent + config bundle.
  //
  // The binding and the config are read in ONE scope and reported apart, because they are two facts
  // an operator repairs differently and the caller writes a `route` line off the answer (issue #318).
  // Classifying them anywhere else means reading the binding a second time, and a rebind landing
  // between the two reads then reports the wrong one — the turn takes seconds, and gates, mirroring
  // and media all run inside it.
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
      }),
    };
  });
  if (!resolved.bound) return "no-agent";
  const loaded = resolved.config;
  // A binding that exists and could not be loaded: the agent is switched off, or its row is gone.
  // Switched off is a deliberate operator state, which is why it is NOT the silence above.
  if (!loaded) return "agent-unavailable";

  // NOTE: Post gate, mirroring the debounce flush (issue #49): concurrent direct turns on the same
  // conversation (webhook deliveries are not serialized) each generate a reply — without this gate
  // the STALE one posts too, answering a message the customer already moved past.
  //
  // THREE QUESTIONS, where the CAS this used to be answered two of them with one write (issue #452).
  // "Has a newer message arrived?" is this re-fetch. The other two are settled together, under one
  // row lock, by the claim `claimReply` names below: "was this trigger already handled" (the
  // watermark, against the ceiling this path passes — a delivery arriving late for a message an
  // earlier turn answered or skipped stands down, which is what the losing CAS used to say) and "is
  // anybody else answering it right now" (the reply claim, the ONE column every posting path
  // shares, which is what makes this turn and a manual re-engage of the same message exclusive).
  // Splitting those two apart would reopen the window a deliberate skip lands in. Re-fetch failure
  // is non-fatal (same contract as the flush).
  const triggerId = n.message?.id ?? null;
  const convDbId = loaded.conversationDbId;
  const shouldPost =
    triggerId !== null && convDbId !== null
      ? async (): Promise<boolean> => {
          try {
            const client = await loadChatwootClient(tenantId, instanceId, {
              base,
              makeClient: params.deps?.makeClient,
            });
            const latest = parseChatwootMessages(
              await client.getMessages(conversationId),
            );
            if (maxIncomingId(latest, triggerId) > triggerId) {
              logger.info(
                "direct turn: superseded mid-turn (conv=%s), deferring",
                String(conversationId),
              );
              return false;
            }
          } catch (e) {
            logger.warn(
              "direct turn: supersede re-fetch failed (conv=%s): %s",
              String(conversationId),
              e instanceof Error ? e.message : String(e),
            );
          }
          return true;
        }
      : undefined;

  const outcome = await runLoadedTurn({
    // Nothing QUEUED this turn — it is the delivery itself, arriving from the webhook — so there is
    // no job for /reset to retire. What names this run instead is the EPISODE, read off the message
    // it is answering, and ./reset-episode.ts carries the measurement: without it the operator's
    // /reset is acknowledged and this turn then runs its tools on the conversation that was just
    // cleared. `null` stays for a turn with no mirrored conversation to read the boundary from (the
    // playground), where nothing can reset it either.
    stillWanted:
      convDbId === null
        ? null
        : stillInSameEpisode({
            tenantId,
            conversationDbId: convDbId,
            // The same id the supersede gate claims with, and for a related reason: it is what
            // names this run in the order the SOURCE put it in.
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
    // The same id the supersede gate is written around: this turn answers ONE message, so that
    // message is the burst it claims. Null where there is nothing to be exclusive about — no
    // mirrored conversation (the playground), or no triggering message.
    claimReply:
      triggerId !== null && convDbId !== null
        ? {
            conversationDbId: convDbId,
            toMessageId: triggerId,
            // Nothing at or past this message may have been handled: this turn answers that one
            // message, so a mark that already covers it means somebody else settled it.
            maxHandledAllowed: triggerId - 1,
          }
        : null,
  });
  // NOTE: Watermark tail, now for every outcome including "posted" — the post gate claims in its own
  // column and no longer advances this one on the way past (issue #452).
  // empty/blocked consumed the message, taken over hands it to the human — left alone the watermark
  // stays NULL forever, and the first flush after debounce is later enabled (or after an arm failure
  // fell back here) re-answers the whole recent page (issue #8). "superseded" stays put BY DESIGN:
  // the newer message's own turn advances past it. Best-effort — a watermark miss must not fail the
  // turn.
  // "stale" ADVANCES IT, and used not to. It was excluded when nothing on this path could produce
  // it, on the reasoning that a called-off run withdraws its message rather than handling it — which
  // is the flush's truth, where a re-armed flush answers the burst, and not this path's. Here the
  // only thing that calls a run off is the operator's own /reset (./reset-episode.ts), nothing else
  // is coming for the message, and the receiver settles its ledger row as CONSUMED. The watermark
  // has to agree with the ledger: left behind, the row is terminal while the watermark still sits
  // below the message, and the first flush after debounce is enabled re-answers it (issue #8).
  //
  // Not covered by the command's own advance, which is the shape a review round measured: /reset
  // writes the boundary in its FIRST step and advances this watermark in its LAST, with a dozen
  // Chatwoot calls in between, so a process dying in that stretch leaves exactly the gap above.
  if (
    outcome !== "superseded" &&
    n.message?.id != null &&
    loaded.conversationDbId !== null
  ) {
    try {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: loaded.conversationDbId,
        toMessageId: n.message.id,
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
