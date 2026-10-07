import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { type BaseMessage, HumanMessage } from "@langchain/core/messages";
import { ToolInputParsingException } from "@langchain/core/tools";
import { MemorySaver } from "@langchain/langgraph";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
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
import { SKIP_REPLY_TOOL } from "@/graph/silence";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import { UTILITY_NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { isEffectFreeTool } from "@/graph/tools/effect-free";
import { modelVisibleLabels } from "@/graph/tools/label-view";
import type { LabelWrite } from "@/graph/tools/label-writes";
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
import { resetAckSendId } from "@/modules/chatwoot/constants";
import {
  type LoadChatwootClientDeps,
  loadAgentBot,
  loadChatwootClient,
} from "@/modules/chatwoot/instance";
import { labelsNarrated } from "@/modules/chatwoot/label-activity";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  parseChatwootMessages,
  toRenderable,
} from "@/modules/chatwoot/messages";
import {
  renderAttendantMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";
import { loadChatwootLabels } from "@/modules/chatwoot/vocab";
import { underSignal } from "@/modules/contact-auth/check";
import { observerRuleVerdict } from "@/modules/contact-auth/observer";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import {
  type ClaimedJob,
  type Rearm,
  retireUnlessAllowedLaterOn,
  upsertJobRow,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  announceSpendCeiling,
  spendCeilingVerdict,
} from "@/modules/spend-ceiling/service";
import { type MonitoringConfig, readMonitoringConfig } from "./settings";

// The OBSERVE job: a monitoring agent's turn on a conversation it does not answer
// (docs/chatwoot.md, Observation). THE TICK IS STATELESS: it reads the newest messages from
// Chatwoot, not the memory thread, because that thread is keyed by contact-inbox and not by agent
// (an observer beside a responder would read the responder's summaries, and history older than the
// observer is not in it). Then the ordinary turn on a muted client (`buildToolset` and
// `buildModelAndGraph`): this file only guarantees that nothing reaches the customer and that the
// tick stops when the world moves.

export type ObserveReason = "burst" | "resolved";

// THE WHOLE TICK'S BUDGET, discovery included: `runSchedulerTick` awaits every handler and
// `startScheduler` skips the next tick while one runs, so an MCP server that never answers would
// stop every tenant's scheduled work. Long enough for a multi-call turn, and well under the
// scheduler's 5-minute stale window, so the reaper never treats a live claim as abandoned.
export const OBSERVE_TIMEOUT_MS = 120_000;
export const OBSERVE_CEILING_WINDOW_MS = 10 * 60_000;

// HOW EACH FENCE REFUSAL ENDS THE TICK, one entry per refusal, so a new refusal is a type error
// until both questions are answered: is it retried, and does its `skipped` line need an operator.
// `retry`: the failed reads, and a binding not landed yet (the world has not settled). `info`:
// every withdrawal (re-armed, reopened, reset, switched off, analysis changed, off the inbox),
// because the tick is RIGHT to stop and a `warn` would page the alert channel for nothing.
const REFUSAL_ENDING = {
  agent_state_unreadable: "retry",
  settings_unreadable: "retry",
  conversation_unreadable: "retry",
  binding_unreadable: "retry",
  binding_attaching: "retry",
  superseded: "info",
  reopened: "info",
  reset: "info",
  analysis_changed: "info",
  agent_no_longer_observes: "info",
  agent_no_longer_on_inbox: "info",
  contact_auth_refused: "info",
  contact_auth_unreadable: "retry",
} as const satisfies Record<string, "retry" | "info" | "warn">;
type Refusal = keyof typeof REFUSAL_ENDING;

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
// A label-change line is "<somebody> <verb> <label>", each part short, and the block rides on every
// observation, so a line has a size to fit in. Over it the line is REFUSED, not cut: a clipped
// sentence loses the later labels of a multi-label change, and in a verb-final language the verb.
const LABEL_CHANGE_MAX_CHARS = 200;
const LABEL_CHANGES_MAX = 8;
// Every block tag the prompt fences. `notas-internas` is written by people (a pasted prompt, a
// quoted customer) and `mudancas-de-etiqueta` wraps labels the model wrote (Chatwoot's tag list
// accepts what the catalog refuses), so a closing tag can arrive inside either and end it early.
const FENCE_TAG =
  /<\s*\/?\s*(transcricao|etiquetas-atuais|notas-internas|mudancas-de-etiqueta)[^>]*>/gi;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// One row per CONVERSATION and AGENT: a burst re-arms it, a resolve pulls it forward, and its own
// prefix keeps it apart from the responder's `debounce:` row. The agent is in the key because an
// inbox can have two watchers at once (a monitoring responder and a separate observer), each with
// its own prompt and tools; keyed by conversation alone, the last delivery would decide who looks.
export function observeDedupeKey(threadId: string, agentId: bigint): string {
  return `${observeKeyPrefix(threadId)}${String(agentId)}`;
}

// Every agent's row on ONE conversation, for the caller that retires them together: the key carries
// the agent, so a conversation's rows are a prefix and not a key.
export function observeKeyPrefix(threadId: string): string {
  return `observe:${threadId}:`;
}

// The watcher's endpoint refused this conversation at an arm: retires its queued observation unless
// an allow asked after this refusal armed it, and leaves the refusal's ask time on the row, under the
// arm's lock, so an allow asked before it and still in flight (a delivery waiting on its media pass)
// cannot re-arm what the refusal retired (`ArmObserveParams.gateAskedAt`). With no row yet, a DONE
// one is created to carry the mark.
export async function retireRefusedObserve(p: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentId: bigint;
  askedAt: number;
  base: PrismaClient;
}): Promise<void> {
  const threadId = chatwootThreadId(p.tenantId, p.instanceId, p.conversationId);
  const dedupeKey = observeDedupeKey(threadId, p.agentId);
  await runScopedOn(p.base, sysCtx(p.tenantId), (db) =>
    withEntityLock(db, `observe-arm:${threadId}`, async () => {
      await retireUnlessAllowedLaterOn(db, {
        tenantId: p.tenantId,
        kind: "OBSERVE",
        dedupeKey,
        at: p.askedAt,
        allowedField: "gateAllowedAt",
        refusedField: "gateRefusedAt",
        // A resolution's verdict retired before it ran is not one this resolution already has.
        unrunFields: ["resolveMark"],
        createPayload: {
          instanceId: String(p.instanceId),
          conversationId: p.conversationId,
          agentId: String(p.agentId),
        },
      });
    }),
  );
}

function readGateMark(
  payload: unknown,
  field: "gateRefusedAt" | "gateAllowedAt",
): number | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[field];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
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
  // THE MESSAGE THIS BURST WAS ARMED ON, the only coordinate the reset fence can be asked in:
  // `/reset` retires PENDING rows, but a tick already claimed would write back the labels it
  // cleared. Chatwoot's message id is the order the operator experienced, so a turn at or below the
  // command's id is about the erased episode. Null on a resolve, which the reopen check covers (the
  // command reopens it).
  atMessageId?: number | null;
  // WHEN THE GATE'S ALLOW WAS ASKED (`observerArmPermit`). A refusal asked at or after it has
  // retired the row and left its own ask time there (`retireRefusedObserve`); this arm then arms
  // nothing, since the newer answer is the refusal. Absent, the arm is not fenced.
  gateAskedAt?: number;
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

// Arms (or re-arms) the one OBSERVE row of a conversation and agent. `off` when a burst arrives on
// an agent that only looks at the end, or when this resolution already has its tick. The caller
// (the receiver or the flush) does not treat a failure here as its own: a late observation is not a
// lost message. Same shape as the responder's debounce arm: a live PENDING burst keeps its retry
// budget.
export async function armObserve(
  p: ArmObserveParams,
): Promise<"armed" | "off" | "failed"> {
  // NOTE: OBSERVATION IS THE MODE, and nothing else switches it on: an enabled monitoring agent on
  // the inbox is one the operator wants looking. Switching it off is disabling it or taking it off.
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
        // A PENDING row is the burst this message joins only when it IS a burst: a customer
        // reopening before a resolve's tick is claimed opens a NEW burst, which would otherwise
        // inherit the resolve's `burstStartedAt` and run at once. ONE TICK PER RESOLUTION (see
        // `mark`), read whatever the row's status. AT OR BELOW, not equal: the mark only moves
        // forward, so a lower one is a late echo of an older resolution, and arming on it would
        // bill the current one twice. A burst clears the mark.
        // A refusal asked at or after this arm's allow is the newer answer, and it retired the row.
        const gateRefusedAt = readGateMark(existing?.payload, "gateRefusedAt");
        if (
          p.gateAskedAt != null &&
          gateRefusedAt !== null &&
          gateRefusedAt >= p.gateAskedAt
        ) {
          armed = false;
          return;
        }
        const allowedBefore = readGateMark(existing?.payload, "gateAllowedAt");
        const gateAllowedAt =
          p.gateAskedAt != null || allowedBefore !== null
            ? Math.max(p.gateAskedAt ?? 0, allowedBefore ?? 0)
            : null;
        const recordedMark = readResolveMark(existing?.payload);
        if (
          p.reason === "resolved" &&
          p.mark != null &&
          recordedMark !== null &&
          recordedMark >= p.mark
        ) {
          // Not re-armed, but a newer allow is kept: a refusal asked before it and landing late
          // must still find the row authorized after it (`retireRefusedObserve`).
          if (
            gateAllowedAt !== null &&
            gateAllowedAt !== allowedBefore &&
            existing
          ) {
            await db.schedulerJob.updateMany({
              where: { kind: "OBSERVE", dedupeKey },
              data: {
                payload: {
                  ...(existing.payload as Record<string, unknown>),
                  gateAllowedAt,
                } as Prisma.InputJsonValue,
              },
            });
          }
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
            // Carried across re-arms, so an allow asked before the refusal and landing after a newer
            // one still finds it.
            ...(gateRefusedAt !== null ? { gateRefusedAt } : {}),
            // The newest allow behind this row, so a refusal asked before it and landing late
            // leaves the row runnable (`retireRefusedObserve`).
            ...(gateAllowedAt !== null ? { gateAllowedAt } : {}),
            // NOTE: ...and the NEWEST message of the burst: the MAXIMUM, not the last to arrive.
            // Chatwoot delivers out of order, and a delayed older delivery pushing the id backwards
            // would let a reset between the two discard the whole burst, the valid new message with
            // it.
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
  // The row this tick is running FOR, so the generation fence can ask whether it still is. Optional
  // because `runObserve` is callable without the scheduler.
  claim?: { jobId: bigint; claimSeq: number };
  // The turn's deadline, injectable so a test can assert the tick gives up without waiting a
  // minute for it. Production never passes it.
  timeoutMs?: number;
  // The fetch the outbound tools use, injectable like makeClient and makeModel, since the observer
  // runs the ordinary toolset. Production never passes it.
  outboundFetch?: typeof fetch;
}

// A ROW THE TRANSCRIPT CAN USE. Factored out of `transcriptFromRows` so the paging below counts the
// same thing the window measures: private notes, reactions and activity rows are not messages.
function usableRow(m: ChatwootMessageRow): boolean {
  return (
    !m.private &&
    !m.isReaction &&
    (m.messageType === "incoming" ||
      m.messageType === "outgoing" ||
      // NOTE: a TEMPLATE IS THE ATTENDANT SPEAKING: Chatwoot files a customer-facing template send
      // under its own `message_type`, and without it a terse "sim" reaches the model without its
      // question. Activity lines stay out: they are the system narrating.
      m.messageType === "template")
  );
}

// PAGED BACKWARDS UNTIL THE WINDOW IS FULL: one read is Chatwoot's newest page (about twenty RAW
// rows, fewer usable), and `window.messages` goes to sixty. `before` walks older (the fork's
// MessageFinder honours it). BOUNDED: five pages cover the window's own ceiling, and a page adding
// no older row is the start of the conversation.
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
    // NOTE: ...AND THE MESSAGES THE WINDOW QUOTES: a reply can quote something on an older page,
    // and a "sim" without its question is what the quote resolver exists for. Only rendered rows
    // are asked about, within the same page bound.
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

// What the label-history block renders: the lines it recognised, and whether that is ALL of them.
// A line can be recognised in a reading that was still incomplete (a change too long to scan, a
// source that did not answer). `complete` is not a count: a failed source leaves no number.
export interface LabelHistoryForPrompt {
  lines: readonly string[];
  complete: boolean;
}

// The observation frame appended to the agent's own prompt, in the product's language: what the
// agent cannot know on its own (it is reading, with no reply channel). What to do with the
// conversation is the operator's prompt. The last line keeps a quiet tick at one model call.
export function observeTurnText(
  transcript: readonly TranscriptLine[],
  // `null` is "we could not read them", which is NOT "there are none": the second would let the
  // model clear labels it never saw.
  current: readonly string[] | null,
  notes: readonly string[] = [],
  // `null` is "no vocabulary to recognise a label change by", which is not "nothing changed"; the
  // block says which. Otherwise the lines AND whether they are all of them, so the block can say
  // "here is what I read, and it is not all of it".
  labelChanges: LabelHistoryForPrompt | null = null,
): string {
  return [
    "Turno de observação: você está acompanhando esta conversa e NÃO responde a ninguém.",
    "Não existe canal de resposta aqui: qualquer texto que você escrever não chega a lugar nenhum, nem ao cliente nem à equipe.",
    "O que você faz neste turno é agir sobre a conversa com as ferramentas que tem: etiquetar, anotar em nota privada, registrar atributo, mover o card, o que o seu papel pedir.",
    "Cada turno começa do zero: o que você já fez nesta conversa está no que está registrado nela, não na sua memória.",
    // NOTE: an action with an effect OUTSIDE the conversation (an HTTP call, a booking) leaves
    // nothing here, and the next burst reads an overlapping window with the same evidence. The note
    // channel is the trace, so the frame asks for it and to read it back. A mitigation, not a
    // guarantee.
    "Uma ação com efeito FORA desta conversa (chamada a sistema externo, agendamento, cobrança) não deixa rastro aqui: ao fazer uma, registre em nota privada o que foi feito, e não repita a que já estiver registrada.",
    "As notas abaixo são as que aparecem na janela que você está lendo; pode haver outras mais antigas que não estão aqui.",
    "Se nada precisa mudar em relação ao que já está registrado, não chame ferramenta nenhuma.",
    "",
    // NOTE: stripped like the notes and the transcript: `set_labels` sends the model's strings to
    // Chatwoot, whose tag list accepts what the catalog refuses, so a label can carry this block's
    // closing tag. The tool's XML renderer escapes; this plain-text block strips.
    `<etiquetas-atuais>${
      current === null
        ? "(não foi possível ler)"
        : current.length
          ? current.map((l) => stripFences(l).trim()).join(", ")
          : "(nenhuma)"
    }</etiquetas-atuais>`,
    "",
    // NOTE: THE NOTES THE CONVERSATION ALREADY CARRIES: the tick is stateless, so "don't write if
    // nothing changed" can only be answered against what is WRITTEN, and the transcript is public
    // messages only. A separate block, since a note is not somebody talking. Scoped to the window
    // read, and it says so: "(nenhuma nesta janela)" is a different, true claim from "(nenhuma)".
    `<notas-internas escopo="janela-lida">${
      notes.length
        ? `\n${notes.map((n) => `- ${n}`).join("\n")}\n`
        : "(nenhuma nesta janela)"
    }</notas-internas>`,
    "",
    // NOTE: WHAT ALREADY CHANGED, for the same reason: a decision the model cannot see it makes
    // again. Rendered even when empty, saying which empty. A partial reading shows what it has AND
    // says it is incomplete; with nothing to show, incomplete reads as "could not read".
    `<mudancas-de-etiqueta escopo="janela-lida"${
      labelChanges !== null && !labelChanges.complete
        ? ' leitura="incompleta"'
        : ""
    }>${
      labelChanges === null
        ? "(não foi possível ler)"
        : labelChanges.lines.length
          ? `\n${labelChanges.lines.map((c) => `- ${c}`).join("\n")}\n${
              labelChanges.complete
                ? ""
                : "(houve mudança nesta janela que não pôde ser lida: esta lista não está completa)\n"
            }`
          : labelChanges.complete
            ? "(nenhuma nesta janela)"
            : "(não foi possível ler)"
    }</mudancas-de-etiqueta>`,
    "",
    "<transcricao>",
    renderTranscript(transcript),
    "</transcricao>",
  ].join("\n");
}

// A line longer than this is not one of Chatwoot's sentences with a handful of titles in it, and
// refusing to scan it is also what keeps 74 patterns off text nobody bounded.
const ACTIVITY_SCAN_MAX_CHARS = 2_000;

// DOES THIS LINE NAME A GUARDED LABEL ANYWHERE IN IT, as a word and not as a fragment. Asked beside
// the titles the template names, because the two are different questions: a title can also land in
// the ACTOR's half of the sentence (an agent whose display name is the guarded label), and the
// guard's promise is that the model never sees the string, not that it never sees it in one
// position. The list is at most 50 titles (`settings.setLabels.protected`).
function namesGuardedTitle(text: string, guard: ReadonlySet<string>): boolean {
  const boundary = (ch: string | undefined) =>
    ch === undefined || !/[\p{L}\p{N}]/u.test(ch);
  for (const title of guard) {
    if (title.length === 0) continue;
    for (
      let at = text.indexOf(title);
      at >= 0;
      at = text.indexOf(title, at + 1)
    ) {
      if (boundary(text[at - 1]) && boundary(text[at + title.length])) {
        return true;
      }
    }
  }
  return false;
}

// WHAT WAS ALREADY DECIDED ON THIS CONVERSATION: Chatwoot's label activity lines, forwarded
// VERBATIM and selected by the template Chatwoot rendered them from (`labelsNarrated`). A title
// must be a label in the account's catalog or on the conversation; a row declaring its own activity
// type is not read; guarded labels refuse the line whole. docs/chatwoot.md (Observation) has the
// reasoning.
export interface LabelHistory {
  lines: string[];
  // Lines that ARE changes and could not be shown whole. Non-zero means the block may not claim the
  // window was quiet, as a failed read may not.
  omitted: number;
}

// An array of strings or nothing. A single element of another type disqualifies the whole value
// rather than being dropped: a column value this build did not write cannot be repaired into one it
// did, and a set read half-right would hide the lines of the titles that survived.
export function stringArrayOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.every((e) => typeof e === "string") ? (v as string[]) : null;
}

// The rows past the reset boundary MINUS the reset's own cleanup (docs/chatwoot.md, Observation): a
// removal line whose titles are all in `cleared` is the reset's own, each title consumed once, and
// the acknowledgement's row (`resetAckSendId`) cuts every activity the command wrote before it.
export function afterResetNarration(
  // THE PAGE AS FETCHED, boundary included, filtered here: whether the window still REACHES the
  // command decides how an ambiguous pair of lines is read below.
  fetched: ChatwootMessageRow[],
  resetBoundary: number | null,
  // WHAT THE RESET SAYS IT REMOVED, from `conversations.reset_cleared_labels` (our row, because the
  // ack's `content_attributes` reach the CONTACT on a website inbox). NULL is a reset that made no
  // claim, the only case that falls back to the order cut alone.
  cleared: string[] | null,
): ChatwootMessageRow[] {
  if (resetBoundary === null) return fetched;
  const rows = fetched.filter((r) => r.id > resetBoundary);
  // THE TWO CUTS ARE JOINED: the set answers for the titles THIS reset removed, at any id;
  // the ack's row for everything the command wrote before it, which alone covers a PREVIOUS reset's
  // late removal line. Its price: a colleague's label change between the command and its ack is
  // lost.
  const marker = resetAckSendId(resetBoundary);
  const ack = rows.find((r) => r.sendId === marker);
  // ...AND THE ORDER CUT IS APPLIED LAST, after the walk reads every row past the boundary:
  // the cleanup's removal line usually sits BELOW the ack, and cutting first would leave its titles
  // unspent.
  const orderCut = (r: ChatwootMessageRow) =>
    ack === undefined || r.messageType !== "activity" || r.id > ack.id;
  // NO SET, NO CONTENT TEST, and then the order cut is all there is.
  if (cleared === null) return rows.filter(orderCut);
  const pending = new Set(cleared.map((t) => t.trim()).filter((t) => t !== ""));
  // WHETHER THE CLEANUP'S OWN ROW IS STILL REACHABLE. With the command in the page, everything
  // Chatwoot wrote since the reset is in it too, so the cleanup's line is somewhere in these rows
  // and the budget has to be kept for it. With the page truncated above the command, the line may
  // have aged out, and a budget held for a row nobody will ever read hides real removals forever.
  const reachesCommand = fetched.some((r) => r.id <= resetBoundary);
  const dropped = new Set<number>();
  // NOTE: in id order, because consuming a title is order-dependent; the rows are returned in the
  // order they came in.
  for (const r of [...rows].sort((a, b) => a.id - b.id)) {
    // CONSUMPTION IS A LIMITED RESOURCE, so only a row that could BE Chatwoot's own narration may
    // spend a title. A private note and a row that declares its own kind are neither (Chatwoot
    // writes the label activity public and with no `content_attributes` at all), and a title spent
    // by one of them would hide the real removal line that comes after it. Same three questions the
    // reader below asks, for the same reason.
    if (r.messageType !== "activity" || r.private) continue;
    if (r.activityType !== null) continue;
    // A row too long to SCAN goes unread here exactly as it does below, so a reset that removed
    // hundreds of labels at once keeps its line AND is counted as an omission. That is the reader's
    // own limit, not a second one: filtering it here would make the block report a hidden change
    // over the very cleanup this function exists to hide.
    if (r.content.length > ACTIVITY_SCAN_MAX_CHARS) continue;
    const readings = labelsNarrated(r.content);
    // NOTE: A TITLE PUT BACK IS NOT PENDING ANY MORE, but only where the cleanup's own line is out
    // of reach. `[added A, removed A]` is identical in both regimes, so the page's reach decides: a
    // truncated page holds no budget for a row it will never see, a complete one never spends it on
    // an addition.
    if (!reachesCommand)
      for (const r0 of readings)
        if (r0.kind === "added") for (const t of r0.titles) pending.delete(t);
    // ...AND ONLY A REMOVAL CAN BE THE CLEANUP'S OWN LINE, so an addition whose Sidekiq job
    // landed out of order cannot spend the title and let the real removal through.
    const removal = readings.find(
      (r0) => r0.kind === "removed" && r0.titles.every((t) => pending.has(t)),
    );
    if (removal === undefined) continue;
    for (const t of removal.titles) pending.delete(t);
    dropped.add(r.id);
  }
  return rows.filter((r) => !dropped.has(r.id) && orderCut(r));
}

export function labelHistoryFromRows(
  rows: ChatwootMessageRow[],
  vocabulary: readonly string[] | null,
  guarded: readonly string[] | undefined,
  limit: number,
): LabelHistory {
  if (vocabulary === null) return { lines: [], omitted: 0 };
  const guard = new Set(guarded ?? []);
  const known = new Set(
    vocabulary.map((l) => l.trim()).filter((l) => l !== ""),
  );
  if (known.size === 0) return { lines: [], omitted: 0 };
  // A row too long to SCAN is a row nobody read, so it is counted like one too long to SHOW
  // (`set_labels` takes an unbounded list, so this application produces such rows). The guard is
  // checked FIRST and stays silent: a count appearing only on conversations carrying a guarded
  // label would itself narrate that label.
  let unread = 0;
  const recognised = rows
    .filter((m) => {
      if (m.messageType !== "activity" || m.private) return false;
      if (m.activityType !== null) return false;
      if (namesGuardedTitle(m.content, guard)) return false;
      if (m.content.length > ACTIVITY_SCAN_MAX_CHARS) {
        // NOTE: ...AND ONLY IF IT COULD HAVE BEEN ONE: recognition needs every title to be a label
        // this account has, so a long line naming none is not a change. The substring test
        // over-counts, which is the safe direction.
        if ([...known].some((t) => m.content.includes(t))) unread += 1;
        return false;
      }
      const readings = labelsNarrated(m.content);
      if (readings.length === 0) return false;
      // NOTE: ANY reading naming a guarded label refuses the line: a locale that glues a particle
      // onto the title (Korean `vip을(를)`) escapes the word-boundary scan above.
      if (readings.some((r) => r.titles.some((t) => guard.has(t))))
        return false;
      // And ONE reading whose titles this account actually has is what makes the line a change.
      // The verb is not asked here: this block forwards the sentence whole, so what it needs to
      // know is that a label MOVED, not which way.
      return readings.some((r) => r.titles.every((t) => known.has(t)));
    })
    .sort((a, b) => a.id - b.id);
  // THE CAP HIDES CHANGES TOO: `escopo="janela-lida"` says where the block looked, not that
  // all it found is in it, so what the cap removes is counted like anything else nobody could show.
  const capped = Math.max(0, recognised.length - limit);
  const changes = recognised
    .slice(-limit)
    .map((m) =>
      stripFences(m.content)
        .trim()
        .replace(/\s*\n\s*/g, " "),
    )
    .filter((t) => t.length > 0);
  // WHOLE OR NOT AT ALL: a clipped sentence drops later labels and, in a verb-final language
  // ("Hans hat vip, …, x hinzugefügt"), the verb. An over-long line is left out and counted.
  const lines = changes.filter((t) => t.length <= LABEL_CHANGE_MAX_CHARS);
  return { lines, omitted: changes.length - lines.length + unread + capped };
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
            // NOTE: `toRenderable`, not spelled here, so an email's subject reaches the observer as
            // it reaches the turn and the memory fold (a subject-only email is not a blank line).
            toRenderable(m),
            // NOTE: WHAT A REPLY IS ANSWERING, resolved off the rows the window fetched (as the
            // debounce path does), so a quoted "sim" reaches the model with the demand it answers.
            { resolveQuoted },
          )
        : renderAttendantMessage({
            text: m.content,
            attachmentTypes: m.attachmentTypes,
            // Filled by `overlayMediaAnnotations` above for a reply this process just spoke, and by
            // the attachment's own meta on the fork.
            transcribedText: m.transcribedText,
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

// STILL ON THE INBOX, not merely still a monitoring agent: an unobserve changes neither the agent
// nor the queued OBSERVE row. Asked of BOTH bindings (a monitoring agent may be the responder). A
// failed read, or an inbox the conversation does not name yet, keeps the tick. An unstamped
// observer row is an attach in flight: `attaching`, retried, since acting on it could still be
// taken back and completing on it is permanent for a resolve.
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
      // NOTE: the RESPONDER binding first; it is a column on the inbox, written in one statement,
      // so it is never pending.
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

  // NOTE: THE CLAIM, ASKED BEFORE ANYTHING IS PAID FOR: a claimed row can wait seconds for a
  // provider permit, and a message in that wait re-arms it. The tool-boundary fence would refuse
  // the write only after the model was paid. Unreadable proceeds: that fence is still ahead.
  if (deps.claim !== undefined) {
    const claim = deps.claim;
    const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.schedulerJob.findUnique({
        where: { id: claim.jobId },
        select: { status: true, claimSeq: true },
      }),
    ).catch(() => "unreadable" as const);
    if (
      row !== "unreadable" &&
      !(row?.status === "CLAIMED" && row.claimSeq === claim.claimSeq)
    ) {
      return { outcome: "done" };
    }
  }

  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { name: true, enabled: true, mode: true, settings: true },
    });
    if (!agent?.enabled || !isMonitoring(agent.mode)) return null;
    const settings = agent.settings;
    const mon = readMonitoringConfig(agent.settings);
    // NOTE: THE ARM'S OWN REFUSAL, asked again against the configuration now: a burst queued while
    // the agent was `incremental` outlives a flip to `on_resolve`, which does not retire the row.
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
        // NOTE: read with the boundary, from the same row, so a second `/reset` cannot land between
        // them.
        resetClearedLabels: true,
      },
    });
    const cfg = await loadAgentConfig(
      db,
      { tenantId, instanceId, conversationId, agentId, threadId },
      { skipExperiment: true, ignoreMode: true },
    );
    // NOTE: A CONFIG THAT DOES NOT BUILD IS NOT AN AGENT THAT STOPPED OBSERVING: the checks above
    // are operator states and end the job; this is a credential the vault cannot hand over, and it
    // retries. The CONV goes with it, so the stale-state fences below run before the retry.
    if (!cfg) return { noModel: true as const, conv, settings };
    return { mon, cfg, conv, settings };
  });
  if (loaded !== null && loaded.conv?.inboxId != null) {
    const onInbox = await agentStillOnInbox(
      tenantId,
      loaded.conv.inboxId,
      agentId,
      base,
    );
    // NOTE: A ROW THAT HAS NOT LANDED IS NOT A DETACH: armed off the attach window, it reads like
    // one on the row alone, and completing would be permanent for a RESOLVE (`resolveMark`
    // suppresses later deliveries). So it retries; an attachment the mirror never records
    // dead-letters.
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
  // THE CONTACT GATE'S RULE, asked again before anything is spent and before the model's own
  // configuration is required: the arm asked it, but a label removed or a rule tightened since then
  // leaves this row runnable, and an excluded conversation must complete even when no model could run.
  const ruled = await observerRuleVerdict(
    {
      tenantId,
      instanceId,
      conversationId,
      agentId,
      settings: loaded.settings,
      base,
    },
    { emit: true },
  );
  if (ruled === "unreadable") {
    return {
      outcome: "fail",
      error: "observe: the contact gate's rule could not be evaluated",
    };
  }
  if (ruled === "refused" && "noModel" in loaded) {
    logger.info(
      "observe: the contact gate's rule no longer covers this conversation (conv=%s); nothing to do",
      String(conversationId),
    );
    return { outcome: "done" };
  }
  if ("noModel" in loaded) {
    // NOTE: A MOOT JOB IS NOT RETRIED: a resolve tick on a conversation that reopened is asked
    // here, before a missing credential counts as retryable, so it does not dead-letter work nobody
    // wants.
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
  // WHAT THE OBSERVATION WROTE, so the line can say it: Chatwoot keeps no history of a label
  // write. Collected from the tool, filtered to the operator's vocabulary (label-writes.ts),
  // because the `tool` line carries values only under `logToolValues`, which logs every tool's
  // arguments.
  const labelWrites: LabelWrite[] = [];
  // Declared above `line` because every exit after a write carries it: a committed label is
  // never retried, so a line without it loses the write. Absent on exits before any tool ran.
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
      detail: {
        reason,
        ...detail,
        ...(labelWrites.length > 0 ? { labels: labelWrites } : {}),
      },
    });

  // NOTE: A RESOLVE TICK IS ABOUT A RESOLVED CONVERSATION, asked BEFORE anything is spent: on an
  // `on_resolve` agent the reopening message arms nothing, so the old row survives. Asked again
  // before writing, for a reopening mid-call. A mirror row that vanished is not a reopening.
  if (reason === "resolved" && conv !== null && conv.status !== "resolved") {
    // NOTE: `info`, as its twin `reopened` at the fence: the tick is right to stop.
    line("skipped", { skipped: "conversation_reopened" }, "info");
    return { outcome: "done" };
  }

  if (ruled === "refused") {
    line("skipped", { skipped: "contact_auth_refused" }, "info");
    return { outcome: "done" };
  }

  const bot = await loadAgentBot(tenantId, instanceId, agentId, base);
  // MUTED: this is where the guarantee that a watcher never answers lives. `loadAgentConfig`
  // keeps refusing monitoring agents for every customer-facing caller; here `ignoreMode` plus a
  // client that cannot post to the customer lets the ordinary graph run. THE TICK'S DEADLINE covers
  // all that follows and, through `expiresOn`, any write a tool handler is still making when it
  // fires: aborting the invoke does not stop a handler mid-sequence.
  const deadline = AbortSignal.timeout(deps.timeoutMs ?? OBSERVE_TIMEOUT_MS);
  const client: ChatwootClient = await loadChatwootClient(
    tenantId,
    instanceId,
    {
      base,
      botToken: bot?.accessToken,
      makeClient: deps.makeClient,
      mute: true,
      expiresOn: deadline,
    },
  );
  const fetched = await readWindowRows(
    client,
    conversationId,
    mon.window.messages,
  );
  // NOTE: upstream Chatwoot 404s the attachment-meta write-back, so an eager transcription or image
  // description may exist only in the in-process annotation store (docs/stt.md). Overlaid as the
  // direct turn and the flush do, never over a value the fork did write.
  overlayMediaAnnotations(tenantId, instanceId, fetched);
  // ...AND THE EPISODE THE RESET ENDED IS NOT PART OF THIS ONE. `/reset` clears the labels and the
  // memory, but Chatwoot keeps every message, and this module reads Chatwoot rather than the
  // thread — so without this the next verdict reads the erased episode's demands (and the command
  // itself), finds no labels standing, and writes the old classification straight back, which is
  // the opposite of what the operator was told happened. Applied before the quote resolver is
  // built, so a reply quoting a pre-reset message does not reintroduce its text either.
  const resetBoundary = conv?.resetAtMessageId ?? null;
  // A `Json?` column, READ rather than trusted: NULL is a reset that made no claim, and
  // anything but an array of strings is a row this build did not write.
  const resetCleared = stringArrayOrNull(conv?.resetClearedLabels);
  const rows =
    resetBoundary === null
      ? fetched
      : fetched.filter((r) => r.id > resetBoundary);
  const transcript = transcriptFromRows(rows, mon.window.messages);
  // Read off the SAME rows, after the reset boundary like everything else: a note about the episode
  // the operator wiped is not part of this one either.
  const notes = notesFromRows(rows, mon.window.messages);
  if (!transcript.some((l) => l.role === "customer")) {
    // NOTE: `info`: nothing to observe yet is not a problem anybody can fix.
    line(
      "skipped",
      { skipped: "no_customer_message", messages: transcript.length },
      "info",
    );
    return { outcome: "done" };
  }
  // ONE READ, for the prompt block AND `set_labels`' baseline: the tool diffs against what
  // the model was SHOWN, so two reads could turn a label repeated to keep it into an ADDITION.
  // Tolerated when it fails, as `buildToolset` does (prepare.ts): a watcher may not touch labels at
  // all. `null`, not `[]`: "no labels" would let the model clear everything.
  let current: string[] | null = null;
  try {
    current = await client.getConversationLabels(conversationId);
  } catch (e) {
    logger.warn(
      "observe: conversation labels unreadable (tenant=%s conv=%s): %s",
      String(tenantId),
      String(conversationId),
      e instanceof Error ? e.message : String(e),
    );
  }
  // THE PROMPT BLOCK SHOWS THE GUARDED LABELS, as the tool does (it shows them and refuses to
  // move them): the same projection the tool renders (label-view.ts).
  const currentForPrompt =
    current === null ? null : modelVisibleLabels(current);

  // Read here, not beside `notes`, because it is a request every exit above would waste. The
  // labels ALONE, not the toolset's vocabulary: that is two requests under one `Promise.all`, and a
  // down attribute endpoint would stall every tick. `null` makes the block say it could not read.
  const vocabLabels = await loadChatwootLabels(
    client,
    `${tenantId}:${instanceId}`,
  ).catch(() => null);
  // THE CONVERSATION'S OWN LABELS JOIN THE INDEX: a tag attached through `set_labels` creates
  // no `Label` row, so an invented title is only on the conversation. A title invented, applied and
  // removed between two ticks is in neither list, a miss chosen over inventing a decision.
  const labelChanges = labelHistoryFromRows(
    // NOTE: minus the reset's own cleanup. The PAGE goes in, not `rows`: whether it still reaches
    // the command decides how a removal line is read.
    afterResetNarration(fetched, resetBoundary, resetCleared),
    vocabLabels === null && current === null
      ? null
      : [...(vocabLabels ?? []), ...(current ?? [])],
    cfg.protectedLabels,
    LABEL_CHANGES_MAX,
  );

  // THE TURN ITSELF, the ordinary graph: with a muted client a watcher is the ordinary agent
  // (tools, MCP, knowledge) that cannot answer the customer; classifying is `set_labels` in its
  // prompt.
  const checkpointer = deps.checkpointer ?? new MemorySaver();
  // A THREAD OF ITS OWN, per agent, never the conversation's: the responder's memory lives on
  // `chatwootThreadId(...)`, and invoking with that id would checkpoint the watcher's turn into it.
  // In-memory by default, so an observation is reproducible from the conversation alone.
  const graphThreadId = `${threadId}:observer:${agentId}`;

  // THE FENCES are asked at every tool HOP (`buildAgentGraph({stillWanted})`, as the nudge
  // does), since a turn has as many writes as tool calls. Each returns a REASON, and `unreadable`
  // stays apart from `no`: a withdrawal completes the job, a failed read retries with backoff
  // (nothing else re-arms the row, and a resolve happens once), paying the model call again under
  // the spend ceiling.
  let refusal: Refusal | null = null;
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
    // ONE ROW ANSWERS BOTH QUESTIONS: re-reading the switch and mode here narrows the window
    // to this read, and catches an agent deleted mid-turn, which a `settings`-only select read as
    // no config.
    let settingsNow: unknown = null;
    const monNow = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { enabled: true, mode: true, settings: true },
      }),
    )
      .then((row) => {
        if (!row?.enabled || !isMonitoring(row.mode)) return "gone" as const;
        settingsNow = row.settings;
        return readMonitoringConfig(row.settings);
      })
      .catch(() => "unreadable" as const);
    if (monNow === "unreadable") {
      refusal = "settings_unreadable";
      return false;
    }
    if (monNow === "gone") {
      refusal = "agent_no_longer_observes";
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
    // The contact gate's rule, against the settings and the conversation as they are now: a label
    // removed while the model answers takes the conversation out of scope before the next write.
    const ruledNow = await observerRuleVerdict(
      {
        tenantId,
        instanceId,
        conversationId,
        agentId,
        settings: settingsNow,
        base,
      },
      { emit: false },
    );
    if (ruledNow !== "allowed") {
      refusal =
        ruledNow === "unreadable"
          ? "contact_auth_unreadable"
          : "contact_auth_refused";
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
        // NOTE: A ROW THAT HAS NOT LANDED IS NOT A DETACH here either: a detach and reattach
        // straddling the model call leave `attachedAt` null for a moment, and completing would lose
        // an `on_resolve` watcher's whole observation (the resolve mark suppresses later
        // deliveries).
        refusal =
          onInbox === "unreadable"
            ? "binding_unreadable"
            : onInbox === "attaching"
              ? "binding_attaching"
              : "agent_no_longer_on_inbox";
        return false;
      }
    }
    return true;
  };

  // ...AND IT COVERS DISCOVERY, which is the one call that can hang forever: `buildToolset` contacts
  // every MCP server the agent has, and an SSE server that opens the stream and never emits its
  // endpoint waits with no timeout of its own.
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
          expiresOn: deadline,
          // NOTE: the burst's triggering message, exposed to HTTP and code tools as {{message_id}}
          // as on a reactive turn. Null on an `on_resolve` tick: the placeholder is then absent, as
          // for a nudge.
          ...(p.atMessageId != null ? { messageId: p.atMessageId } : {}),
          ...(deps.outboundFetch ? { outboundFetch: deps.outboundFetch } : {}),
          stillWanted: () => fence(),
          onLabelsWritten: (write) => labelWrites.push(write),
          onNoEffect: (toolName: string) => {
            if (counted.has(toolName)) noEffect++;
          },
          observed: conv ? { status: conv.status, statusAt: null } : undefined,
          // NOTE: not for delivering anything (a muted client cannot): it lets
          // `resolve_conversation` see that THIS turn transferred the conversation, and refuse to
          // close what the human queue now owns.
          handoffState: { customerMessage: null, completed: false },
          // Absent when the read failed, so the toolset asks Chatwoot itself and applies its own
          // degradation if that fails too — one extra request on the failing path only.
          ...(current === null ? {} : { conversationLabels: current }),
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

  // WHETHER ANYTHING IRREVERSIBLE HAS ALREADY HAPPENED: a retry re-runs the WHOLE stateless
  // turn, so a tick that already invoked a tool does not retry (at-most-once for effects that reach
  // other systems). Only tools that can leave something behind count: utility natives and
  // `skip_reply` are exempt by name (a native's name is reserved), the knowledge search by identity
  // (tools/effect-free.ts), since its name is reserved nowhere. A read-only GET counts too:
  // counting a read costs one observation, not counting a write repeats it in somebody else's
  // system.
  const effectFreeNames = new Set<string>([
    ...UTILITY_NATIVE_TOOL_NAMES,
    SKIP_REPLY_TOOL,
  ]);
  let toolsRan = 0;
  // Dispatches that answered without writing anything. `toolsRan - noEffect` is what committed.
  let noEffect = 0;
  // ...AND ONLY FOR A TOOL THIS COUNTER COUNTS: an effect-free tool never incremented
  // `toolsRan`, so its no-effect report would hide a sibling's real write. The name is unique
  // across every source.
  const counted = new Set<string>();
  const fencedTools = tools.map((t) => {
    // The prototype trick guardedTool uses: name, description and schema stay the tool's own, and a
    // permitted call reaches exactly the run it would have had.
    const seen = Object.create(t) as typeof t;
    seen.invoke = (async (input: unknown, config?: unknown) => {
      // BEFORE the call, because the count has to exist when the invoke THREW after its
      // write. What did NOT happen is reported by the handler through `onNoEffect`, counted apart
      // because one of those exits throws and never comes back through this wrapper.
      const countsHere = !effectFreeNames.has(t.name) && !isEffectFreeTool(t);
      if (countsHere) {
        counted.add(t.name);
        toolsRan++;
      }
      try {
        return await (t.invoke as (i: unknown, c?: unknown) => unknown)(
          input,
          config,
        );
      } catch (e) {
        // NOTE: ARGUMENTS THE TOOL NEVER ACCEPTED: the schema parse throws inside `invoke` before
        // any handler runs, so it provably had no effect; counting it as committed would turn the
        // next failure into a completed job with no observation.
        if (countsHere && e instanceof ToolInputParsingException) noEffect++;
        throw e;
      }
    }) as typeof t.invoke;
    return seen;
  });

  let graph: Awaited<ReturnType<typeof buildModelAndGraph>>;
  try {
    graph = await buildModelAndGraph(cfg, fencedTools, {
      makeModel: deps.makeModel,
      checkpointer,
      stillWanted: () => fence(),
      // NOTE: the tick's frame says the model answers nobody, so the tool budget's wrap-up says the
      // same: finish with a tool, or stop, never "responda ao cliente".
      noReplyChannel: true,
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

  // GATED IMMEDIATELY BEFORE THE BILLED CALL (spend-ceiling/coverage.ts names this node), so
  // an exit that was never going to spend is not reported as a tenant hitting its budget.
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
    // NOTE: kept at `warn`, unlike every other skip here: the budget is the one reason an
    // observation is skipped that an operator can act on.
    line("skipped", { skipped: "spend_ceiling" }, "warn");
    return { outcome: "done" };
  }

  // THE REFUSALS THAT ARE NOT ANSWERS are the `retry` entries of `REFUSAL_ENDING`, listed by name
  // rather than matched by suffix: a refusal added later that happens to end in the same word is a
  // decision about retries, and it should be made there on purpose rather than inherited from how it
  // was spelled.
  const endOnRefusal = (why: Refusal): JobResult => {
    const ending = REFUSAL_ENDING[why];
    if (ending !== "retry") {
      line(
        "skipped",
        { skipped: why, messagesRead: transcript.length },
        ending,
      );
      return { outcome: "done" };
    }
    // NOTE: ...UNLESS SOMETHING ALREADY COMMITTED, the same rule as the model-failure path: a fence
    // is asked at every hop, so an unreadable one can arrive after a write left, and a retry would
    // repeat it. The tick stops with a warn, and the next burst re-asks.
    if (toolsRan - noEffect > 0) {
      line(
        "error",
        {
          failed: why,
          messagesRead: transcript.length,
          toolCalls: toolsRan - noEffect,
          retried: false,
        },
        "warn",
      );
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
  // NOTE: A DEADLINE, because this tick runs on the SHARED scheduler (see `OBSERVE_TIMEOUT_MS`).
  // Both halves: the config's signal cancels the provider request, and `underSignal` guarantees
  // this function stops waiting whatever a link in the chain does with the signal.
  try {
    const result = await underSignal(
      graph.invoke(
        {
          messages: [
            new HumanMessage(
              observeTurnText(
                transcript,
                currentForPrompt,
                notes,
                // NOTE: EMPTY IS A CLAIM, made only when BOTH lists were read: each recognises
                // changes the other cannot (a label removed in the window, a title the model
                // invented). Recognised lines are still shown, with the reading marked incomplete.
                {
                  lines: labelChanges.lines,
                  complete:
                    vocabLabels !== null &&
                    current !== null &&
                    labelChanges.omitted === 0,
                },
              ),
            ),
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
              billedModel: cfg.mc,
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
    // A FAILURE AFTER A TOOL RAN ENDS THE TICK: `error` when the scheduler will retry, `warn`
    // when a retry would repeat a commit. A dispatch that never settled (the deadline rejected the
    // invoke) counts as committed, because counting a no-op costs one observation and not counting
    // a write repeats it. An `on_resolve` agent has no next burst, the declared price
    // (docs/chatwoot.md).
    const committed = toolsRan - noEffect > 0;
    emitFlowEvent(flow, {
      stage: "observe",
      level: committed ? "warn" : "error",
      status: "error",
      provider: cfg.mc.provider,
      model: cfg.mc.model,
      durationMs: Date.now() - startedAt,
      detail: {
        reason,
        failed: "model_call",
        toolCalls: toolsRan - noEffect,
        ...(committed ? { retried: false } : {}),
        ...(labelWrites.length > 0 ? { labels: labelWrites } : {}),
      },
      errorMessage: msg,
    });
    if (committed) return { outcome: "done" };
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
      labelsBefore: current === null ? null : current.length,
      ...(labelWrites.length > 0 ? { labels: labelWrites } : {}),
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
