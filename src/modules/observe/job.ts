import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  type BaseMessage,
  HumanMessage,
  SystemMessage,
} from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { chatwootThreadId } from "@/graph/checkpointer";
import { contentToText } from "@/graph/message-text";
import { type ModelConfig, verdictAskMode } from "@/graph/model-config";
import { runModelCall } from "@/graph/model-limit";
import { createChatModel, type ResolvedModelConfig } from "@/graph/models";
import { buildCallbacks, loadAgentConfig } from "@/graph/prepare";
import { resetLandedAfter } from "@/graph/reset-episode";
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
import { withConversationLabels } from "@/modules/chatwoot/labels";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  parseChatwootMessages,
} from "@/modules/chatwoot/messages";
import {
  renderAttendantMessage,
  renderInboundMessage,
} from "@/modules/chatwoot/render";
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
import { applyVerdict, type VerdictChange } from "./apply";
import {
  type LabelGroup,
  type MonitoringConfig,
  observationEnabled,
  readMonitoringConfig,
} from "./settings";

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
// ONE model call, constrained to a schema DERIVED from the label groups, and the verdict is applied
// deterministically (./apply.ts): the model names a value per group, the code decides the set. It
// never touches a label outside its groups, never writes a value the group does not list, and never
// writes at all when nothing changed. A change is announced as a PRIVATE note on the conversation,
// so the person answering it sees why the label moved without opening the console; nothing here has
// a customer-facing channel.

export type ObserveReason = "burst" | "resolved";

export const OBSERVE_TIMEOUT_MS = 60_000;
export const OBSERVE_CEILING_WINDOW_MS = 10 * 60_000;
export const OBSERVE_NOTE_REASON_MAX = 300;
const TRANSCRIPT_MAX_CHARS = 40_000;
const FENCE_TAG = /<\s*\/?\s*(transcricao|etiquetas-atuais)[^>]*>/gi;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// One row per CONVERSATION **and CLASSIFIER**: a burst re-arms it, a resolve pulls it forward. Its
// own prefix, so it never collides with the responder's `debounce:` row on the same conversation.
//
// THE AGENT IS PART OF THE KEY (issue #477 review, round 1). An inbox can be watched by TWO
// personas at once — a monitoring agent bound as the RESPONDER (#209's first rung) and a different
// agent bound beside it as the OBSERVER — and both routes arm a verdict, by design, each with its
// own label groups. Keyed by the conversation alone the two upserts are the same row: the second
// overwrites `payload.agentId`, and which persona classifies is decided by which delivery happens
// to land last, with the other's verdict dropped and nothing anywhere saying so. Two classifiers is
// two rows, two bursts and two model calls, which is what configuring two of them asks for.
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
  if (!observationEnabled(p.cfg)) return "off";
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
  // The row this tick is running FOR, so the generation fence below can ask whether it still is
  // (issue #477 review, round 7). Optional because `runObserve` is callable without the scheduler.
  claim?: { jobId: bigint; claimSeq: number };
}

// The schema the model answers in, one enum per group. `strict` on OpenAI turns it into a
// constraint; the OpenAPI dialect (Google) takes the same shape since nothing here is nullable.
export function verdictSchemaFor(groups: readonly LabelGroup[]) {
  // PROTOTYPE-FREE, belt beside the braces `readLabelGroups` already provides: a group name is a key
  // here, and on an ordinary object `__proto__` assigns the prototype instead of a property, leaving
  // a schema that requires what it does not publish (issue #477 review, round 3).
  const properties: Record<string, unknown> = Object.create(null);
  // ...PLUS "" AS "NO VALUE APPLIES" (issue #477 review, round 13). Required with only the group's
  // own values in it, the schema forced a choice even when the transcript supported none — worst on
  // an ADDITIVE group like `[urgente, vip]`, where an ordinary first message had to acquire a signal
  // that is false, and a label-triggered automation then acted on it. The sentinel cannot collide
  // with a value: `readLabelGroups` drops a blank one, so no group can list "". `applyVerdict`
  // already treats a blank as no opinion, which is what makes this a NO-CHANGE answer rather than a
  // clearing one — a group keeps what it holds, and only new evidence moves it.
  for (const g of groups)
    properties[g.name] = { type: "string", enum: [...g.values, ""] };
  // The range the prompt asks for, DECLARED (issue #477 review, round 12). A constrained ask holds
  // the provider to it; a prose answer is held to it at the reading below, so `75` or `-1` never
  // reaches the trail as a confidence.
  properties.confidence = { type: "number", minimum: 0, maximum: 1 };
  properties.reason = { type: "string" };
  return {
    title: "observation_verdict",
    type: "object",
    additionalProperties: false,
    required: [...groups.map((g) => g.name), "confidence", "reason"],
    properties,
  } as const;
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

function stripFences(text: string): string {
  return text.replace(FENCE_TAG, "");
}

// The task, appended to the agent's own prompt: the persona says what the business is, this says
// what to do with the conversation. In the product's language, like the summarizer's.
export function buildObserveTask(
  groups: readonly LabelGroup[],
  current: readonly string[] = [],
): string {
  const lines = groups.map(
    (g) =>
      `- ${g.name} (${g.exclusive ? "um valor por vez" : "pode acumular"}): ${g.values.join(", ")}`,
  );
  // The current value of each group, named per group rather than left for the model to find in the
  // label list: the rule below is "repeat it unless the customer's newest message says otherwise",
  // and a rule about a value the model has to look up is a rule it forgets (measured: a "thanks"
  // flipped a label back to the first message's subject when the value sat only in the list).
  const held = groups.map((g) => {
    const v = current.filter((l) => g.values.includes(l));
    return `- ${g.name}: ${v.length ? v.join(", ") : "(nenhum ainda)"}`;
  });
  return [
    "Tarefa de observação: você acompanha esta conversa sem responder a ninguém. Classifique-a nos grupos abaixo, escolhendo um valor da lista de cada grupo.",
    "",
    "<grupos>",
    ...lines,
    "</grupos>",
    "",
    "<valores-atuais>",
    ...held,
    "</valores-atuais>",
    "",
    "Regras:",
    "- O valor de um grupo é o da demanda MAIS RECENTE do cliente. Mensagens do atendente não definem o assunto.",
    "- Repita o valor atual do grupo, a menos que a última mensagem do cliente traga uma demanda nova que caiba em outro valor. Mencionar um assunto antigo não é demanda nova.",
    '- Um "ok", um "obrigado", uma saudação ou uma mensagem sem demanda não mudam nada: repita o valor atual.',
    "- Só use o que está na transcrição; não deduza nem invente.",
    '- Se nenhum valor da lista couber, responda "" nesse grupo: o valor atual dele fica como está.',
    '- Responda apenas com o JSON pedido: um campo por grupo com o valor escolhido, "confidence" de 0 a 1 e "reason" com uma frase curta, no idioma da conversa.',
  ].join("\n");
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

function firstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(raw.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isRequestRefused(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 400
  );
}

// The same two shapes the guardrail asks in (../guardrails/analyze.ts): constrained where the
// endpoint implements it, prose elsewhere, and a 400 on the constrained ask is retried in prose —
// a permanent answer about this request, unlike a rate limit.
async function askVerdict(
  model: BaseChatModel,
  provider: ModelConfig["provider"],
  schema: ReturnType<typeof verdictSchemaFor>,
  messages: BaseMessage[],
  callbacks: BaseCallbackHandler[],
): Promise<Record<string, unknown> | null> {
  const asProse = async () => {
    const res = await model.invoke(messages, {
      signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
      callbacks,
    });
    return firstJsonObject(contentToText(res.content));
  };
  if (verdictAskMode(provider) === "prose") return asProse();
  try {
    const res = (await model
      .withStructuredOutput(schema, {
        name: schema.title,
        strict: true,
        includeRaw: true,
      })
      .invoke(messages, {
        signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
        callbacks,
      })) as { raw: BaseMessage; parsed: Record<string, unknown> | null };
    return res.parsed ?? firstJsonObject(contentToText(res.raw.content));
  } catch (err) {
    if (!isRequestRefused(err)) throw err;
    logger.warn(
      { err },
      "observe: model refused the constrained verdict, retrying in prose",
    );
    return asProse();
  }
}

export function observeNoteText(
  agentName: string,
  changes: readonly VerdictChange[],
  reason: string | null,
): string {
  const moves = changes
    .map((c) =>
      c.from ? `${c.group}: ${c.from} → ${c.to}` : `${c.group}: ${c.to}`,
    )
    .join(" · ");
  const why = reason ? `\n${clipText(reason, OBSERVE_NOTE_REASON_MAX)}` : "";
  return `🔎 ${agentName} · ${moves}${why}`;
}

// WHAT THE TRAIL MAY CARRY, and it is never the model's own string (issue #477 review, round 3).
// `ExecutionLog.detail` is allowlisted ids, counts and enums and NEVER message text or PII
// (CLAUDE.md, docs/logs.md) — `redactSecretsDeep` takes out what LOOKS like a credential and
// nothing else. A prose-mode provider, or the fallback after a refused constrained ask, answers
// whatever it likes under a group's key: the customer's name, their phone, a line of what they
// wrote. So a value reaches the line only by being one the GROUP lists, which is an enum by
// construction; anything else is `null` here and counted, not quoted, below.
function verdictValues(
  groups: readonly LabelGroup[],
  verdict: Record<string, unknown>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const g of groups) {
    const v = verdict[g.name];
    out[g.name] =
      typeof v === "string" && g.values.includes(v.trim()) ? v.trim() : null;
  }
  return out;
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
async function agentStillOnInbox(
  tenantId: bigint,
  inboxId: bigint,
  agentId: bigint,
  base: PrismaClient,
): Promise<"yes" | "no" | "unreadable"> {
  try {
    return await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const inbox = await db.inbox.findUnique({
        where: { id: inboxId },
        select: {
          agentId: true,
          observers: { where: { agentId }, select: { id: true } },
        },
      });
      if (!inbox) return "no";
      return inbox.agentId === agentId || inbox.observers.length > 0
        ? "yes"
        : "no";
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
    if (!observationEnabled(mon)) return null;
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
    return { agentName: agent.name, mon, cfg, conv };
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
    if (onInbox === "no" && p.attaching === true) {
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
      "observe: nothing to do (conv=%s): the agent no longer observes, or has no label group",
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
  const { agentName, mon, cfg, conv } = loaded;
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
  const client: ChatwootClient = await loadChatwootClient(
    tenantId,
    instanceId,
    {
      base,
      botToken: bot?.accessToken,
      makeClient: deps.makeClient,
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
  if (!transcript.some((l) => l.role === "customer")) {
    line("skipped", {
      skipped: "no_customer_message",
      messages: transcript.length,
    });
    return { outcome: "done" };
  }
  const current = await client.getConversationLabels(conversationId);
  // The set the VERDICT will have been computed against, kept for the write below.
  const promptLabels = current;

  const schema = verdictSchemaFor(mon.labelGroups);
  const system = `${cfg.systemPrompt}\n\n${buildObserveTask(mon.labelGroups, current)}`;
  const user = [
    `<etiquetas-atuais>${current.length ? current.join(", ") : "(nenhuma)"}</etiquetas-atuais>`,
    "<transcricao>",
    renderTranscript(transcript),
    "</transcricao>",
  ].join("\n");
  const messages: BaseMessage[] = [
    new SystemMessage(system),
    new HumanMessage(user),
  ];
  const resolved: ResolvedModelConfig = {
    ...cfg.mc,
    apiKey: cfg.apiKey,
    baseURL: cfg.credentialBaseUrl ?? cfg.mc.baseURL,
  };
  let model: BaseChatModel;
  try {
    model = (deps.makeModel ?? createChatModel)(resolved);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    line("error", { failed: "model_build" }, "error");
    return {
      outcome: "fail",
      error: `observe: model could not be built: ${msg}`,
    };
  }
  const callbacks = buildCallbacks(cfg, {
    tenantId,
    threadId,
    node: "observer",
    model: cfg.mc.model,
    conversationId: conv?.id ?? null,
    source: "inbox",
    turnId,
    base,
  });
  // GATED IMMEDIATELY BEFORE THE ONE BILLED CALL, and immediately is the whole rule
  // (CLAUDE.md, spend-ceiling/coverage.ts names this node). Asked at the top of the tick instead, it
  // answered for every exit that comes before it: a conversation with no customer message yet, a
  // transcript the renderers emptied, a model configuration that does not build — each reported as
  // `spend_ceiling` on a tick that was never going to spend anything, which reads on the flow page
  // as a tenant hitting its budget and hides the configuration error that is actually there.
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

  const startedAt = Date.now();
  let verdict: Record<string, unknown> | null;
  try {
    verdict = await runModelCall(() =>
      askVerdict(model, cfg.mc.provider, schema, messages, callbacks),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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
  const durationMs = Date.now() - startedAt;
  if (!verdict) {
    // The model answered in a shape nothing can read. Retrying buys the same answer again at the
    // same price, so the tick is done and the line says what came back.
    emitFlowEvent(flow, {
      stage: "observe",
      level: "warn",
      status: "error",
      provider: cfg.mc.provider,
      model: cfg.mc.model,
      durationMs,
      detail: { reason, failed: "unreadable_verdict" },
    });
    return { outcome: "done" };
  }

  // Read again before writing: a model call is seconds old, and an agent switched off or flipped
  // to answering in the meantime must not have a watcher's verdict land under its name.
  const observesNow = await agentObservesNow(tenantId, agentId, base);
  if (observesNow === "no") {
    line("skipped", { skipped: "agent_no_longer_observes" });
    return { outcome: "done" };
  }
  // UNREADABLE IS RETRYABLE, and the helper answers in three values precisely so the caller can tell
  // them apart (issue #477 review, round 8). Collapsed into "no", a transient read failure threw
  // away a verdict already paid for, permanently on an `on_resolve` tick — under the line that says
  // the agent stopped observing, which it did not. Same posture as the conversation read below.
  if (observesNow === "unreadable") {
    line("error", { failed: "agent_state_unreadable" }, "error");
    return {
      outcome: "fail",
      error: "observe: the agent's state could not be re-read before writing",
    };
  }
  // ...and the BINDING, for the same reason and over the same seconds: an unobserve that commits
  // while the model is answering leaves an agent that still monitors and still is enabled, on an
  // inbox that is no longer its.
  // ...AND THE CONFIGURATION ITSELF (issue #477 review, round 5). The two fences above ask about the
  // AGENT; the taxonomy is a different thing and an operator edits it from the console while a model
  // call is in flight. Applied from the snapshot this tick loaded, a verdict lands under a group
  // that was replaced, or on an agent whose last label group was just deleted — which is how
  // observation is switched off. Re-read here and used for everything below: the groups the verdict
  // is applied against and whether the change is announced. The VERDICT is still the one the model
  // gave against the old taxonomy; `applyVerdict` refuses any value the current groups do not list,
  // so a replaced taxonomy writes nothing rather than writing something stale.
  const monNow = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { settings: true },
    });
    return agent === null ? null : readMonitoringConfig(agent.settings);
  }).catch((err) => {
    // UNREADABLE IS RETRYABLE, like every other pre-write read in this module (issue #477 review,
    // round 12). Keeping the snapshot was the wrong reading of "does not fail closed": it is the
    // TAXONOMY the verdict is applied against, so a failure here writes labels from a taxonomy an
    // operator may have just replaced — or that no longer exists, which is how observation is
    // switched off. The tick fails and the scheduler retries it.
    logger.warn(
      { err },
      `observe: could not re-read the monitoring settings before writing (conv=${String(conversationId)})`,
    );
    return "unreadable" as const;
  });
  if (monNow === "unreadable") {
    line("error", { failed: "settings_unreadable" }, "error");
    return {
      outcome: "fail",
      error:
        "observe: the monitoring settings could not be re-read before writing",
    };
  }
  if (monNow === null || !observationEnabled(monNow)) {
    line("skipped", { skipped: "observation_off" });
    return { outcome: "done" };
  }
  // ...INCLUDING THE ANSWER THE ARM ITSELF GAVE (issue #477 review, round 6). `observationEnabled`
  // is one of two questions the arm asks; the other is whether this agent classifies per burst at
  // all. An operator switching to `on_resolve` while the call is in flight is refusing exactly this
  // verdict, and a fence that only asked whether a group still exists let it write anyway.
  if (reason === "burst" && monNow.analysis !== "incremental") {
    line("skipped", { skipped: "analysis_changed" });
    return { outcome: "done" };
  }
  // ...AND THE CONVERSATION ROW, for the three things that retire a verdict already computed. All
  // three are asked INSIDE the label queue (issue #477 review, round 8), and that is the whole
  // point of where they sit: `/reset`'s own clear runs in this same queue, so a fence read outside
  // it could pass, the reset could then take the queue first and clear the labels, and this tick
  // would enter afterwards and put back exactly what the operator was just told was gone. Read
  // where the write happens, the two are ordered against each other rather than merely close.
  //
  // IT REOPENED: the load asked this too, so nothing was spent on a conversation that was already
  // live, but a customer message lands inside the model call as easily as before it, and `conv`
  // holds the snapshot read at load time. On an `on_resolve` agent that message arms nothing by
  // design, so the row queued for the old resolution is the one that would classify a live
  // conversation as if it had ended. Only a definite answer refuses: a mirror row that vanished is
  // not a reopening.
  //
  // THE EPISODE ENDED: `/reset` retires the PENDING rows, but a tick already CLAIMED is past every
  // cancel — its model call was in flight when the command landed — and writing now puts back the
  // labels the operator was just told were cleared. The same fence the direct turn is held to,
  // asked in the same order (Chatwoot's own message sequence).
  //
  // ...AND WHETHER THIS RUN IS STILL THE ONE (issue #477 review, round 7). A customer message that
  // lands while the model answers re-arms the SAME row — one row per conversation and classifier —
  // so the tick holding the older transcript is superseded before it writes. The scheduler already
  // knows: `claimSeq` is the token the claim handed out, a re-arm puts the row back to PENDING, and
  // `completeJob` CASes on it — but that CAS happens AFTER the handler returns, so the labels and
  // the private note have already landed. The note is what makes this worth a read: a label a later
  // tick repairs, a note is permanent, and so is anything a label-triggered automation did. Standing
  // down cannot livelock, because standing down IS the successor being there: the row that
  // superseded us is PENDING and will classify the newer transcript. Same fence, same shape, as the
  // ingestion job's (`graph/ingest-job.ts`, `stillWanted`).
  //
  // All three read the SAME two rows and are asked in ONE query: the mirror is one row per
  // conversation, and extra round trips inside the queue only hold it longer.
  const stillWanted = async (): Promise<
    | { ok: MonitoringConfig }
    | "superseded"
    | "reopened"
    | "reset"
    | "detached"
    | "conv_unreadable"
    | "binding_unreadable"
    | "observation_off"
    | "analysis_changed"
    | "settings_unreadable"
  > => {
    // THE AGENT ITSELF, READ INSIDE THE QUEUE (issue #477 review, round 19). The checks before the
    // queue are the cheap exits; the queue can be held by another writer for as long as its own
    // Chatwoot round trips take, and an operator who switched observation off, flipped the mode or
    // replaced the taxonomy inside that window had a label and a note land under their name anyway.
    // The config THIS returns is the one the verdict is applied against, so the fence and the apply
    // cannot disagree.
    const agentNow = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { settings: true, enabled: true, mode: true },
      }),
    ).catch((err) => {
      logger.warn(
        { err },
        `observe: could not re-read the agent inside the label queue (conv=${String(conversationId)})`,
      );
      return "unreadable" as const;
    });
    if (agentNow === "unreadable") return "settings_unreadable";
    if (agentNow === null || !agentNow.enabled || !isMonitoring(agentNow.mode))
      return "observation_off";
    const monQueued = readMonitoringConfig(agentNow.settings);
    if (!observationEnabled(monQueued)) return "observation_off";
    if (reason === "burst" && monQueued.analysis !== "incremental")
      return "analysis_changed";
    const rows = await runScopedOn(base, sysCtx(tenantId), async (db) => {
      const conv = await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: conversationId,
          },
        },
        // `inboxId` from HERE and not from the load (issue #477 review, round 11): a conversation
        // moved to another inbox while the model answered leaves the load's snapshot naming the old
        // one, and the binding fence would then ask whether the agent still watches an inbox this
        // conversation is no longer on — passing, and writing onto one it never watched.
        select: { status: true, resetAtMessageId: true, inboxId: true },
      });
      const claim =
        deps.claim === undefined
          ? null
          : await db.schedulerJob.findUnique({
              where: { id: deps.claim.jobId },
              select: { status: true, claimSeq: true },
            });
      return { conv, claim };
    }).catch((err) => {
      // UNREADABLE IS NOT ABSENT (issue #477 review, round 7). Folded into `null`, a failed read
      // says "no reset has happened" and "the conversation is gone", and the verdict writes on both
      // — which is the reset fence answering the one way it must never answer. The tick fails
      // instead and the scheduler retries it; the retry re-reads everything, since it is stateless.
      logger.warn(
        { err },
        `observe: could not re-read the conversation before writing (conv=${String(conversationId)})`,
      );
      return "conv_unreadable" as const;
    });
    if (rows === "conv_unreadable") return "conv_unreadable";
    const { conv: convNow, claim: claimNow } = rows;
    if (
      deps.claim !== undefined &&
      !(
        claimNow?.status === "CLAIMED" &&
        claimNow.claimSeq === deps.claim.claimSeq
      )
    )
      return "superseded";
    if (
      reason === "resolved" &&
      convNow !== null &&
      convNow.status !== "resolved"
    )
      return "reopened";
    if (resetLandedAfter(p.atMessageId, convNow?.resetAtMessageId ?? null))
      return "reset";
    // ...AND THE BINDING, against the inbox this conversation is on NOW. Asked here, inside the
    // label queue and after the row above, rather than before the queue where it used to sit: it
    // reads the `inboxId` that read returned, and being in the queue costs nothing it did not
    // already cost. UNREADABLE IS RETRYABLE — at LOAD time "unreadable keeps the tick" is right,
    // since nothing has been spent and refusing on a blip would silence observation; here keeping
    // the tick means WRITING onto an inbox the agent may already be off (round 10).
    if (convNow?.inboxId != null) {
      const onInbox = await agentStillOnInbox(
        tenantId,
        convNow.inboxId,
        agentId,
        base,
      );
      if (onInbox === "no")
        return p.attaching === true ? "binding_unreadable" : "detached";
      if (onInbox === "unreadable") return "binding_unreadable";
    }
    return { ok: monQueued };
  };

  // THE LABELS AGAIN, AND FROM CHATWOOT (issue #477 review, round 1). The set read before the model
  // call is seconds old, and `setConversationLabels` REPLACES the whole set: a label a colleague or
  // an automation added meanwhile is silently deleted by a POST built from the older snapshot, which
  // is exactly the promise this feature makes — nothing outside the configured groups is touched.
  // The verdict itself is still the one the model gave; only the set it is applied ONTO is refreshed.
  //
  // A READ THAT FAILS DOES NOT WRITE. Falling back to the stale set is the bug this exists to close.
  //
  // READ-MODIFY-WRITE, SERIALIZED AND THEN VERIFIED (issue #477 review, round 2). Two classifiers on
  // one conversation — a monitoring responder and the observer beside it — hold two rows now, so
  // their ticks can overlap, and Chatwoot has no compare-and-set on this endpoint: both read the
  // same set and the later POST erases the earlier one's group. `withConversationLabels` is the ONE
  // queue for this conversation's labels — `assign_label`, the nudge's merge and the reset's clear
  // are all inside it too, so no writer in this process can land between our read and our POST;
  // across processes the second pass is what closes it, and it costs one GET on a tick that actually
  // changed something. The pass reads again and re-applies the SAME verdict: our value still
  // standing makes `applyVerdict` answer "nothing changed" and nothing is written, and our value
  // clobbered makes it write once more. The CHANGES reported are the first pass's — the second is a
  // repair, not a new verdict.
  //
  // THE NOTE IS INSIDE THE QUEUE TOO, and for the same ordering reason as the fences: it describes
  // the write, so a reset that takes the queue between the POST and the note would leave a note
  // about labels that no longer exist. A note that FAILS still does not undo the label.
  // ...and READ inside it, since the prose fallback answers whatever it likes: out of range is not
  // a confidence, and a number the reader cannot vouch for is better absent than wrong.
  const rawConfidence = verdict.confidence;
  const confidence =
    typeof rawConfidence === "number" &&
    Number.isFinite(rawConfidence) &&
    rawConfidence >= 0 &&
    rawConfidence <= 1
      ? rawConfidence
      : null;
  const reasonText =
    typeof verdict.reason === "string" ? verdict.reason.trim() : null;
  type Written = {
    applied: ReturnType<typeof applyVerdict>;
    before: string[];
    noted: boolean;
    // The groups the verdict was actually applied against — the in-queue reading, which is what the
    // trail below must report (issue #477 review, round 19).
    groups: LabelGroup[];
  };
  // A GROUP'S OWN SLICE of a label set, for comparing two readings of it. Sorted and joined on a
  // character no label can contain, so the comparison is about membership and not about order.
  // THE GROUP THE MODEL WAS PROMPTED WITH, by name. A verdict is an answer to a DEFINITION — these
  // values, accumulating or not — and applying it under a definition the operator changed during the
  // call is the same class of staleness as applying it onto labels somebody moved (issue #477
  // review, round 18). The sharp case: an additive group holding `vip` and `urgente`, a verdict of
  // `vip`, and a flip to exclusive mid-call — the slices match, and `applyVerdict` then sweeps out
  // `urgente` on a rule the model was never told about.
  const promptGroups = new Map(mon.labelGroups.map((g) => [g.name, g]));
  const sameDefinition = (a: LabelGroup | undefined, b: LabelGroup): boolean =>
    a !== undefined &&
    a.exclusive === b.exclusive &&
    a.values.length === b.values.length &&
    a.values.every((v, i) => v === b.values[i]);
  const groupSlice = (labels: readonly string[], g: LabelGroup): string =>
    g.values
      .filter((v) => labels.includes(v))
      .sort()
      .join("\u0000");
  const writeLabels = async (): Promise<
    | Written
    | "unreadable"
    | "conv_unreadable"
    | "binding_unreadable"
    | "settings_unreadable"
    | "superseded"
    | "reopened"
    | "reset"
    | "detached"
    | "observation_off"
    | "analysis_changed"
  > => {
    let first: Omit<Written, "noted" | "groups"> | null = null;
    let applyTo: LabelGroup[] = [];
    // The config read INSIDE the queue, and on the far side of the label GET (issue #477 review,
    // round 22). Assigned by the fence below, which runs before every POST.
    let monQ: MonitoringConfig | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let living: string[];
      try {
        living = await client.getConversationLabels(conversationId);
      } catch (err) {
        logger.warn(
          { err },
          `observe: could not re-read the labels before writing (conv=${String(conversationId)})`,
        );
        if (first === null) return "unreadable";
        // The VERIFICATION read failed, and only the verification is best-effort (issue #477
        // review, round 13). The write already landed, so what is owed is the note describing it —
        // and returning here skipped it entirely, leaving a moved label with no note on a
        // conversation whose note endpoint was perfectly healthy. Fall through to the note with
        // what the first pass applied.
        break;
      }
      // THE DURABLE FENCE, AFTER THE READ AND BEFORE THE WRITE (issue #477 review, round 22). Asked
      // once at the top of the queue it was already stale by the time the POST went out: the label
      // GET beside it is a Chatwoot round trip, and a message re-arming the row, an operator
      // switching the agent off, a detach or a `/reset` served by another replica inside it all
      // reached the write unseen. The scheduler's CAS catches the supersession only after the
      // handler returns, by which point the label, the private note and whatever automation the
      // label triggered have landed. Asked here, the only gap left is the apply itself, which
      // touches nothing outside this process.
      //
      // It is also what makes `monQ` the taxonomy the verdict is APPLIED against rather than the one
      // read a round trip ago, which is the same rule the pre-queue reads follow.
      const wanted = await stillWanted();
      if (typeof wanted === "string") {
        // Nothing written yet: the caller reports the refusal. On the repair pass the first write
        // already landed and cannot be un-sent, so its report stands and the repair is abandoned.
        if (first === null) return wanted;
        logger.warn(
          "observe: the repair pass stood down (conv=%s): %s",
          String(conversationId),
          wanted,
        );
        break;
      }
      monQ = wanted.ok;
      if (attempt === 1) applyTo = [...monQ.labelGroups];
      // ...AND THE REPAIR IS HELD TO THE SAME TAXONOMY IT WROTE (issue #477 review, round 23). The
      // fence above hands back the CURRENT configuration on both passes, but the groups the repair
      // applies were chosen on the first one — so a taxonomy replaced while our first POST was in
      // flight would have the second write a value from a group that no longer exists, or one whose
      // definition changed under it, which is exactly what the first pass refuses to do. Dropped
      // rather than re-derived: the verdict answers the groups it was SHOWN, and a group that moved
      // belongs to the next tick, not to a repair. An empty slice writes nothing and the first
      // pass's report still stands.
      else {
        const live = new Map(monQ.labelGroups.map((g) => [g.name, g] as const));
        // ...AND ONLY THE GROUPS THE FIRST PASS ACTUALLY MOVED (issue #477 review, round 24). The
        // repair exists to put back a write another classifier clobbered, so its subject is that
        // write and nothing else: a group the first pass left alone, edited by a person or an
        // automation between our POST and this read, is an edit we have now SEEN — and re-applying
        // the verdict over it reverts a manual classification and fires whatever the label triggers,
        // which is the same mistake the first pass's moved-group comparison refuses to make. Unlike
        // the write gap the waiver covers, this one is observable, so it is not conceded.
        const changed = new Set(first?.applied.changes.map((c) => c.group));
        applyTo = applyTo.filter((g) => {
          const now = live.get(g.name);
          return (
            changed.has(g.name) && now !== undefined && sameDefinition(g, now)
          );
        });
      }
      // A GROUP SOMEBODY ELSE MOVED DURING THE CALL IS NOT THIS VERDICT'S TO ANSWER (issue #477
      // review, round 14). The verdict was computed against the set the prompt showed; a person or
      // a Chatwoot automation that moved one of OUR groups meanwhile is fresher information about
      // it than a transcript that predates the move. Applied anyway, the commonest verdict — repeat
      // the value you were shown, for a message with no new demand — reverts the edit silently.
      //
      // Detectable, unlike the write gap the waiver covers: we hold both sets. Compared per group,
      // over that group's own values only, so an unrelated label moving changes nothing here. And
      // only on the FIRST pass — the second re-reads a set our own write just changed, and its job
      // is to repair that write, not to re-litigate it.
      if (attempt === 1) {
        const moved = new Set<string>();
        for (const g of applyTo)
          if (
            groupSlice(promptLabels, g) !== groupSlice(living, g) ||
            !sameDefinition(promptGroups.get(g.name), g)
          )
            moved.add(g.name);
        if (moved.size > 0) {
          logger.info(
            "observe: %d group(s) moved during the model call (conv=%s); leaving them to the next tick",
            moved.size,
            String(conversationId),
          );
          applyTo = applyTo.filter((g) => !moved.has(g.name));
        }
      }
      const applied = applyVerdict(living, applyTo, verdict);
      first ??= { applied, before: living };
      if (!applied.next) break;
      if (attempt === 2)
        // The fence above already stood the repair down if the episode moved (round 20 asked it
        // here; round 22 moved it up so the FIRST write is covered by the same reading).
        logger.warn(
          `observe: another writer replaced the labels mid-write (conv=${String(conversationId)}); re-applied`,
        );
      await client.setConversationLabels(conversationId, applied.next);
    }
    const done = first as Omit<Written, "noted" | "groups">;
    // `first` is written only on the far side of the fence, so a non-null one guarantees a config.
    if (monQ === null) return "unreadable";
    if (!done.applied.next || !monQ.noteOnChange)
      return { ...done, noted: false, groups: monQ.labelGroups };
    try {
      await client.sendPrivateNote(
        conversationId,
        observeNoteText(agentName, done.applied.changes, reasonText),
      );
      return { ...done, noted: true, groups: monQ.labelGroups };
    } catch (err) {
      logger.warn(
        { err },
        `observe: the label moved but the note could not be posted (conv=${String(conversationId)})`,
      );
      return { ...done, noted: false, groups: monQ.labelGroups };
    }
  };
  const written = await withConversationLabels(
    tenantId,
    conversationId,
    writeLabels,
  );
  if (written === "superseded" || written === "reopened") {
    line("skipped", {
      skipped: written === "reopened" ? "conversation_reopened" : "superseded",
    });
    return { outcome: "done" };
  }
  if (written === "reset") {
    line("skipped", { skipped: "reset" });
    return { outcome: "done" };
  }
  if (written === "detached") {
    line("skipped", { skipped: "agent_no_longer_on_inbox" });
    return { outcome: "done" };
  }
  if (written === "observation_off" || written === "analysis_changed") {
    line("skipped", { skipped: written });
    return { outcome: "done" };
  }
  if (written === "settings_unreadable") {
    line("error", { failed: "settings_unreadable" }, "error");
    return {
      outcome: "fail",
      error:
        "observe: the monitoring settings could not be re-read before writing",
    };
  }
  if (written === "binding_unreadable") {
    line("error", { failed: "binding_unreadable" }, "error");
    return {
      outcome: "fail",
      error: "observe: the agent's binding could not be re-read before writing",
    };
  }
  if (written === "conv_unreadable") {
    line("error", { failed: "conversation_unreadable" }, "error");
    return {
      outcome: "fail",
      error:
        "observe: the conversation row could not be re-read before writing",
    };
  }
  if (written === "unreadable") {
    // A FIRST READ THAT FAILS IS THE VERDICT LOST, NOT A VERDICT DECLINED (issue #477 review,
    // round 7). Nothing re-arms this row on its own: an `on_resolve` agent has no later burst, and
    // a resolve happens once, so a transient Chatwoot timeout here is a conversation that is never
    // classified. The tick fails and the scheduler retries with backoff up to the cap — the retry
    // spends the model call again, which is the price, and the spend ceiling gates it like any
    // other. Only the SECOND read is best-effort, and it can be: by then the write has landed and
    // what is left is the repair pass.
    line("error", { failed: "labels_unreadable" }, "error");
    return {
      outcome: "fail",
      error: "observe: the labels could not be read before writing",
    };
  }
  const { applied, before: living, noted, groups: appliedGroups } = written;
  emitFlowEvent(flow, {
    stage: "observe",
    level: applied.refused.length > 0 ? "warn" : "info",
    status: "ok",
    provider: cfg.mc.provider,
    model: cfg.mc.model,
    durationMs,
    detail: {
      reason,
      verdict: verdictValues(appliedGroups, verdict),
      confidence,
      changed: applied.changes.length > 0,
      changes: applied.changes,
      // The GROUPS that refused something, never what they refused: a refused value is by
      // definition not one the group lists, so it is the model's own text and has no place here.
      refused: applied.refused.map((r) => r.group),
      labelsBefore: living.length,
      labelsAfter: applied.next ? applied.next.length : living.length,
      noted,
      messagesRead: transcript.length,
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
