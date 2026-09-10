import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { MemorySaver } from "@langchain/langgraph";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { chatwootThreadId } from "@/graph/checkpointer";
import { recursionLimitFor } from "@/graph/graph";
import type { ResolvedModelConfig } from "@/graph/models";
import {
  buildCallbacks,
  buildModelAndGraph,
  buildToolset,
  loadAgentConfig,
} from "@/graph/prepare";
import { resetLandedAfter } from "@/graph/reset-episode";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import type { McpLoadDeps } from "@/graph/tools/mcp";
import { buildNativeTools } from "@/graph/tools/native";
import { parseDbId } from "@/lib/db-id";
import { withEntityLock } from "@/lib/locks";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { clipText, clipTextEnd } from "@/lib/text";
import { isMonitoring } from "@/modules/agents/mode";
import { agentObservesNow } from "@/modules/agents/speaks";
import { overlayMediaAnnotations } from "@/modules/chatwoot/annotations";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  renderAttendantMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";
import { underSignal } from "@/modules/contact-auth/check";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import {
  type ClaimedJob,
  type Rearm,
  upsertJobRow,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  announceSpendCeiling,
  spendCeilingVerdict,
} from "@/modules/spend-ceiling/service";
import { type MonitoringConfig, readMonitoringConfig } from "./settings";

// The OBSERVE job (issue #477): a monitoring agent's verdict on a conversation it does not answer,
// written as labels. It is what a watcher is for — a memory that grows and is never asked anything
// is a cost with no reader — and it is the shape the rest of the product already reads: labels are
// what the team filters by, what the reports count and what the automations key off.
//
// THE TICK IS STATELESS. It reads the newest messages of the conversation from Chatwoot rather than
// the agent's memory thread, for two reasons that both come from the thread being keyed by CONTACT-
// INBOX and not by agent: an observer beside a responder shares that thread (and would read the
// responder's summaries as its own), and a conversation that predates the observer has history the
// thread never saw. Chatwoot has all of it, and a transcription written by anyone is read through the
// same renderers the turn uses.
//
// THEN THE ORDINARY TURN, on a muted client: `buildToolset` and `buildModelAndGraph`, the same two
// calls the reactive turn and the nudge make. What the watcher does with what it read is its prompt
// and its tools, not this file's business — this file only guarantees that nothing it does can
// reach the customer, and that it stops when the world moves under it. It used to be one model call
// constrained to a schema derived from `settings.monitoring.labelGroups`, with the verdict applied
// deterministically here and announced as a private note; issue #568 is that whole shape.

export type ObserveReason = "burst" | "resolved";

// THE WHOLE TICK'S BUDGET, not the model call's. It bounds tool discovery as well as the turn,
// because `runSchedulerTick` awaits every handler and `startScheduler` skips the next tick while one
// is running: an MCP server that opens a stream and never says anything else stops reminders and
// every other tenant's scheduled work, and discovery happens before any model call.
//
// Raised from the 60s the single constrained verdict call used to get, because a turn is now as many
// model calls as the model makes tool calls, and a deadline a legitimate turn cannot meet is a tick
// that fails, retries and spends again. Kept well under the scheduler's own 5-minute stale window,
// so a tick always finishes before the reaper would treat its claim as abandoned.
export const OBSERVE_TIMEOUT_MS = 120_000;
export const OBSERVE_CEILING_WINDOW_MS = 10 * 60_000;
const TRANSCRIPT_MAX_CHARS = 40_000;
// The notes block gets its own budget, and it needs one for the same reason the transcript has one:
// `window.messages` caps a COUNT, and a count is not a size. Twenty notes of twenty thousand
// characters is a four-hundred-thousand-character prompt beside a three-line transcript, which
// overruns the model's context and fails the same tick forever. Smaller than the transcript's,
// because the notes are context ABOUT the conversation and the conversation is the subject.
const NOTES_MAX_CHARS = 8_000;
// ...and no single note may eat the whole budget, so one operator who pasted a log cannot hide every
// note around it. `clipText` keeps the START, which for a note is where it says what it is about.
const NOTE_MAX_CHARS = 2_000;
const FENCE_TAG = /<\s*\/?\s*(transcricao|etiquetas-atuais)[^>]*>/gi;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// One row per CONVERSATION **and CLASSIFIER**: a burst re-arms it, a resolve pulls it forward. Its
// own prefix, so it never collides with the responder's `debounce:` row on the same conversation.
//
// THE AGENT IS PART OF THE KEY (issue #477 review, round 1). An inbox can be watched by TWO
// personas at once — a monitoring agent bound as the RESPONDER (#209's first rung) and a different
// agent bound beside it as the OBSERVER — and both routes arm a tick, by design, each with its own
// prompt and its own tools. Keyed by the conversation alone the two upserts are the same row: the
// second overwrites `payload.agentId`, and which persona gets to look is decided by which delivery
// happens to land last, with the other's turn dropped and nothing anywhere saying so. Two watchers
// is two rows, two bursts and two model calls, which is what configuring two of them asks for.
export function observeDedupeKey(threadId: string, agentId: bigint): string {
  return `${observeKeyPrefix(threadId)}${String(agentId)}`;
}

// Every classifier's row on ONE conversation, for the caller that has to retire them together: the
// key carries the agent, so a conversation's verdicts are a prefix and not a key (issue #477 review,
// round 5).
export function observeKeyPrefix(threadId: string): string {
  return `observe:${threadId}:`;
}

export interface ArmObserveParams {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentId: bigint;
  reason: ObserveReason;
  cfg: MonitoringConfig;
  base: PrismaClient;
  now?: Date;
  // WHICH RESOLUTION this is, from the conversation's own version (`updated_at`, the field the
  // console-write ordering is built on). Chatwoot emits BOTH `conversation_status_changed` and
  // `conversation_resolved` for one resolve, and on an inbox with two bindings each reaches its own
  // route — four deliveries for one resolution. They fold while the row is PENDING; once the first
  // verdict is claimed, the next delivery's upsert would put the row back to PENDING and buy a
  // second billed classification of the same resolution. The mark is remembered on the row and a
  // resolve that carries one already recorded arms nothing. Null (a payload with no version) arms
  // as before: a resolution nothing can name is not one this can deduplicate.
  mark?: number | null;
  // Armed off the ATTACH WINDOW: Chatwoot has taken the attachment and the `InboxObserver` row is
  // not committed yet (`boundObserverRuntime`). Carried so the tick can tell "the row has not landed
  // yet" from "the agent was detached", which read the same on the row alone.
  attaching?: boolean;
  // THE MESSAGE THIS BURST WAS ARMED ON, and the only coordinate the reset fence can be asked in
  // (issue #477 review, round 6). `/reset` retires the PENDING rows, but a tick already claimed —
  // its model call overlapping the command — is past every cancel, and it would write back the
  // labels the reset had just cleared. `resetAtMessageId` is Chatwoot's own sequence, which is the
  // order the operator experienced, so a verdict about a message at or below the command's is a
  // verdict about the episode that was erased. Null on a resolve, which the reopen check covers
  // instead: the command is an incoming message and it hands the conversation back, so a
  // conversation that was resolved is no longer.
  atMessageId?: number | null;
}

function readBurstStart(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).burstStartedAt;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readAtMessageId(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).atMessageId;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readResolveMark(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>).resolveMark;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

// Arms (or re-arms) the one OBSERVE row of a conversation. `off` when the agent has nothing to
// classify into, or when a burst arrives on an agent that only looks at the end; the caller is the
// receiver or the flush, and neither treats a failure here as its own — a label that is late is not
// a message that is lost. Same shape as the responder's debounce arm: a live PENDING row is the burst
// this message joins and keeps its retry budget; anything else opens a new burst.
export async function armObserve(
  p: ArmObserveParams,
): Promise<"armed" | "off" | "failed"> {
  // OBSERVATION IS THE MODE, and nothing else switches it on (issue #568). It used to be "there is
  // at least one label group", because a watcher with nothing to classify into had nothing to do —
  // which was true of a classifier and is not true of an agent. An enabled monitoring agent attached
  // to an inbox is an agent the operator wants looking at these conversations; switching it off is
  // disabling it or taking it off the inbox, the same two answers a responder has.
  if (p.reason === "burst" && p.cfg.analysis !== "incremental") return "off";
  const threadId = chatwootThreadId(p.tenantId, p.instanceId, p.conversationId);
  const dedupeKey = observeDedupeKey(threadId, p.agentId);
  const nowMs = (p.now ?? new Date()).getTime();
  let armed = true;
  try {
    await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
      withEntityLock(db, `observe-arm:${threadId}`, async () => {
        const existing = await db.schedulerJob.findFirst({
          where: { kind: "OBSERVE", dedupeKey },
          select: { status: true, payload: true },
        });
        // A PENDING row is the burst this message joins only when it IS a burst (issue #477 review,
        // round 2). A resolve pulls the row to now, and a customer who reopens the conversation
        // before that verdict is claimed opens a NEW burst: read as a continuation it inherits the
        // resolve's `burstStartedAt`, which by then is almost always past the max window, so the new
        // burst runs immediately instead of waiting for the window it was configured with.
        // ONE VERDICT PER RESOLUTION, whichever of the four deliveries gets here (see `mark`). Read
        // off the row whatever its status, because the case this closes is precisely the one where
        // the first verdict has already been claimed.
        //
        // AT OR BELOW, not equal (issue #477 review, round 22). The mark is the conversation's own
        // version, so it only ever moves forward; a delivery carrying one the row has already passed
        // is a LATE echo of an older resolution — resolved, reopened, resolved again, with the first
        // resolution's fourth delivery still in flight. Compared for equality it armed: the newer
        // mark was overwritten by the older, so the current resolution could arm a second time and
        // be billed twice, and the re-arm superseded a verdict that was in flight for the resolution
        // that actually stands. A burst clears the mark, which is what keeps this from suppressing
        // the NEXT resolution.
        const recordedMark = readResolveMark(existing?.payload);
        if (
          p.reason === "resolved" &&
          p.mark != null &&
          recordedMark !== null &&
          recordedMark >= p.mark
        ) {
          armed = false;
          return;
        }
        const continuing =
          existing?.status === "PENDING" &&
          (existing.payload as Record<string, unknown> | null)?.reason ===
            "burst";
        const burstStartedAt =
          (continuing ? readBurstStart(existing.payload) : null) ?? nowMs;
        const runAtMs =
          p.reason === "resolved"
            ? nowMs
            : Math.min(
                nowMs + p.cfg.debounce.windowSeconds * 1000,
                burstStartedAt + p.cfg.debounce.maxWindowSeconds * 1000,
              );
        const rearm: Rearm = continuing ? "same-work" : "new-work";
        await upsertJobRow(db, {
          tenantId: p.tenantId,
          kind: "OBSERVE",
          dedupeKey,
          runAt: new Date(runAtMs),
          payload: {
            instanceId: String(p.instanceId),
            conversationId: p.conversationId,
            agentId: String(p.agentId),
            reason: p.reason,
            burstStartedAt,
            // Carried only by a resolve: a burst clears it, so the NEXT resolution arms again.
            ...(p.reason === "resolved" && p.mark != null
              ? { resolveMark: p.mark }
              : {}),
            ...(p.attaching === true ? { attaching: true } : {}),
            // ...and the NEWEST message of the burst, which is the MAXIMUM and not the last one
            // to arrive (issue #477 review, round 9). Chatwoot delivers out of order often enough
            // to matter, and this id is what the reset fence orders against: a delayed older
            // delivery joining a burst that a newer message already armed would push the id
            // BACKWARDS, and a reset sitting between the two would then discard the whole burst,
            // the valid new message with it.
            ...(p.reason === "burst" &&
            (p.atMessageId != null ||
              (continuing && readAtMessageId(existing?.payload) != null))
              ? {
                  atMessageId: Math.max(
                    p.atMessageId ?? Number.NEGATIVE_INFINITY,
                    (continuing ? readAtMessageId(existing?.payload) : null) ??
                      Number.NEGATIVE_INFINITY,
                  ),
                }
              : {}),
          },
          rearm,
        });
      }),
    );
    return armed ? "armed" : "off";
  } catch (err) {
    logger.warn(
      { err },
      `observe: could not arm the verdict (conv=${String(p.conversationId)})`,
    );
    return "failed";
  }
}

export interface ObservePayload {
  instanceId: bigint;
  conversationId: number;
  agentId: bigint;
  reason: ObserveReason;
  atMessageId: number | null;
  attaching?: boolean;
}

export function parseObservePayload(
  payload: Record<string, unknown>,
): ObservePayload | null {
  const s = (k: string) =>
    typeof payload[k] === "string" ? (payload[k] as string) : null;
  const instanceId = parseDbId(s("instanceId"));
  const agentId = parseDbId(s("agentId"));
  const conversationId = payload.conversationId;
  if (
    instanceId === null ||
    agentId === null ||
    typeof conversationId !== "number"
  ) {
    return null;
  }
  return {
    instanceId,
    agentId,
    conversationId,
    reason: payload.reason === "resolved" ? "resolved" : "burst",
    atMessageId:
      typeof payload.atMessageId === "number" &&
      Number.isFinite(payload.atMessageId)
        ? payload.atMessageId
        : null,
    ...(payload.attaching === true ? { attaching: true } : {}),
  };
}

export interface ObserveDeps {
  makeModel?: (cfg: ResolvedModelConfig) => BaseChatModel;
  makeClient?: LoadChatwootClientDeps["makeClient"];
  mcp?: McpLoadDeps;
  // In-memory by default (see the invoke): injectable so a test can read the thread back.
  checkpointer?: ConstructorParameters<typeof MemorySaver> extends never
    ? never
    : MemorySaver;
  // The row this tick is running FOR, so the generation fence below can ask whether it still is
  // (issue #477 review, round 7). Optional because `runObserve` is callable without the scheduler.
  claim?: { jobId: bigint; claimSeq: number };
  // The turn's deadline, injectable so a test can assert the tick gives up without waiting a
  // minute for it. Production never passes it.
  timeoutMs?: number;
}

// A ROW THE TRANSCRIPT CAN USE. Factored out of `transcriptFromRows` so the paging below counts the
// same thing the window measures: private notes, reactions and activity rows are not messages.
function usableRow(m: ChatwootMessageRow): boolean {
  return (
    !m.private &&
    !m.isReaction &&
    (m.messageType === "incoming" ||
      m.messageType === "outgoing" ||
      // A TEMPLATE IS THE ATTENDANT SPEAKING (issue #477 review, round 4). Chatwoot files a
      // customer-facing template send under its own `message_type`, and dropping it left the
      // classifier a terse "sim" with nothing before it — the reply without the question. Activity
      // lines stay out: they are the system narrating, not either side talking.
      m.messageType === "template")
  );
}

// PAGED BACKWARDS UNTIL THE WINDOW IS FULL (issue #477 review, round 1). One unanchored read is
// Chatwoot's newest page, about twenty RAW rows, and `window.messages` goes to sixty — so every
// value above one page silently read one page, and a newest page thick with private notes,
// activity rows and reactions read fewer messages than that even on a short window. `before` walks
// older (the fork's MessageFinder honours it), and the loop stops the moment the window is covered.
//
// BOUNDED, because a conversation is not: five pages is sixty usable messages at a dozen per page,
// which is the ceiling the window itself has, and a conversation whose history is thinner than the
// window simply ends — a page that adds no row older than the one before it is the end of it.
const OBSERVE_MAX_PAGES = 5;

async function readWindowRows(
  client: ChatwootClient,
  conversationId: number,
  want: number,
): Promise<ChatwootMessageRow[]> {
  const seen = new Map<number, ChatwootMessageRow>();
  let before: number | undefined;
  for (let page = 0; page < OBSERVE_MAX_PAGES; page++) {
    const rows = parseChatwootMessages(
      await client.getMessages(
        conversationId,
        before === undefined ? undefined : { before },
      ),
    );
    let oldest: number | null = null;
    let added = 0;
    for (const r of rows) {
      if (!seen.has(r.id)) added += 1;
      seen.set(r.id, r);
      if (oldest === null || r.id < oldest) oldest = r.id;
    }
    // Nothing older came back: this is the start of the conversation, whatever the window asked for.
    if (added === 0 || oldest === null) break;
    let usable = 0;
    for (const r of seen.values()) if (usableRow(r)) usable += 1;
    // ...AND THE MESSAGES THE WINDOW QUOTES (issue #477 review, round 11). Enough rows is not
    // enough CONTEXT: a reply inside the window can quote something on an older page, and a terse
    // "sim" reaching the classifier without the question it answers is exactly the case the quote
    // resolver exists for. Only the rows that will actually be RENDERED are asked about, and only
    // within the same page bound, so this buys at most the pages the window already allows.
    if (usable >= want && quotesResolved(seen, want)) break;
    before = oldest;
  }
  return [...seen.values()];
}

// Whether every quote the rendered window points at is already fetched. The window is the newest
// `want` usable rows, the same slice `transcriptFromRows` renders.
function quotesResolved(
  seen: Map<number, ChatwootMessageRow>,
  want: number,
): boolean {
  const window = [...seen.values()]
    .filter(usableRow)
    .sort((a, b) => a.id - b.id)
    .slice(-want);
  for (const r of window)
    if (r.inReplyTo !== null && !seen.has(r.inReplyTo)) return false;
  return true;
}

// The task, appended to the agent's own prompt: the persona says what the business is, this says
// what to do with the conversation. In the product's language, like the summarizer's.
// WHAT THE MODEL IS ASKED, and it is no longer a classification task. The groups, the enum and the
// rules about which value wins used to be built here, because the verdict had to be machine-read;
// now the operator writes that in their own prompt or in the tool's usage guidance, exactly as they
// would for a responder — which is the whole point of the mode being generic (issue #568).
//
// What is left is the frame the agent cannot know on its own: it is reading, not answering, and
// there is no reply channel this turn. The last line is the one that keeps a tick cheap: a
// conversation where nothing changed should cost one model call and no writes.
export function observeTurnText(
  transcript: readonly TranscriptLine[],
  current: readonly string[],
  notes: readonly string[] = [],
): string {
  return [
    "Turno de observação: você está acompanhando esta conversa e NÃO responde a ninguém.",
    "Não existe canal de resposta aqui: qualquer texto que você escrever não chega a lugar nenhum, nem ao cliente nem à equipe.",
    "O que você faz neste turno é agir sobre a conversa com as ferramentas que tem: etiquetar, anotar em nota privada, registrar atributo, mover o card, o que o seu papel pedir.",
    "Cada turno começa do zero: o que você já fez nesta conversa está no que está registrado nela, não na sua memória.",
    "Se nada precisa mudar em relação ao que já está registrado, não chame ferramenta nenhuma.",
    "",
    `<etiquetas-atuais>${current.length ? current.join(", ") : "(nenhuma)"}</etiquetas-atuais>`,
    "",
    // THE NOTES THE CONVERSATION ALREADY CARRIES, and the reason they are here is the same as the
    // labels'. A tick is stateless on purpose — its own thread, an in-memory checkpointer — so
    // "don't write if nothing changed" is a question the model can only answer against what is
    // WRITTEN on the conversation. A label it can see; a private note it wrote on the last burst it
    // could not, because the transcript is public messages only, and it would file the same note
    // again on every burst. Given as a separate block rather than folded into the transcript: a
    // note is not somebody talking, and the window that counts messages must keep counting messages.
    `<notas-internas>${
      notes.length
        ? `\n${notes.map((n) => `- ${n}`).join("\n")}\n`
        : "(nenhuma)"
    }</notas-internas>`,
    "",
    "<transcricao>",
    renderTranscript(transcript),
    "</transcricao>",
  ].join("\n");
}

// The private notes already on the conversation, oldest first, newest `limit`. Written by anyone —
// this watcher on an earlier tick, another watcher, the responder, a colleague — because the
// question the block answers is "what does this conversation already say", and it is the same
// question whoever wrote the answer.
export function notesFromRows(
  rows: ChatwootMessageRow[],
  limit: number,
): string[] {
  const all = rows
    .filter((m) => m.private && !m.isReaction && m.content.trim().length > 0)
    .sort((a, b) => a.id - b.id)
    .slice(-limit)
    .map((m) =>
      clipText(
        stripFences(m.content)
          .trim()
          .replace(/\s*\n\s*/g, " "),
        NOTE_MAX_CHARS,
      ),
    )
    .filter((t) => t.length > 0);
  // WHOLE NOTES, DROPPED FROM THE OLDEST, rather than one cut through the middle of the block. A cut
  // leaves a fragment that reads as a complete note, which is the failure the label block avoids by
  // saying "(nenhuma)" instead of nothing: half a fact presented as a whole one. Walked newest
  // first, because the newest is the one a duplicate would duplicate; put back in order after.
  const kept: string[] = [];
  let budget = NOTES_MAX_CHARS;
  for (let i = all.length - 1; i >= 0; i--) {
    const note = all[i] as string;
    if (note.length > budget) break;
    budget -= note.length;
    kept.push(note);
  }
  return kept.reverse();
}

// The fence tags the renderers wrap machine-written text in (a transcription, an image
// description): stripped so a transcript line reads as the message, not as its markup.
function stripFences(text: string): string {
  return text.replace(FENCE_TAG, "");
}

export interface TranscriptLine {
  role: "customer" | "attendant";
  text: string;
}

// The newest `limit` public messages of the conversation, oldest first, rendered per direction the
// way the turn and the memory render them (so a transcription or an image description is read).
export function transcriptFromRows(
  rows: ChatwootMessageRow[],
  limit: number,
): TranscriptLine[] {
  // Built from EVERY row fetched, not from the windowed slice: a reply inside the window can quote a
  // message older than it, and the quote is then the only thing that says what it is about.
  const resolveQuoted = buildQuoteResolver(rows);
  const usable = rows
    .filter(usableRow)
    .sort((a, b) => a.id - b.id)
    .slice(-limit);
  const out: TranscriptLine[] = [];
  for (const m of usable) {
    const text =
      m.messageType === "incoming"
        ? renderInboundMessage(
            {
              text: m.content,
              transcribedText: m.transcribedText,
              imageDescription: m.imageDescription,
              extractedText: m.extractedText,
              attachmentTypes: m.attachmentTypes,
              attachmentName: m.attachmentName,
              location: m.location,
              inReplyTo: m.inReplyTo,
            },
            // WHAT A REPLY IS ANSWERING (issue #477 review, round 4), resolved off the same rows the
            // window fetched — the debounce path builds it the same way. Without it a quoted "sim"
            // reaches the model with the demand it answers stripped out, and a label decided on that
            // is decided on half the sentence.
            { resolveQuoted },
          )
        : renderAttendantMessage({
            text: m.content,
            attachmentTypes: m.attachmentTypes,
          });
    const clean = stripFences(text).trim();
    if (!clean) continue;
    out.push({
      role: m.messageType === "incoming" ? "customer" : "attendant",
      text: clean,
    });
  }
  return out;
}

export function renderTranscript(lines: readonly TranscriptLine[]): string {
  const joined = lines
    .map((l) => `${l.role === "customer" ? "Cliente" : "Atendente"}: ${l.text}`)
    .join("\n");
  return clipTextEnd(joined, TRANSCRIPT_MAX_CHARS);
}

function _isRequestRefused(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 400
  );
}

// STILL ON THE INBOX, and not merely still a monitoring agent (issue #477 review, round 1).
// `agentObservesNow` asks about the AGENT — switched on, still in monitoring — and an unobserve
// changes neither. The OBSERVE row is not retired by a detach either, so a watcher taken off an
// inbox while its verdict sat queued would otherwise spend a model call, move that inbox's labels
// and post a note on a conversation nothing gives it any more. Asked of BOTH bindings, because a
// monitoring agent may be the inbox's responder rather than its observer (#209's first rung).
//
// A read that fails is not evidence the binding is gone: `unreadable` keeps the tick, the same rule
// every compensation in the binding path follows. So is an inbox this conversation does not name —
// the mirror writes `inboxId` null for a conversation whose first event was sparse, and refusing
// there would silence observation on exactly the conversations that need it most.
//
// ...AND "ATTACHING" IS ITS OWN ANSWER (issue #540, window 5). The observer row is now written
// BEFORE Chatwoot is asked and stamped after, so an unstamped row is an attach in flight: the
// binding has not landed, and acting on it would move labels and post a note for an observe that
// can still be refused and taken back. It is not "no" either — that is a detach, and completing on
// it is permanent for a resolve. The caller retries, which is what the payload's `attaching` flag
// bought before this column and now buys only for a job an older release enqueued.
async function agentStillOnInbox(
  tenantId: bigint,
  inboxId: bigint,
  agentId: bigint,
  base: PrismaClient,
): Promise<"yes" | "no" | "attaching" | "unreadable"> {
  try {
    return await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const inbox = await db.inbox.findUnique({
        where: { id: inboxId },
        select: {
          agentId: true,
          observers: {
            where: { agentId },
            select: { id: true, attachedAt: true },
          },
        },
      });
      if (!inbox) return "no";
      // The RESPONDER binding first, and it is never pending: it is a column on the inbox, written
      // in one statement (#209's first rung, a monitoring agent bound as the responder).
      if (inbox.agentId === agentId) return "yes";
      if (inbox.observers.length === 0) return "no";
      return inbox.observers.some((o) => o.attachedAt === null)
        ? "attaching"
        : "yes";
    });
  } catch (err) {
    logger.warn(
      { err, agentId: String(agentId), inboxId: String(inboxId) },
      "observe: could not read whether the agent is still on the inbox; keeping the tick",
    );
    return "unreadable";
  }
}

export async function runObserve(
  tenantId: bigint,
  p: ObservePayload,
  base: PrismaClient,
  deps: ObserveDeps = {},
): Promise<JobResult> {
  const { instanceId, conversationId, agentId, reason } = p;
  const threadId = chatwootThreadId(tenantId, instanceId, conversationId);
  const turnId = crypto.randomUUID();

  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { name: true, enabled: true, mode: true, settings: true },
    });
    if (!agent?.enabled || !isMonitoring(agent.mode)) return null;
    const mon = readMonitoringConfig(agent.settings);
    // THE ARM'S OWN REFUSAL, ASKED AGAIN AGAINST THE CONFIGURATION NOW (issue #477 review, round 1).
    // A burst queued while the agent was `incremental` outlives a flip to `on_resolve`: the row is
    // not retired by the edit, and reloading the config here without re-asking spends a model call
    // and moves a label under a setting that says only the end of the conversation is classified.
    if (p.reason === "burst" && mon.analysis !== "incremental") return null;
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
        status: true,
        resetAtMessageId: true,
      },
    });
    const cfg = await loadAgentConfig(
      db,
      { tenantId, instanceId, conversationId, agentId, threadId },
      { skipExperiment: true, ignoreMode: true },
    );
    // A CONFIG THAT DOES NOT BUILD IS NOT AN AGENT THAT STOPPED OBSERVING (issue #477 review,
    // round 8). The checks above are deliberate operator states — switched off, no longer
    // monitoring, no groups left, per-burst turned off — and `done` is the right answer to each.
    // This is a credential the vault cannot hand over: pending, rotated, deleted. Folded into the
    // same `null` it retired an `on_resolve` verdict for good, and the line said the agent had
    // stopped observing, which is not what happened and not what an operator would go looking at.
    // The CONV goes with it, so the stale-state fences below can run before this is treated as a
    // retryable failure (issue #477 review, round 20).
    if (!cfg) return { noModel: true as const, conv };
    return { mon, cfg, conv };
  });
  if (loaded !== null && loaded.conv?.inboxId != null) {
    const onInbox = await agentStillOnInbox(
      tenantId,
      loaded.conv.inboxId,
      agentId,
      base,
    );
    // A ROW THAT HAS NOT LANDED IS NOT A DETACH (issue #477 review, round 13). This job was armed
    // off the ATTACH WINDOW — Chatwoot took the attachment, the `InboxObserver` row had not
    // committed — and on the row alone that reads identical to an agent taken off the inbox. It is
    // not: the arm carries the distinction. Completing here was permanent for a RESOLVE, since the
    // `resolveMark` then suppresses every later delivery of the same resolution, so the tick fails
    // and retries until the row is visible; an attachment the mirror never records dead-letters,
    // which is the right report for a leak nothing else names.
    if (onInbox === "attaching" || (onInbox === "no" && p.attaching === true)) {
      logger.warn(
        "observe: the observer binding has not landed yet (conv=%s, agent=%s); retrying",
        String(conversationId),
        String(agentId),
      );
      return {
        outcome: "fail",
        error: "observe: the observer binding has not landed yet",
      };
    }
    if (onInbox === "no") {
      logger.info(
        "observe: the agent is no longer on this inbox (conv=%s); nothing to do",
        String(conversationId),
      );
      return { outcome: "done" };
    }
  }
  if (!loaded) {
    logger.info(
      "observe: nothing to do (conv=%s): the agent no longer observes, or this burst is refused by its `analysis` setting",
      String(conversationId),
    );
    return { outcome: "done" };
  }
  if ("noModel" in loaded) {
    // A MOOT JOB IS NOT RETRIED (issue #477 review, round 20). The detach fence above already
    // completed for an agent taken off the inbox; the other moot case is a resolve verdict on a
    // conversation that reopened, and asking it here — before the model config is called a
    // retryable failure — is what keeps a credential that happens to be missing from failing its
    // way to the dead-letter list on work nobody wanted. The live path asks the same question
    // further down, where the flow line can carry it.
    if (
      loaded.conv !== null &&
      reason === "resolved" &&
      loaded.conv.status !== "resolved"
    ) {
      logger.info(
        "observe: the conversation reopened (conv=%s); nothing to do",
        String(conversationId),
      );
      return { outcome: "done" };
    }
    logger.warn(
      "observe: the agent's model configuration could not be built (conv=%s, agent=%s); the tick will be retried",
      String(conversationId),
      String(agentId),
    );
    return {
      outcome: "fail",
      error: "observe: the agent's model configuration could not be built",
    };
  }
  const { mon, cfg, conv } = loaded;
  const flow: FlowContext = {
    tenantId,
    turnId,
    source: "inbox",
    conversationId: conv?.id ?? null,
    agentId,
    inboxId: conv?.inboxId ?? null,
    threadId,
    base,
  };
  const line = (
    status: "ok" | "error" | "skipped",
    detail: Record<string, unknown>,
    level: "info" | "warn" | "error" = status === "ok" ? "info" : "warn",
  ) =>
    emitFlowEvent(flow, {
      stage: "observe",
      level,
      status,
      provider: cfg.mc.provider,
      model: cfg.mc.model,
      detail: { reason, ...detail },
    });

  // A RESOLVE VERDICT IS ABOUT A CONVERSATION THAT IS RESOLVED, and that is asked BEFORE anything is
  // spent (issue #477 review, round 6). A customer message reopens the conversation, and on an
  // `on_resolve` agent that message arms nothing by design, so the row queued for the old resolution
  // survives and would classify a live conversation as if it had ended. The verdict is refused
  // whatever the model would have said, so the tick ends here rather than after a paid call; the
  // same question is asked again before writing, for a reopening that lands mid-call. Only a
  // definite answer refuses: a mirror row that vanished is not a reopening.
  if (reason === "resolved" && conv !== null && conv.status !== "resolved") {
    line("skipped", { skipped: "conversation_reopened" });
    return { outcome: "done" };
  }

  const bot = await loadAgentBot(tenantId, instanceId, agentId, base);
  // MUTED, and this is where the guarantee that a watcher never answers now lives (issue #568).
  // It used to live in `loadAgentConfig`, which refuses to build a config for a monitoring agent at
  // all — and that refusal is why this module had to grow its own model call in the first place: the
  // graph could not run, so a bespoke classifier was written beside it. `loadAgentConfig` keeps
  // refusing for every customer-facing caller, which is what it is for; here the tick loads the
  // config with `ignoreMode` and gets a client that cannot post to the customer instead, so the
  // ordinary graph — the agent's tools, its MCP, its knowledge — can run for a watcher exactly as it
  // does for a responder, minus the one thing a watcher must not do.
  const client: ChatwootClient = await loadChatwootClient(
    tenantId,
    instanceId,
    {
      base,
      botToken: bot?.accessToken,
      makeClient: deps.makeClient,
      mute: true,
    },
  );
  const fetched = await readWindowRows(
    client,
    conversationId,
    mon.window.messages,
  );
  // WHAT THE FORK WOULD HAVE WRITTEN BACK, FROM THE PROCESS THAT HEARD IT (issue #477 review,
  // round 9). Upstream Chatwoot 404s the attachment-meta write-back, so an eager transcription or
  // image description exists only in the in-process annotation store (docs/stt.md). Both the direct
  // turn and the debounce flush overlay it onto their fetched page; without it here, an audio-only
  // or image-only message reaches the model as an attachment with no text at all, and the verdict
  // is about a conversation the observer cannot read. In place, and never over a value the fork
  // did write.
  overlayMediaAnnotations(tenantId, instanceId, fetched);
  // ...AND THE EPISODE THE RESET ENDED IS NOT PART OF THIS ONE. `/reset` clears the labels and the
  // memory, but Chatwoot keeps every message, and this module reads Chatwoot rather than the
  // thread — so without this the next verdict reads the erased episode's demands (and the command
  // itself), finds no labels standing, and writes the old classification straight back, which is
  // the opposite of what the operator was told happened. Applied before the quote resolver is
  // built, so a reply quoting a pre-reset message does not reintroduce its text either.
  const resetBoundary = conv?.resetAtMessageId ?? null;
  const rows =
    resetBoundary === null
      ? fetched
      : fetched.filter((r) => r.id > resetBoundary);
  const transcript = transcriptFromRows(rows, mon.window.messages);
  // Read off the SAME rows, after the reset boundary like everything else: a note about the episode
  // the operator wiped is not part of this one either.
  const notes = notesFromRows(rows, mon.window.messages);
  if (!transcript.some((l) => l.role === "customer")) {
    line("skipped", {
      skipped: "no_customer_message",
      messages: transcript.length,
    });
    return { outcome: "done" };
  }
  // ONE READ, for the prompt block below AND for the tool's comparison baseline. `set_labels` diffs
  // the model's list against what the model was SHOWN, so two reads a few hundred milliseconds apart
  // are two different claims about the same turn: a label this block advertises can be missing from
  // the tool's baseline, and the model repeating it to keep it then reads as an ADDITION — putting
  // back exactly what somebody removed in between. Handed to `buildToolset` for that reason.
  const current = await client.getConversationLabels(conversationId);

  // THE TURN ITSELF, and from here on this is the ordinary graph (issue #568). What used to sit in
  // these lines was a classifier: one model call with a JSON schema built from the operator's label
  // groups, then a deterministic apply that wrote the verdict. It existed because `loadAgentConfig`
  // refuses to build a config for a monitoring agent, so the graph could not run and something had
  // to be written beside it — and the taxonomy screen existed because that something needed to be
  // told what to classify into.
  //
  // With a muted client the graph runs, so a watcher is what it was always meant to be: the ordinary
  // agent, with its tools, its MCP and its knowledge, that cannot answer the customer. Classifying
  // is then one thing it can do with `set_labels`, described in the operator's own prompt, and not a
  // mode with a screen of its own.
  const checkpointer = deps.checkpointer ?? new MemorySaver();
  // A THREAD OF ITS OWN, per agent, and never the conversation's. The responder's memory lives on
  // `chatwootThreadId(...)`; invoking here with that id would checkpoint the watcher's transcript,
  // tool calls and prose into the history the responder replies from. In-memory by default, so a
  // tick is stateless the way the verdict was: the transcript below is rebuilt from Chatwoot every
  // time, which is what makes an observation reproducible from the conversation alone.
  const graphThreadId = `${threadId}:observer:${agentId}`;

  // WHY THE FENCES MOVED. They used to be asked once, after the model call and before the write,
  // because there was exactly one write and it was ours. A turn has as many writes as the model has
  // tool calls, so the same questions are now asked at every tool HOP, which is the seam
  // `buildAgentGraph({stillWanted})` exists for and the one the nudge uses for the same reason: a
  // scheduler job whose world can change while a model call is in flight.
  //
  // Each returns a REASON rather than a boolean, so the flow line can say which door closed — and
  // `unreadable` is kept apart from `no` throughout, because folding a transient read failure into
  // "the operator switched it off" throws away a turn already paid for and says something false on
  // the trail (issue #477, rounds 7, 8 and 10).
  //
  // AND THE TWO ANSWERS END THE TICK DIFFERENTLY, which is the other half of keeping them apart. A
  // withdrawal is done: the operator moved the world and the turn was right to stop, so the job
  // completes. A read that FAILED is a verdict lost, not a verdict declined — nothing re-arms this
  // row on its own, an `on_resolve` agent has no later burst and a resolve happens once, so a
  // transient database blip here is a conversation that is never classified (issue #477 review,
  // round 7). Those fail, and the scheduler retries with backoff up to the cap; the retry spends the
  // model call again, which is the price, and the spend ceiling gates it like every other tick.
  let refusal: string | null = null;
  const fence = async (): Promise<boolean> => {
    if (refusal !== null) return false;
    const observesNow = await agentObservesNow(tenantId, agentId, base);
    if (observesNow !== "yes") {
      refusal =
        observesNow === "unreadable"
          ? "agent_state_unreadable"
          : "agent_no_longer_observes";
      return false;
    }
    const monNow = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { settings: true },
      }),
    )
      .then((row) => (row ? readMonitoringConfig(row.settings) : null))
      .catch(() => "unreadable" as const);
    if (monNow === "unreadable") {
      refusal = "settings_unreadable";
      return false;
    }
    // The arm's own second question, asked again: an operator switching to `on_resolve` while the
    // call is in flight is refusing exactly this turn, and a fence that did not ask let it act.
    if (
      monNow !== null &&
      reason === "burst" &&
      monNow.analysis !== "incremental"
    ) {
      refusal = "analysis_changed";
      return false;
    }
    const rows = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const convNow = await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        },
        // `inboxId` from HERE and not from the load: a conversation moved to another inbox while the
        // model answered leaves the load's snapshot naming the old one, and the binding question
        // would then be about an inbox this conversation is no longer on.
        select: { status: true, resetAtMessageId: true, inboxId: true },
      });
      const claim =
        deps.claim === undefined
          ? null
          : await db.schedulerJob.findUnique({
              where: { id: deps.claim.jobId },
              select: { status: true, claimSeq: true },
            });
      return { convNow, claim };
    }).catch(() => "unreadable" as const);
    // UNREADABLE IS NOT ABSENT: folded into `null`, a failed read says both "no reset happened" and
    // "the conversation is gone", and acts on both — the reset fence answering the one way it must
    // never answer.
    if (rows === "unreadable") {
      refusal = "conversation_unreadable";
      return false;
    }
    const { convNow, claim: claimNow } = rows;
    // A message landing while the model answers re-arms this row, and the scheduler's own CAS
    // notices only after the handler returns — by which point the tools have written.
    if (
      deps.claim !== undefined &&
      !(
        claimNow?.status === "CLAIMED" &&
        claimNow.claimSeq === deps.claim.claimSeq
      )
    ) {
      refusal = "superseded";
      return false;
    }
    if (
      reason === "resolved" &&
      convNow !== null &&
      convNow.status !== "resolved"
    ) {
      refusal = "reopened";
      return false;
    }
    if (resetLandedAfter(p.atMessageId, convNow?.resetAtMessageId ?? null)) {
      refusal = "reset";
      return false;
    }
    if (convNow?.inboxId != null) {
      const onInbox = await agentStillOnInbox(
        tenantId,
        convNow.inboxId,
        agentId,
        base,
      );
      if (onInbox !== "yes") {
        refusal =
          onInbox === "unreadable"
            ? "binding_unreadable"
            : "agent_no_longer_on_inbox";
        return false;
      }
    }
    return true;
  };

  // STARTED BEFORE DISCOVERY, and that is the point: `buildToolset` contacts every MCP server the
  // agent has, and an SSE server that opens the stream and never emits its endpoint waits with no
  // timeout of its own. The deadline used to be created after this call, so the one call that can
  // hang forever was the one call it did not cover.
  const deadline = AbortSignal.timeout(deps.timeoutMs ?? OBSERVE_TIMEOUT_MS);
  let tools: Awaited<ReturnType<typeof buildToolset>>;
  try {
    tools = await underSignal(
      buildToolset(
        cfg,
        {
          tenantId,
          instanceId,
          base,
          client,
          conversationId,
          threadId,
          stillWanted: () => fence(),
          observed: conv ? { status: conv.status, statusAt: null } : undefined,
          conversationLabels: current,
        },
        { buildNativeTools, mcp: deps.mcp, flow },
      ),
      deadline,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    line("error", { failed: "toolset_build" }, "error");
    return { outcome: "fail", error: `observe: ${msg}` };
  }

  let graph: Awaited<ReturnType<typeof buildModelAndGraph>>;
  try {
    graph = await buildModelAndGraph(cfg, tools, {
      makeModel: deps.makeModel,
      checkpointer,
      stillWanted: () => fence(),
      onModelRetry: ({ attempt, provider, model }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { retry: attempt, node: "observer" },
        }),
      onModelFallback: ({ provider, model, reason: why }) =>
        emitFlowEvent(flow, {
          stage: "observe",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { fallbackFrom: cfg.mc.provider, fallbackReason: why },
        }),
      onModelFallbackFailed: ({ provider, model, reason: why }) =>
        emitFlowEvent(flow, {
          stage: "observe",
          level: "info",
          status: "error",
          provider,
          model,
          detail: { fallbackFailed: why },
        }),
      // ...AND THE ONE THAT FIRES BEFORE ANY FAILURE. A fallback the operator configured and that
      // cannot be BUILT — credential deleted, configuration unrunnable — leaves the turn with
      // nothing behind it, which is indistinguishable from having configured none. Reported at
      // build time rather than on the failure, because by then it is too late to be the warning it
      // needs to be, and a tick whose primary keeps answering would otherwise hide it forever.
      onModelFallbackUnavailable: ({ provider, model, reason: why }) =>
        emitFlowEvent(flow, {
          stage: "observe",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { fallbackUnavailable: why },
        }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    line("error", { failed: "model_build" }, "error");
    return {
      outcome: "fail",
      error: `observe: model could not be built: ${msg}`,
    };
  }

  // GATED IMMEDIATELY BEFORE THE BILLED CALL, and immediately is the whole rule (CLAUDE.md,
  // spend-ceiling/coverage.ts names this node). Asked at the top of the tick instead, it answered
  // for every exit that comes before it — a conversation with no customer message yet, a transcript
  // the renderers emptied — each reported as `spend_ceiling` on a tick that was never going to
  // spend anything, which reads on the flow page as a tenant hitting its budget.
  const ceiling = await spendCeilingVerdict({
    tenantId,
    source: "inbox",
    base,
  });
  announceSpendCeiling(flow, ceiling, "inbox", tenantId, {
    key: observeDedupeKey(threadId, agentId),
    windowMs: OBSERVE_CEILING_WINDOW_MS,
  });
  if (ceiling.state === "over") {
    line("skipped", { skipped: "spend_ceiling" });
    return { outcome: "done" };
  }

  // The four `*_unreadable` reasons, by name rather than by suffix: a refusal that is added later
  // and happens to end in the word is a decision about retries, and it should be made here on
  // purpose instead of inherited from how it was spelled.
  const UNREADABLE_REFUSALS = new Set([
    "agent_state_unreadable",
    "settings_unreadable",
    "conversation_unreadable",
    "binding_unreadable",
  ]);
  const endOnRefusal = (why: string): JobResult => {
    if (!UNREADABLE_REFUSALS.has(why)) {
      line("skipped", { skipped: why, messagesRead: transcript.length });
      return { outcome: "done" };
    }
    line("error", { failed: why, messagesRead: transcript.length }, "error");
    return {
      outcome: "fail",
      error: `observe: a fence could not be re-read before writing (${why})`,
    };
  };

  const startedAt = Date.now();
  let toolCalls = 0;
  // A DEADLINE, because this tick runs on the SHARED scheduler. `runSchedulerTick` awaits every
  // handler and `startScheduler` skips the next tick while one is still running, so a provider that
  // never answers does not just lose this observation: it stops reminders and every other scheduled
  // job behind it. The verdict call this replaced carried `AbortSignal.timeout(OBSERVE_TIMEOUT_MS)`
  // and the graph invoke came up without one (round 2 of review).
  //
  // BOTH HALVES, and they answer different questions. The signal in the config is what the model
  // client receives, so the provider request is actually cancelled rather than left in flight;
  // `underSignal` is what guarantees THIS function stops waiting, whatever a link in the chain does
  // with the signal it was handed. The scheduler's problem is the waiting, not the socket.
  try {
    const result = await underSignal(
      graph.invoke(
        {
          messages: [
            new HumanMessage(observeTurnText(transcript, current, notes)),
          ],
        },
        {
          signal: deadline,
          // The budget the operator set is only reachable if the graph is allowed the steps it
          // takes: LangGraph counts super-steps and its default runs out at about twelve rounds.
          recursionLimit: recursionLimitFor(cfg.maxToolCalls),
          configurable: { thread_id: graphThreadId },
          // THE TOOL LOGGER TOO, exactly as the reactive runtime installs it. `buildCallbacks`
          // carries usage capture and the optional trace; the per-tool line is separate, and
          // without it a watcher whose HTTP or MCP tool answers `toolFailure` finishes the graph
          // normally and this job reports `ok` with `acted: true` — a tool error with no line and
          // no alert. There is no second copy to fall back on either: the observer's checkpoint is
          // thrown away, so an install without Langfuse loses the diagnostic entirely.
          callbacks: [
            ...buildCallbacks(cfg, {
              tenantId,
              threadId,
              node: "observer",
              model: cfg.mc.model,
              conversationId: conv?.id ?? null,
              source: "inbox",
              turnId,
              base,
              tools,
            }),
            new ToolFlowLogger(flow, { logValues: cfg.logToolValues, tools }),
          ],
        },
      ),
      deadline,
    );
    // WHAT THE TURN DID is its tool calls, never its prose: there is no reply channel here, so the
    // final text is the model talking to a wall. Counted for the trail and dropped.
    for (const m of (result as { messages?: BaseMessage[] }).messages ?? []) {
      const calls = (m as { tool_calls?: unknown[] }).tool_calls;
      if (Array.isArray(calls)) toolCalls += calls.length;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // A REFUSED FENCE IS NOT A MODEL FAILURE. `stillWanted` stops the turn by refusing the tool
    // node, and whatever that surfaces as, the exception is not what went wrong — the world moved.
    // Whether the tick is DONE or retried is the fence's own answer, not this catch's.
    if (refusal !== null) return endOnRefusal(refusal);
    emitFlowEvent(flow, {
      stage: "observe",
      level: "error",
      status: "error",
      provider: cfg.mc.provider,
      model: cfg.mc.model,
      durationMs: Date.now() - startedAt,
      detail: { reason, failed: "model_call" },
      errorMessage: msg,
    });
    return { outcome: "fail", error: `observe: ${msg}` };
  }
  if (refusal !== null) return endOnRefusal(refusal);
  emitFlowEvent(flow, {
    stage: "observe",
    level: "info",
    status: "ok",
    provider: cfg.mc.provider,
    model: cfg.mc.model,
    durationMs: Date.now() - startedAt,
    detail: {
      reason,
      acted: toolCalls > 0,
      toolCalls,
      messagesRead: transcript.length,
      labelsBefore: current.length,
    },
  });
  return { outcome: "done" };
}

export async function observeHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const p = parseObservePayload(job.payload);
  if (!p) return { outcome: "done" };
  return runObserve(job.tenantId, p, base, {
    claim: { jobId: job.id, claimSeq: job.claimSeq },
  });
}

let registered = false;
export function registerObserveHandler(): void {
  if (registered) return;
  registered = true;
  registerJobHandler("OBSERVE", observeHandler);
}
