import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { chatwootThreadId, resolveGraphThreadId } from "@/graph/checkpointer";
import {
  clearFlushHold,
  isFlushHeld,
  isTurnInFlight,
  markFlushHold,
} from "@/graph/inflight";
import { armIngest } from "@/graph/ingest-job";
import { parseThreadId } from "@/graph/nudge";
import {
  type AgentConfig,
  loadAgentConfig,
  withMessageAge,
} from "@/graph/prepare";
import {
  type PostVerdict,
  type RunAgentTurnOutcome,
  type RuntimeDeps,
  runLoadedTurn,
} from "@/graph/runtime";
import { readTurnClaim } from "@/graph/thread-claim";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { isMonitoring } from "@/modules/agents/mode";
import { agentObservesNow, agentStillSpeaks } from "@/modules/agents/speaks";
import { retireRedirectFollowUp } from "@/modules/channel-redirect/followup";
import { readChannelRedirectConfig } from "@/modules/channel-redirect/service";
import { overlayMediaAnnotations } from "@/modules/chatwoot/annotations";
import {
  recordTurnCoverage,
  retireCoveredDeliveries,
} from "@/modules/chatwoot/delivery-sweep";
import {
  describeClosedGate,
  type GateCloseDetail,
} from "@/modules/chatwoot/gate-close";
import { loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  buildQuoteResolver,
  type ChatwootMessageRow,
  parseChatwootMessages,
  pendingIncoming,
  toRenderable,
} from "@/modules/chatwoot/messages";
import {
  heldByAnotherParty,
  shouldBotHandle,
} from "@/modules/chatwoot/normalize";
import { renderInboundMessage } from "@/modules/chatwoot/render";
import { turnHadTheWords } from "@/modules/chatwoot/webhook";
import type { AuthContext } from "@/modules/contact-auth/check";
import { mediaRefusedThrough } from "@/modules/contact-auth/media-refusal";
import {
  authorizeContact,
  contactAuthFlowEvent,
} from "@/modules/contact-auth/service";
import {
  clearConversationError,
  recordConversationError,
} from "@/modules/conversations/error";
import { announceFailedTurn } from "@/modules/conversations/failure-note";
import { armNothingToAnswer } from "@/modules/conversations/nothing-to-answer";
import { emitFlowEvent } from "@/modules/flowlog/service";
import type { FlowStage } from "@/modules/flowlog/stages";
import { emitUnroutedMessage } from "@/modules/flowlog/unrouted";
import { readMemoryConfig } from "@/modules/memory/settings";
import { armObserve } from "@/modules/observe/job";
import { readMonitoringConfig } from "@/modules/observe/settings";
import {
  type ClaimedJob,
  jobRetired,
  jobRetiredStrict,
} from "@/modules/scheduler/service";
import {
  type JobContext,
  type JobResult,
  registerDeadLetterHandler,
  registerJobHandler,
} from "@/modules/scheduler/worker";
import { announceSpendCeilingOnConversation } from "@/modules/spend-ceiling/notice";
import {
  announceSpendCeiling,
  SPEND_CEILING_BURST_WINDOW_MS,
  spendCeilingVerdict,
} from "@/modules/spend-ceiling/service";
import {
  extractMessageVisuals,
  hasUnextractedVisual,
} from "@/modules/vision/extract-message";
import { readVisionConfig } from "@/modules/vision/settings";
import {
  clearDeferral,
  reactionArmedOnThread,
  readBurstStart,
  readDeferringSince,
  readLastMessageId,
  readReactionArmed,
  readReactionFrom,
  stampDeferral,
} from "./service";
import { readDebounceConfig } from "./settings";
import {
  advanceHandledWatermark,
  foreignReplyBoundary,
  readAnsweredFloor,
  readClaimedMessageIds,
  readSelectionState,
  selectOpenMessages,
} from "./watermark";

// How long a flush waits before asking again whether the thread is free. Matched to the debounce
// worker's own tick (DEBOUNCE_WORKER_INTERVAL_MS, 2500ms by default) rather than to the minute
// continuous ingestion uses: nothing is gained by coming back sooner than the next tick, and unlike
// an ingestion nobody is waiting on, there is a customer at the other end of this one.
const DEFER_ON_TURN_MS = 2_000;

// The total a burst may spend waiting for a busy thread, measured from when the burst opened. Past
// it the flush answers anyway: an unanswered customer is worse than a duplicated line in memory.
// Five minutes is past any legitimate turn — model, tools at their own bound, and a split delivery
// paying out its balloons — and short enough that a thread wedged by a dead process does not swallow
// the conversation.
const DEFER_CEILING_MS = 5 * 60_000;

// The DEBOUNCE flush: re-fetch the conversation from Chatwoot, coalesce the inbound messages past the
// watermark into one turn, and answer once. Two re-fetches by design: the first builds the burst to
// answer; the second (in shouldPost, just before posting) is the n8n-faithful post-response
// supersede — if a newer message arrived during the LLM call, drop this reply and let the re-armed
// flush answer the full burst. The monotonic watermark CAS makes a concurrent claim post at most
// once. All network I/O is outside transactions; deps are injectable for tests.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function err(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// The shared "re-fetch, coalesce a burst, answer once" tail of the debounce flush and the manual
// re-engage; `selectPending` is the burst strategy. At-most-once is the monotonic reply claim on
// `Conversation.lastRepliedMessageId`, not on the handled watermark (skips advance that one too, so a
// re-engage tail would lose forever), and no transaction is held across the turn's network I/O.
export interface CoalesceTurnContext {
  // The scheduler job's signal when a flush runs this; the re-engage has none.
  signal?: AbortSignal;
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  threadId: string;
  agentBotId: number | null;
  convDbId: bigint;
  loaded: AgentConfig;
  settings: unknown;
  // The authorization verdict's context bag for the check this caller ran immediately before the
  // turn, or null when the gate is off. Required so a new caller of this tail has to answer the
  // question rather than inherit a silent default.
  authContext: AuthContext | null;
  // May be async: the debounce flush re-reads the handled watermark here, at the latest point
  // before the burst is chosen, because an authorization refusal that landed while this flush was
  // asking the endpoint has already moved it.
  selectPending: (
    messages: ChatwootMessageRow[],
  ) => ChatwootMessageRow[] | Promise<ChatwootMessageRow[]>;
  // Whether the run that queued this turn is still wanted, handed straight to `runLoadedTurn`,
  // which asks it inside the `ingest:` lock and again before each post. REQUIRED and nullable so a
  // future caller has to answer it: `null` says "nothing queued this, nothing can call it off".
  stillWanted: ((opts: { strict: boolean }) => Promise<boolean>) | null;
  // Handed straight to `runLoadedTurn`: stand down without writing when the claim reports another
  // invoke was already reading this thread. Only the flush passes it, because only the flush can put
  // the burst back on the scheduler and come back to it; see the field on `RunLoadedTurnParams`.
  standDownIfThreadHeld?: boolean;
  // How far the handled watermark may have moved and this caller's claim still stand — see
  // `claimReply` on RunLoadedTurnParams. Computed per burst, so the caller hands down a function of
  // the target rather than a value it would have to keep in step with the burst selection. Null is
  // a ceiling of its own ("this caller read no mark"), never the absence of one.
  claimHandledCeiling: (targetWatermark: number) => number | null;
  // Whether this caller is the operator's own re-engage, the only one entitled to answer over a
  // silence something chose deliberately.
  initiatedBy: "automatic" | "operator";
  // Extract the attachments nobody has read yet before the turn's text is built (arrival-time
  // extraction never ran for messages from before the agent watched the inbox). Opt-in: on the flush,
  // which runs after the eager pass, a meta-less attachment already failed once.
  fillMissingMedia?: boolean;
  // The Chatwoot id of this tenant's agent bot, so the post gate can tell OUR outgoing message from
  // everybody else's. Null when the caller has no bot to name, and then every outgoing message on the
  // page counts as somebody else's.
  managedBotId: number | null;
  // The WhatsApp provider of this conversation's inbox: only a provider that reserves its send ids
  // makes an attendant's reply from the paired phone distinguishable from our own echo. Null refuses
  // that route, which is the safe direction.
  whatsappProvider: string | null;
  // Told when the claim was lost, so the caller can tell a burst that has something coming for it
  // from one that does not. Only the flush passes it.
  onClaimLost?: (
    reason: "claimed" | "handled" | "dispensed" | "partial",
  ) => void;
  // Label for the single summary log line ("debounce flush" / "reengage").
  label: string;
  // When set (the debounce flush passes "debounce"), emit a flow line for the coalescing under the
  // turn's group. Reengage leaves it unset (it is a manual re-fire, not message grouping).
  coalesceStage?: FlowStage;
  // The message that armed this flush, and the mark to catch up from when the page does not carry
  // it. See `readBurstPage`.
  catchUp?: {
    armedLast: number | null;
    after: number | null;
    reactionArmed: boolean;
    // The burst's earliest reaction, for a conversation with no mark (see `readReactionFrom`).
    reactionFrom?: number | null;
  };
}

// Is there a burst to answer, and what is it. Shared with the flush's spend-ceiling branch, which must
// know the burst it refuses exists; a second copy of this selection would drift. Null means nothing to
// answer, already settled: a burst that renders to no text gets the watermark advanced past it, or
// every future flush would re-stop on the same messages.
interface AnswerableBurst {
  client: Awaited<ReturnType<typeof loadChatwootClient>>;
  pending: ChatwootMessageRow[];
  // The subset of `pending` that RENDERED into `text`, and so is the only part of the burst the turn
  // ever saw. A message renders to nothing when there is nothing answerable in it yet: an audio
  // whose attachment has not landed, a reaction, an unrecognised type.
  inTurn: ChatwootMessageRow[];
  // The messages the burst cap took OUT. Answered by nobody, on purpose.
  dropped: ChatwootMessageRow[];
  targetWatermark: number;
  lastMessageId: number;
  text: string;
  // Whether selection waited on extraction (up to 60 seconds per file): time in which the
  // conversation can change owner, so the caller that invokes the graph must know.
  waitedOnMedia: boolean;
}

// The page the burst is selected from. The fork's default page carries only the reactions that reply
// to one of its last twenty non-reaction messages, so a reaction to anything older (or to an earlier
// conversation) is missing. When the burst holds a reaction, or the page lacks the arming message, the
// fork's catch-up read (by id) is merged in; the common flush pays nothing more.
export async function readBurstPage(
  client: Awaited<ReturnType<typeof loadChatwootClient>>,
  conversationId: number,
  catchUp: CoalesceTurnContext["catchUp"],
): Promise<ChatwootMessageRow[]> {
  const page = parseChatwootMessages(await client.getMessages(conversationId));
  return withCaughtUp(client, conversationId, page, catchUp);
}

// The catch-up half of `readBurstPage`, for a caller that already holds its page (the observation
// walk below reads several).
async function withCaughtUp(
  client: Awaited<ReturnType<typeof loadChatwootClient>>,
  conversationId: number,
  page: ChatwootMessageRow[],
  catchUp: CoalesceTurnContext["catchUp"],
): Promise<ChatwootMessageRow[]> {
  const armedLast = catchUp?.armedLast ?? null;
  // Asked when the burst holds a reaction, which the page may be missing without the arming message
  // being missing (a text typed after it), or when the arming message itself is not on the page.
  const missingArmed =
    armedLast !== null && !page.some((m) => m.id === armedLast);
  if (!catchUp?.reactionArmed && !missingArmed) return page;
  const starts = [armedLast, catchUp?.reactionFrom ?? null].filter(
    (n): n is number => n !== null,
  );
  const after =
    catchUp?.after ?? (starts.length > 0 ? Math.min(...starts) - 1 : null);
  if (after === null) return page;
  // NOTE: Read until dry (a hundred rows per read), not until the overlap with the page: the reaction
  // can sort above it. A read the cap cuts short adds nothing, because a reply hidden in the gap would
  // reopen a request it already closed.
  const caught: ChatwootMessageRow[] = [];
  let cursor = after;
  for (let read = 0; ; read++) {
    const batch = parseChatwootMessages(
      await client.getMessages(conversationId, { after: cursor }),
    );
    caught.push(...batch);
    if (batch.length < CATCH_UP_PAGE) break;
    if (read + 1 >= CATCH_UP_MAX_READS) return page;
    cursor = Math.max(...batch.map((m) => m.id));
  }
  const known = new Set(page.map((m) => m.id));
  const added = caught.filter((m) => !known.has(m.id));
  if (added.length === 0) return page;
  return [...page, ...added].sort((a, b) => a.id - b.id);
}

// The fork's `MessageFinder::CATCH_UP_LIMIT`: a full batch means more may follow.
const CATCH_UP_PAGE = 100;
// A burst that fell this far behind its page is not one a reaction explains; the page alone answers.
const CATCH_UP_MAX_READS = 5;

export async function selectAnswerableBurst(
  ctx: Pick<
    CoalesceTurnContext,
    | "tenantId"
    | "instanceId"
    | "conversationId"
    | "convDbId"
    | "selectPending"
    | "settings"
    | "label"
    | "catchUp"
  > & {
    // Presente só quando o chamador quer os anexos sem extração abertos antes do render (ver
    // `fillMissingMedia` em CoalesceTurnContext). Os ids são os da linha de log: sem eles a linha
    // de estágio `vision` sai órfã, e a rota do operador para o rastro de um turno
    // (/logs?conversationId=) não mostra o anexo que falhou.
    fillMedia?: {
      turnId: string;
      convDbId: bigint;
      agentId: bigint;
      inboxDbId: bigint | null;
      threadId: string;
    };
  },
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<AnswerableBurst | null> {
  const { tenantId, instanceId, conversationId, convDbId } = ctx;

  // 1. Re-fetch the thread (network) and select the burst to answer.
  const client = await loadChatwootClient(tenantId, instanceId, {
    base,
    makeClient: deps?.makeClient,
  });
  const messages = await readBurstPage(client, conversationId, ctx.catchUp);
  // NOTE: Overlay the in-process media annotations BEFORE selecting/rendering: on upstream Chatwoot
  // the attachment-meta write-back 404s, so this is the only way a voice note's transcription (or a
  // vision extraction) reaches the flush. Meta values, when present, stay authoritative.
  overlayMediaAnnotations(tenantId, instanceId, messages);
  let pending = await ctx.selectPending(messages);
  // NOTE: Drop what another turn's claim already covers: between that claim and its watermark advance
  // the message sits above the mark, and the all-or-nothing claim would refuse this whole burst,
  // leaving the unclaimed message beside it with nothing coming.
  if (pending.length > 0) {
    const spoken = await readClaimedMessageIds({
      tenantId,
      conversationDbId: convDbId,
      messageIds: pending.map((m) => m.id),
      base,
    });
    // UNLESS THAT LEAVES NOTHING, and then the claim answers instead of this filter. A burst whose
    // every message is already spoken for is not an empty burst: reported as one, the flush says
    // there was nothing to answer when the truth is that another turn is answering it, and the word
    // the caller acts on changes with it. Handed on whole, the claim loses on the conflict and the
    // flush reports `superseded`, which is what actually happened.
    if (spoken.size > 0) {
      const free = pending.filter((m) => !spoken.has(m.id));
      if (free.length > 0) pending = free;
    }
  }
  if (pending.length === 0) return null;
  let dropped: typeof pending = [];

  const cfg = readDebounceConfig(ctx.settings);
  if (pending.length > cfg.maxMessagesPerBurst) {
    logger.warn(
      "%s: burst of %d messages capped to %d (conv=%s)",
      ctx.label,
      pending.length,
      cfg.maxMessagesPerBurst,
      String(conversationId),
    );
    // Kept, because the watermark below advances past them all the same and the ledger has to say
    // the same thing the watermark does. These messages were LOOKED AT and deliberately left out —
    // that is what the cap is — so a row of theirs still sitting non-terminal is a deliberate
    // silence, not a delivery nothing ever reached. Left open, every capped burst that contains a
    // strand reports it as a customer nobody answered, which is true only in the sense that makes
    // the loss list worthless: nobody was ever going to.
    dropped = pending.slice(0, pending.length - cfg.maxMessagesPerBurst);
    pending = pending.slice(pending.length - cfg.maxMessagesPerBurst);
  }
  // ANTES DO RENDER, que é o ponto em que um anexo sem extração vira o marcador que pede reenvio.
  // Depois do teto de rajada, porque o que foi cortado dali não entra no turno e não deve custar
  // uma chamada paga.
  let waitedOnMedia = false;
  if (ctx.fillMedia)
    waitedOnMedia = await fillMissingVisuals({
      tenantId,
      instanceId,
      conversationId,
      settings: ctx.settings,
      messages,
      pending,
      fill: ctx.fillMedia,
      base,
      deps,
    });

  const targetWatermark = pending[pending.length - 1]?.id as number;
  // The agent answers the burst's MOST RECENT message, so {{message_id}} must be that exact id.
  // Take the max id over the burst (order-independent, and across every message type incl. an
  // audio-only last message) instead of trusting the array position.
  const lastMessageId = pending.reduce(
    (max, m) => (m.id > max ? m.id : max),
    0,
  );
  // Resolve quoted/replied-to messages from the full page, then render each pending message for the
  // agent (markers for audio/image/file, quote context). Coalesce into one turn.
  const resolveQuoted = buildQuoteResolver(messages);
  // NOTE: Paired with its source message so the ledger reads the same list the turn's input was built
  // from. The filter drops nothing today (`pendingIncoming` admits exactly what renders); it guards
  // against those two predicates, in different files, drifting apart.
  const rendered = pending
    .map((m) => ({
      message: m,
      text: renderInboundMessage(toRenderable(m), { resolveQuoted }),
    }))
    .filter((r) => r.text.length > 0);
  if (rendered.length === 0) {
    // Nothing in the burst renders to answerable text — it never will, so mark it handled or every
    // future flush re-fetches and re-stops on the same messages.
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: convDbId,
      // NOTE: By id, not by span: this exit has already fetched the burst, so the members are known.
      dispensed: { kind: "messages", messageIds: pending.map((m) => m.id) },
      toMessageId: targetWatermark,
      base,
    });
    return null;
  }
  return {
    client,
    pending,
    dropped,
    targetWatermark,
    lastMessageId,
    inTurn: rendered.map((r) => r.message),
    text: rendered.map((r) => r.text).join("\n"),
    waitedOnMedia,
  };
}

// Extracts the burst's attachments nobody has read yet. Returns whether any extraction was attempted,
// that is, whether the turn waited. Best-effort: a failure leaves the turn with what it had, and never
// blocks the reply.
async function fillMissingVisuals(args: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  settings: unknown;
  messages: ChatwootMessageRow[];
  pending: ChatwootMessageRow[];
  fill: {
    turnId: string;
    convDbId: bigint;
    agentId: bigint;
    inboxDbId: bigint | null;
    threadId: string;
  };
  base: PrismaClient;
  deps?: RuntimeDeps;
}): Promise<boolean> {
  // DAS SETTINGS QUE O TURNO JÁ CARREGOU, sem ir ao banco. `resolveVisionConfig` faz exatamente
  // isto depois de descobrir o agente pela inbox, e aqui o agente já está decidido: quem chegou até
  // esta linha é o turno dele. A outra metade daquela função, `agent.enabled`, também já está
  // respondida — um agente desligado não tem turno.
  const cfg = readVisionConfig(args.settings);
  if (!cfg.enabled) return false;
  // NOTE: Only a message with no reading at all is opened (checked on the message's aggregate, where
  // attachment meta and the overlaid stash meet): re-extracting a partial one could publish a poorer
  // aggregate over the complete one. An email body image has no attachment meta, so only the body
  // pass's stash covers it.
  const alvos = args.pending.filter(
    (m) =>
      hasUnextractedVisual(m.visuals) &&
      ((m.bodyImages ?? 0) > 0
        ? !m.bodyRead
        : !m.imageDescription && !m.extractedText),
  );
  if (alvos.length === 0) return false;
  // NOTE: Media the contact authorization refused stays unread even when the gate now says yes
  // (docs/contact-auth.md, "Media waits for the gate").
  const recusadaAte = await refusalMarkOrClosed(args);
  const abriveis = alvos.filter(
    (m) => recusadaAte === null || m.id > recusadaAte,
  );
  if (abriveis.length === 0) return false;

  // UMA MENSAGEM DE CADA VEZ, e os anexos DENTRO de cada uma em paralelo (é o que
  // `extractMessageVisuals` faz). O paralelo que importa é o de arquivos da mesma mensagem, que é
  // onde o cliente anexa o comprovante, o documento e o print de uma vez; disparar as mensagens
  // todas juntas multiplicaria o teto por mensagem sem nenhum ganho de latência que o cliente veja.
  for (const [i, m] of abriveis.entries()) {
    // NOTE: A refusal can land while an earlier message is being read.
    if (i > 0) {
      const agora = await refusalMarkOrClosed(args);
      if (agora !== null && m.id <= agora) continue;
    }
    try {
      const lido = await extractMessageVisuals({
        tenantId: args.tenantId,
        instanceId: args.instanceId,
        conversationId: args.conversationId,
        messageId: m.id,
        visuals: m.visuals,
        cfg,
        stillAllowed: async () => {
          const agora = await refusalMarkOrClosed(args);
          return agora === null || m.id > agora;
        },
        base: args.base,
        flow: {
          tenantId: args.tenantId,
          turnId: args.fill.turnId,
          source: "inbox",
          conversationId: args.fill.convDbId,
          agentId: args.fill.agentId,
          inboxId: args.fill.inboxDbId,
          threadId: args.fill.threadId,
          base: args.base,
        },
        deps: {
          makeClient: args.deps?.makeClient,
          fetchImpl: args.deps?.visionFetch,
        },
        convLabel: String(args.conversationId),
      });
      // NA LINHA, NA HORA, sem esperar o fim do laço. O stash tem TTL de 15 minutos e este laço é
      // sequencial: uma rajada com vinte mensagens de documento (60s de orçamento cada) leva a
      // extração da primeira a expirar antes de o overlay final rodar, e no Chatwoot upstream, onde
      // não há write-back de meta, aquela mensagem renderizaria como não lida depois de ter sido
      // lida com sucesso. Aplicado aqui, o stash deixa de ser o carregador do resultado e não há
      // overlay no fim do laço: as outras linhas da página já foram sobrepostas na leitura, e entre
      // aquele instante e este nada mudou para elas.
      if (lido) {
        if (lido.imageDescription) m.imageDescription = lido.imageDescription;
        if (lido.extractedText) m.extractedText = lido.extractedText;
        m.attachmentsUnread = lido.attachmentsUnread;
      }
    } catch (err) {
      logger.warn(
        "vision fill failed (conv=%s msg=%s): %s",
        String(args.conversationId),
        String(m.id),
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return true;
}

// The conversation's media refusal mark, or null without one. Unreadable closes everything.
async function refusalMarkOrClosed(args: {
  tenantId: bigint;
  fill: { convDbId: bigint };
  base: PrismaClient;
}): Promise<number | null> {
  try {
    return await mediaRefusedThrough(
      args.tenantId,
      args.fill.convDbId,
      args.base,
    );
  } catch (err) {
    logger.warn(
      "vision fill: media refusal mark unreadable (conv=%s), nothing is read: %s",
      String(args.fill.convDbId),
      err instanceof Error ? err.message : String(err),
    );
    return Number.POSITIVE_INFINITY;
  }
}

// The instant of the newest message in the turn's input, or null when nothing in it carries one
// (a fixture-built row, a Chatwoot page whose `created_at` did not parse). Null means the age
// variable renders EMPTY, which is the honest answer: the alternative, falling back to "now", is
// exactly the wrong reading on the conversation this issue is about.
function newestCreatedAt(rows: ChatwootMessageRow[]): Date | null {
  let newest: Date | null = null;
  for (const row of rows) {
    const at = row.createdAt ?? null;
    if (at && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

export async function coalesceAndRunTurn(
  ctx: CoalesceTurnContext,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<RunAgentTurnOutcome | "empty"> {
  const {
    tenantId,
    instanceId,
    conversationId,
    threadId,
    agentBotId,
    convDbId,
    loaded,
  } = ctx;

  // O ID DO TURNO NASCE AQUI, antes da seleção, porque a extração que ela pode disparar já escreve
  // linhas de log: um id criado depois deixaria o estágio `vision` fora do rastro do turno que o
  // pediu, que é exatamente a rota do operador para descobrir por que um anexo não foi lido.
  const turnId = crypto.randomUUID();
  const burst = await selectAnswerableBurst(
    {
      ...ctx,
      ...(ctx.fillMissingMedia
        ? {
            fillMedia: {
              turnId,
              convDbId,
              agentId: loaded.agentId,
              inboxDbId: loaded.inboxDbId,
              threadId,
            },
          }
        : {}),
    },
    base,
    deps,
  );
  if (!burst) return "empty";
  const {
    client,
    pending,
    inTurn,
    dropped,
    targetWatermark,
    lastMessageId,
    text,
    waitedOnMedia,
  } = burst;

  // 2. Post gate, first half: re-fetch to detect mid-turn arrivals (supersede). Re-fetch failure is
  //    non-fatal. The second half — the monotonic claim that makes this exclusive with every other
  //    posting path — is taken by `runLoadedTurn` off `claimReply` below.
  const shouldPost = async (): Promise<PostVerdict> => {
    try {
      const page = parseChatwootMessages(
        await client.getMessages(conversationId),
      );
      // NOTE: A reaction that arrived mid-turn is on no default page either, so the same catch-up
      // read runs here; without it the turn posts over the reaction its re-armed flush answers again.
      // A failure of this read keeps the page already read rather than skipping the gate.
      const latest = await (async () => {
        try {
          return ctx.catchUp &&
            (ctx.catchUp.reactionArmed ||
              (await reactionArmedOnThread({ tenantId, threadId, base })))
            ? await withCaughtUp(client, conversationId, page, {
                armedLast: null,
                after: targetWatermark,
                reactionArmed: true,
              })
            : page;
        } catch (e) {
          logger.warn(
            "%s: catch-up read before posting failed (conv=%s), judging the page alone: %s",
            ctx.label,
            String(conversationId),
            e instanceof Error ? e.message : String(e),
          );
          return page;
        }
      })();
      // NOTE: Asked by identity (is there an OPEN message above what I answer), not by `max id >
      // target`: a turn can answer below a message another turn claimed, and arithmetic would defer
      // its retry forever. Not through `ctx.selectPending` either: the re-engage's "after the last
      // outgoing" tail is emptied by our own mid-turn acknowledgement (`emitAck`).
      const state = await readSelectionState({
        tenantId,
        conversationDbId: convDbId,
        messageIds: pendingIncoming(latest, null).map((m) => m.id),
        base,
      });
      const openAbove = selectOpenMessages({
        page: latest,
        scalarFloor: targetWatermark,
        state,
        purpose: "reply",
        managedBotId: ctx.managedBotId,
        whatsappProvider: ctx.whatsappProvider,
      }).some((m) => m.id > targetWatermark);
      // NOTE: And whether somebody else already answered this burst, which writes no row. Asked as
      // the foreign-reply boundary, not "are my ids still open": a member another TURN claimed is not
      // open either, and that case belongs to the claim, whose `partial` sends the flush back.
      const boundary = foreignReplyBoundary(latest, {
        managedBotId: ctx.managedBotId,
        whatsappProvider: ctx.whatsappProvider,
      });
      const answeredByOther = inTurn.some((m) => m.id <= boundary);
      // NOTE: Two different words because the bookkeeping differs (docs/debounce.md): a newer message
      // leaves everything open for the re-armed flush, an answer by somebody else closes the burst as
      // consumed. `openAbove` wins when both hold, since the newer burst is decided whole.
      if (openAbove) {
        logger.info(
          "%s: superseded mid-turn (conv=%s), deferring",
          ctx.label,
          String(conversationId),
        );
        return "newer-message";
      }
      if (answeredByOther) {
        logger.info(
          "%s: answered by somebody else (conv=%s), standing down",
          ctx.label,
          String(conversationId),
        );
        return "answered-by-other";
      }
    } catch (e) {
      logger.warn(
        "%s: supersede re-fetch failed (conv=%s): %s",
        ctx.label,
        String(conversationId),
        err(e),
      );
    }
    return "post";
  };

  // 3. Run the turn with the coalesced text. A thrown error bubbles to the caller. Share one turnId
  //    so the coalescing line and the turn's stages group together in the logs.
  if (ctx.coalesceStage) {
    emitFlowEvent(
      {
        tenantId,
        turnId,
        source: "inbox",
        conversationId: loaded.conversationDbId,
        agentId: loaded.agentId,
        inboxId: loaded.inboxDbId,
        threadId,
        base,
      },
      {
        stage: ctx.coalesceStage,
        level: "info",
        status: "ok",
        detail: { coalesced: pending.length },
      },
    );
  }
  // NOTE: Whether the burst ended up in the thread, reported by the runtime (the outcome word
  // straddles `graph.invoke` both ways). Recorded as coverage there, not settled: a send failing after
  // the invoke would skip the settlement, and closing a row mid-turn hides it from the sweep.
  let foldedIn = false;
  const outcome = await runLoadedTurn({
    signal: ctx.signal,
    // NOTE: Media extraction turns the window between the re-engage's owner check and the invoke
    // into minutes, so the ownership gate runs again after the wait.
    waitedBeforeInvoke: waitedOnMedia,
    onFoldedIn: async () => {
      // NOTE: Only the messages whose words reached the turn's input: a voice note still waiting on
      // STT is a placeholder here, and claiming it would suppress the ingest its write-back arms.
      const withWords = inTurn.filter((m) =>
        turnHadTheWords({
          hasAudio: m.attachmentTypes.includes("audio"),
          transcribedText: m.transcribedText,
        }),
      );
      foldedIn = withWords.length === pending.length;
      if (withWords.length > 0) {
        await recordTurnCoverage({
          tenantId,
          instanceId,
          conversationId,
          covered: true,
          messageIds: withWords.map((m) => m.id),
          base,
        });
      }
    },
    stillWanted: ctx.stillWanted,
    standDownIfThreadHeld: ctx.standDownIfThreadHeld,
    // NOTE: The age of what the model reads, resolved here because both callers load the config
    // before fetching the thread. From `inTurn`, not `pending`: a voice note still waiting on its
    // transcription is not what the age describes. The re-render runs on every burst; it is cheap.
    loaded: withMessageAge(loaded, newestCreatedAt(inTurn)),
    authContext: ctx.authContext,
    tenantId,
    instanceId,
    conversationId,
    agentBotId,
    threadId,
    turnId,
    text,
    // The id of the burst's most recent message, exposed to tools as {{message_id}}.
    messageId: lastMessageId,
    // The WHOLE burst for the read receipt, not just the id above: WhatsApp acknowledges the
    // messages it is given, so passing only the newest leaves the ones before it on grey ticks.
    readMessageIds: pending.map((m) => m.id),
    userSentAudio: pending.some((m) => m.attachmentTypes.includes("audio")),
    base,
    deps,
    shouldPost,
    // NOTE: The burst this turn is exclusive over, in the one column every posting path claims, so
    // this flush, its retry and an operator's re-engage of the same tail elect one sender.
    // `runLoadedTurn` gives it back when the turn throws or stands down.
    claimReply: {
      conversationDbId: convDbId,
      toMessageId: targetWatermark,
      maxHandledAllowed: ctx.claimHandledCeiling(targetWatermark),
      // NOTE: `inTurn`, not `pending`: claiming a member that never reached the model (a voice note
      // awaiting transcription) would close a message the reply never read.
      messageIds: inTurn.map((m) => m.id),
      initiatedBy: ctx.initiatedBy,
      ...(ctx.onClaimLost ? { onLost: ctx.onClaimLost } : {}),
    },
  });
  // NOTE: Every outcome not excluded here consumed the burst (answered or deliberately dropped), so
  // the watermark advances and the next flush cannot re-answer it. The list is by EXCLUSION: a new
  // outcome advances by default. Excluded: `superseded` (the re-armed flush answers the full burst),
  // `stale` (withdrawn with the cleared thread, never answered), `agent-unavailable` (the rolled-back
  // turn left it in nobody's memory; the caller re-reads the agent), and `thread-busy` and
  // `taken-over-unread` (the turn stood down before the invoke, so nothing has seen these messages).
  if (
    outcome !== "superseded" &&
    outcome !== "stale" &&
    outcome !== "thread-busy" &&
    outcome !== "taken-over-unread" &&
    outcome !== "agent-unavailable"
  ) {
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: convDbId,
      toMessageId: targetWatermark,
      // NOTE: A posted turn's answered members already have claim rows, so only the capped-out ones
      // are dispensed here; unnamed, they would read as open. On a non-posting outcome no claim was
      // taken, so the whole burst (`pending`, not `inTurn`) is dispensed with them.
      dispensed: {
        kind: "messages",
        messageIds:
          outcome === "posted" || outcome === "posted-partial"
            ? dropped.map((m) => m.id)
            : [...pending, ...dropped].map((m) => m.id),
      },
      base,
    });
    // NOTE: Retire the ledger rows of the burst's messages: a re-fetched burst can carry a message
    // whose own delivery died mid-processing. Normally updates nothing. Best-effort: a miss costs a
    // line in the loss list, never a reply.
    try {
      await retireCoveredDeliveries({
        tenantId,
        instanceId,
        conversationId,
        conversationRowId: convDbId,
        // "posted" is the only outcome that reached the customer. Every other one here consumed the
        // burst deliberately — an empty reply, a guardrail going silent, a human taking over
        // mid-turn — and calling those answered would be the lie the parameter exists to prevent.
        // `posted-partial` counts as answered for the same reason: part of the reply reached the
        // customer, so the burst was not merely consumed.
        settlement:
          outcome === "posted" || outcome === "posted-partial"
            ? "answered"
            : "consumed",
        // NOTE: Independent of the settlement: a burst answered with nothing is in memory like a
        // posted one. Reported by the runtime, since the outcome word straddles the invoke.
        covered: foldedIn,
        messageIds: pending.map((m) => m.id),
        base,
      });
      // And the ones the cap took out, which the watermark above just declared handled. Separate
      // call rather than a wider id list, because the WORD differs: a posted reply answered the
      // burst it was given, and never these.
      if (dropped.length > 0) {
        await retireCoveredDeliveries({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: convDbId,
          settlement: "consumed",
          // The cap took these out before the burst was built, so no turn ever saw them.
          covered: false,
          messageIds: dropped.map((m) => m.id),
          base,
        });
      }
    } catch (e) {
      logger.warn(
        "%s: could not retire the covered deliveries (conv=%s): %s",
        ctx.label,
        String(conversationId),
        err(e),
      );
    }
  }
  logger.info(
    "%s: conv=%s msgs=%d watermark→%d outcome=%s",
    ctx.label,
    String(conversationId),
    pending.length,
    targetWatermark,
    outcome,
  );
  return outcome;
}

export interface FlushDebounceParams {
  job: ClaimedJob;
  base: PrismaClient;
  deps?: RuntimeDeps;
  // The job's signal, aborted by its deadline and handed to the turn.
  signal?: AbortSignal;
}

// A gate exit consumed the burst without a turn, and the ledger has to hear it too, or a stranded
// row below the advanced watermark reports as lost a message the product declined to answer.
// Best-effort: a miss costs a line in the loss list, never a reply.
async function settleGateExit(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  conversationRowId: bigint;
  // The burst this exit consumed, and BOTH ends matter. The watermark as it stood is the lower
  // bound: below it sits whatever earlier messages already had decided for them, including a strand
  // this gate knows nothing about, and reaching back over one hides a real loss for good.
  afterMessageId: number | null;
  upToMessageId: number;
  // ...or the members themselves, when the exit fetched them: a range would also settle messages the
  // selection left out (one another turn claimed and died holding), hiding a real loss.
  messageIds?: number[];
  // Whether the state that closed the gate is ANOTHER AgentBot, as opposed to a human, a status
  // change or a decision about the contact. The one thing about the gate this exit is scoped by.
  heldByAnotherBot: boolean;
  base: PrismaClient;
  label: string;
}): Promise<void> {
  // NOTE: Skipped whole when another bot holds the conversation: Chatwoot fans a message to up to two
  // routes (`agent_bots_for`), so the owner's delivery may be `PROCESSING` now, and a range write
  // would make it `PROCESSED`, which the sweep never revisits. The cost is a visible strand of ours.
  if (params.heldByAnotherBot) return;
  try {
    await retireCoveredDeliveries({
      tenantId: params.tenantId,
      instanceId: params.instanceId,
      conversationId: params.conversationId,
      conversationRowId: params.conversationRowId,
      // A gate exit is a deliberate silence by definition: it decided before any model call.
      settlement: "consumed",
      // ...which is the same reason nothing was folded in: no graph ran.
      covered: false,
      ...(params.messageIds && params.messageIds.length > 0
        ? { messageIds: params.messageIds }
        : {
            afterMessageId: params.afterMessageId,
            upToMessageId: params.upToMessageId,
          }),
      base: params.base,
    });
  } catch (e) {
    logger.warn(
      "%s: could not retire the deliveries the gate consumed (conv=%s): %s",
      params.label,
      String(params.conversationId),
      err(e),
    );
  }
}

// Is the conversation still this route's, asked against the mirror now. The flush's top gate judges
// one instant, and the gates after it take real time (an external endpoint, our own reads), so each
// gate that acts on the conversation asks again, through this one function.
async function conversationStillOurs(params: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentBotId: number | null;
  base: PrismaClient;
}): Promise<{
  ours: boolean;
  closed: GateCloseDetail;
  heldByAnotherBot: boolean;
}> {
  const { tenantId, instanceId, conversationId, agentBotId, base } = params;
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: conversationId,
        },
      },
      // NOTE: assigneeId is part of the question, not decoration: without it shouldBotHandle
      // cannot tell OUR bot from another one, and a conversation handed to a different bot during
      // the gate would read as still ours.
      select: { status: true, assigneeType: true, assigneeId: true },
    });
    return {
      ours: shouldBotHandle(
        {
          assigneeType: conv?.assigneeType ?? null,
          assigneeId: conv?.assigneeId ?? null,
          status: conv?.status ?? null,
        },
        { ourAgentBotId: agentBotId },
      ),
      closed: describeClosedGate({
        assigneeType: conv?.assigneeType ?? null,
        status: conv?.status ?? null,
      }),
      // Same question as at the gate on the way in, and asked here for the same reason: this is
      // the exit that runs when the conversation moved to another bot DURING the gate, which is
      // precisely the window in which that bot's own delivery is in flight.
      heldByAnotherBot:
        conv?.assigneeType === "AgentBot" &&
        heldByAnotherParty(
          {
            assigneeType: conv.assigneeType,
            assigneeId: conv.assigneeId ?? null,
          },
          { ourAgentBotId: agentBotId },
        ),
    };
  });
}

// Chatwoot's page size for a conversation's messages, and how far back the observed-burst read
// walks before it gives up on finding the floor: five pages is a hundred messages, well past any
// burst a debounce window can hold.
const CHATWOOT_MESSAGES_PAGE = 20;
const OBSERVED_BURST_MAX_PAGES = 5;

// A failed hand-over fails the flush: a monitoring agent arms no second flush, so completing the job
// would lose the burst for good, while retries and the dead-letter keep it visible. Its own class so
// the flush's catch does not repeat the failed hand-over before rethrowing.
class HandOverFailedError extends Error {}

function retryFlushOnFailedHandOver(
  handed: "not-observing" | "handed" | "unread" | "failed",
  conversationId: number,
): void {
  if (handed !== "failed") return;
  throw new HandOverFailedError(
    `debounce flush: the observer's hand-over failed (conv=${conversationId}); retrying the flush`,
  );
}

// The gate-closed exit's own ask: that branch loads no config, so it reads the switch,
// the mode and the settings itself. "not-observing" leaves the exit exactly as it was.
async function handOverGateExitIfObserving(args: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentId: bigint | null;
  convDbId: bigint;
  contactInboxId: number | null;
  armedLast: number | null;
  // Whether the burst holds a customer's reaction; see `readReactionArmed`.
  reactionArmed?: boolean;
  reactionFrom?: number | null;
  // Another bot holds the conversation: the burst is still the observer's to remember, but its
  // delivery rows are not this route's to settle (the scope `settleGateExit` keeps).
  heldByAnotherBot: boolean;
  base: PrismaClient;
  deps?: RuntimeDeps;
}): Promise<"not-observing" | "handed" | "unread" | "failed"> {
  const { tenantId, agentId, base } = args;
  if (agentId === null) return "not-observing";
  let agent: { enabled: boolean; mode: string; settings: unknown } | null;
  try {
    agent = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.agent.findUnique({
        where: { id: agentId },
        select: { enabled: true, mode: true, settings: true },
      }),
    );
  } catch (e) {
    logger.warn(
      "debounce flush: could not read the agent at the gate exit (conv=%s), failing the flush for a retry: %s",
      String(args.conversationId),
      err(e),
    );
    return "failed";
  }
  if (!agent?.enabled || !isMonitoring(agent.mode)) return "not-observing";
  return ingestObservedBurst({
    tenantId,
    instanceId: args.instanceId,
    conversationId: args.conversationId,
    armedLast: args.armedLast,
    reactionArmed: args.reactionArmed,
    reactionFrom: args.reactionFrom,
    ctx: {
      convDbId: args.convDbId,
      agentId,
      contactInboxId: args.contactInboxId,
      settings: agent.settings,
    },
    retireDeliveries: !args.heldByAnotherBot,
    base,
    deps: args.deps,
  });
}

// A burst the flush found under an agent flipped to monitoring after the arm: folded into the
// observer's memory with the watermark advanced past it, as the receiver does for observed messages,
// or the first flush after a flip back to production would answer it. See docs/debounce.md.
async function ingestObservedBurst(args: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  armedLast: number | null;
  reactionArmed?: boolean;
  reactionFrom?: number | null;
  ctx: {
    convDbId: bigint;
    agentId: bigint;
    contactInboxId: number | null;
    settings: unknown;
  };
  // Whether the burst's delivery rows are this route's to settle (default yes). False when another
  // bot holds the conversation and may be working its own delivery of the same message.
  retireDeliveries?: boolean;
  base: PrismaClient;
  deps?: RuntimeDeps;
}): Promise<"handed" | "unread" | "failed"> {
  const { tenantId, instanceId, conversationId, armedLast, ctx, base, deps } =
    args;
  const retireDeliveries = args.retireDeliveries ?? true;
  // NOTE: No contact-inbox thread means nothing can be remembered, so nothing is marked either: left
  // below the watermark, it is the burst a later flush answers.
  if (ctx.contactInboxId === null) {
    logger.warn(
      "debounce flush: the agent is observing now (conv=%s) but the conversation has no contact-inbox thread; leaving the burst unmarked",
      String(conversationId),
    );
    return "unread";
  }
  let newest = armedLast;
  // NOTE: Hoisted so the watermark advance at the tail can name what it closed: one id per message
  // this route folded into memory.
  const handedIds: number[] = [];
  let inboxChatwootId: number | null = null;
  {
    const contactInboxId = ctx.contactInboxId;
    try {
      const marks = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.conversation.findUnique({
          where: { id: ctx.convDbId },
          select: {
            lastRepliedMessageId: true,
            lastHandledMessageId: true,
            inbox: { select: { chatwootInboxId: true } },
          },
        }),
      );
      const replied = marks?.lastRepliedMessageId ?? null;
      const handled = marks?.lastHandledMessageId ?? null;
      inboxChatwootId = marks?.inbox?.chatwootInboxId ?? null;
      // NOTE: The floor the walk reads down to: the watermark while it sits below the armed burst
      // (never lower than the reply, which a claim writes first). Past the burst, an observed message
      // moved it and it says nothing about the burst, so the floor is the last reply.
      const watermarkPastBurst =
        armedLast !== null && handled !== null && handled >= armedLast;
      const floor =
        !watermarkPastBurst && handled !== null
          ? Math.max(replied ?? 0, handled)
          : replied;
      const client = await loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps?.makeClient,
      });
      // NOTE: Paged backward until the floor is in view: traffic after the flip can push the armed
      // messages off the newest page. A short page is the conversation's first; the walk is bounded.
      let rows = parseChatwootMessages(
        await client.getMessages(conversationId),
      );
      const messages = [...rows];
      // NOTE: Whether the walk saw the floor (the first page, or a message at or below it). Only then
      // is the whole burst in hand and may the watermark move past it.
      let floorInView = false;
      for (let pages = 1; ; pages += 1) {
        if (rows.length < CHATWOOT_MESSAGES_PAGE) {
          floorInView = true;
          break;
        }
        const oldest = rows.reduce(
          (min, m) => (m.id < min ? m.id : min),
          Number.POSITIVE_INFINITY,
        );
        if (!Number.isFinite(oldest) || oldest <= (floor ?? 0)) {
          floorInView = true;
          break;
        }
        if (pages >= OBSERVED_BURST_MAX_PAGES) break;
        rows = parseChatwootMessages(
          await client.getMessages(conversationId, { before: oldest }),
        );
        if (rows.length === 0) {
          floorInView = true;
          break;
        }
        messages.unshift(...rows);
      }
      // NOTE: The flush's catch-up read, from this walk's floor, so the observer also remembers a
      // reaction no page carries.
      const caught = await withCaughtUp(client, conversationId, messages, {
        armedLast,
        after: floor,
        reactionArmed: args.reactionArmed === true,
        reactionFrom: args.reactionFrom ?? null,
      });
      if (caught !== messages) messages.splice(0, messages.length, ...caught);
      overlayMediaAnnotations(tenantId, instanceId, messages);
      // NOTE: Selected by identity, like the flush, because this path marks the burst too. The walk
      // itself stays bounded by the scalar floor; an open message outside it is the next flush's.
      const selState = await readSelectionState({
        tenantId,
        conversationDbId: ctx.convDbId,
        messageIds: pendingIncoming(messages, null).map((m) => m.id),
        base,
      });
      const burst = selectOpenMessages({
        page: messages,
        scalarFloor: floor,
        state: selState,
        // NOTE: "Should I remember this?", not "may I reply?": the observer's memory keeps what the
        // customer said, so neither a foreign reply nor a dispensal hides a message here.
        purpose: "memory",
      }).filter((m) => armedLast === null || m.id <= armedLast);
      const resolveQuoted = buildQuoteResolver(messages);
      const graphThreadId = resolveGraphThreadId(
        tenantId,
        instanceId,
        conversationId,
        contactInboxId,
      );
      const compactionEnabled = readMemoryConfig(ctx.settings).compaction
        .enabled;
      for (const m of burst) {
        const text = renderInboundMessage(toRenderable(m), { resolveQuoted });
        if (!text.trim()) continue;
        await armIngest({
          tenantId,
          instanceId,
          conversationId,
          contactInboxId,
          graphThreadId,
          messageId: m.id,
          text,
          role: "customer",
          sentAt: m.createdAt ?? null,
          agentId: ctx.agentId,
          compactionEnabled,
          base,
        });
        handedIds.push(m.id);
        if (newest === null || m.id > newest) newest = m.id;
      }
      // NOTE: Retire the ledger rows of what the observer now has, or the stranded-delivery sweep
      // would re-run a message already remembered. Best-effort, like the flush's.
      if (retireDeliveries && handedIds.length > 0) {
        try {
          await retireCoveredDeliveries({
            tenantId,
            instanceId,
            conversationId,
            conversationRowId: ctx.convDbId,
            settlement: "consumed",
            // The observer owes the memory and pays it on its own schedule; this route ran no turn.
            covered: false,
            messageIds: handedIds,
            base,
          });
        } catch (e) {
          logger.warn(
            "debounce flush: could not retire the observed burst's deliveries (conv=%s): %s",
            String(conversationId),
            err(e),
          );
        }
      }
      logger.info(
        "debounce flush: the agent is observing now (conv=%s), %d message(s) of the armed burst handed to ingestion",
        String(conversationId),
        burst.length,
      );
      // NOTE: A watcher's verdict on the burst is armed the way the receiver arms one per handed-over
      // message: best-effort, after the memory has it.
      await armObserve({
        tenantId,
        instanceId,
        conversationId,
        agentId: ctx.agentId,
        reason: "burst",
        cfg: readMonitoringConfig(ctx.settings),
        // NOTE: In Chatwoot's own id sequence, the order the tick's reset fence is asked in.
        atMessageId: handedIds.length > 0 ? Math.max(...handedIds) : null,
        base,
      });
      if (!floorInView) {
        // NOTE: Failed rather than left for a later flush: no flush re-reads beyond one page, so
        // the part the bound left out would be lost quietly. The dead-letter keeps it visible.
        logger.warn(
          "debounce flush: the armed burst was not fully in view after %d page(s) (conv=%s); failing the flush so the loss stays visible",
          OBSERVED_BURST_MAX_PAGES,
          String(conversationId),
        );
        return "failed";
      }
    } catch (e) {
      // NOTE: What was not read is not marked, and a read or enqueue that threw is worth a retry: a
      // monitoring agent arms no second flush for this burst.
      logger.warn(
        "debounce flush: could not hand the armed burst to ingestion (conv=%s), leaving the watermark for a retry: %s",
        String(conversationId),
        err(e),
      );
      return "failed";
    }
  }
  // NOTE: The redirect follow-up on a widget conversation is retired here too, since no turn ran to
  // cancel it: left armed, a flip back to production would send a template to a lead who already
  // answered. Best-effort, as the receiver's own retirement is.
  const redirectCfg = readChannelRedirectConfig(ctx.settings);
  if (
    redirectCfg.enabled &&
    inboxChatwootId !== null &&
    redirectCfg.widgetInboxId === inboxChatwootId
  ) {
    try {
      await retireRedirectFollowUp(
        tenantId,
        chatwootThreadId(tenantId, instanceId, conversationId),
        base,
      );
    } catch (e) {
      logger.warn(
        "debounce flush: retiring the redirect ladder on the observed burst failed (conv=%s): %s",
        String(conversationId),
        err(e),
      );
    }
  }
  if (newest !== null) {
    await advanceHandledWatermark({
      tenantId,
      conversationDbId: ctx.convDbId,
      toMessageId: newest,
      // NOTE: Handed to ingestion, not answered: a dispensal, by member. Empty when nothing was
      // fetched, never a range: with no lower bound here, a range would close the whole history.
      dispensed: { kind: "messages", messageIds: handedIds },
      base,
    });
  }
  return "handed";
}

export async function flushDebounceJob(
  params: FlushDebounceParams,
): Promise<JobResult> {
  const { job, base, deps } = params;
  // Whether the job's deadline ended this run. The run was failed and its retry answers the burst,
  // so the gate exits below (a refusal notice, a hand-over, the settlement that dispenses the burst)
  // are the retry's to make: each asks this after the waits it follows.
  const pastDeadline = (): boolean => params.signal?.aborted === true;
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return { outcome: "done" };
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return { outcome: "done" };
  const { instanceId, conversationId } = parsed;
  const tenantId = job.tenantId;
  const agentBotId =
    typeof job.payload.agentBotId === "number" ? job.payload.agentBotId : null;

  // 1. Scoped read: mirror conv + gate + resolve the agent config (DB only).
  const ctx = await runScopedOn(base, sysCtx(tenantId), async (db) => {
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
        status: true,
        assigneeType: true,
        assigneeId: true,
        inboxId: true,
        contactInboxId: true,
        lastHandledMessageId: true,
        // NOTE: Read for the spend ceiling's shortcut below, a claim about the whole backlog that
        // stops being true once the per-message era starts on this conversation.
        replyClaimFloorMessageId: true,
      },
    });
    if (!conv?.inboxId) return null;
    // NOTE: Read above the gate so a gate that CLOSES can still say whose conversation it was: the
    // line it writes is filtered by agent on the Logs page, and one written without an agent id is
    // invisible in exactly the view an operator investigating one agent is looking at.
    //
    // NOTE: The unbound-inbox bail stays BELOW the gate: above it, a closed gate on an inbox that
    // lost its agent would leave without advancing the watermark, and the burst would be answered
    // after a later rebind.
    const inbox = await db.inbox.findUnique({
      where: { id: conv.inboxId },
      select: { agentId: true, chatwootInboxId: true },
    });
    // Gate: only the bot still owns it (pending, no human / our bot).
    if (
      !shouldBotHandle(
        {
          assigneeType: conv.assigneeType,
          assigneeId: conv.assigneeId,
          status: conv.status,
        },
        { ourAgentBotId: agentBotId },
      )
    ) {
      return {
        // Tagged with a literal, like the unbound exit below, rather than left to be told apart by
        // the presence of `gateClosed`. TypeScript gives every sibling of a union of object literals
        // an implicit `?: undefined` for the properties it lacks, so an `in` check narrows nothing
        // and every field read out of this branch comes back widened with `undefined`.
        gateExit: true as const,
        // For the observer's hand-over below: the burst is folded into memory by contact-inbox.
        contactInboxId: conv.contactInboxId,
        // NOTE: Classified WITH the gate, not after it: a second read would answer about a
        // different moment, and the whole point of the line is which state closed THIS gate.
        gateClosed: describeClosedGate({
          assigneeType: conv.assigneeType,
          status: conv.status,
        }),
        convDbId: conv.id,
        inboxDbId: conv.inboxId,
        agentId: inbox?.agentId ?? null,
        // Carried on this branch too, and it is not decoration: the exit below retires the ledger
        // rows of the burst it consumed, and this is that burst's LOWER bound. Missing, the range is
        // open at the bottom and reaches back over a strand an earlier message left behind.
        watermark: conv.lastHandledMessageId,
        // NOTE: And the per-message floor, or `gateExitFrom` below falls back to the watermark on
        // this branch and an open message below the mark is left with no row.
        perMessageFloor: conv.replyClaimFloorMessageId,
        // WHICH other party, when there is one. A human taking the conversation is a statement about
        // the message — they answer it, whichever route carried it — and another BOT is not. Read
        // from the same conversation row the gate just judged, for the same reason `gateClosed` is.
        heldByAnotherBot:
          conv.assigneeType === "AgentBot" &&
          heldByAnotherParty(
            { assigneeType: conv.assigneeType, assigneeId: conv.assigneeId },
            { ourAgentBotId: agentBotId },
          ),
      };
    }
    if (!inbox?.agentId) {
      // NOTE: The inbox has no agent (never had one, or lost it after the arm). The watermark is
      // deliberately NOT advanced: the burst has to survive a later rebind.
      return {
        unbound: true as const,
        convDbId: conv.id,
        inboxDbId: conv.inboxId,
        chatwootInboxId: inbox?.chatwootInboxId ?? null,
      };
    }
    const agentRow = await db.agent.findUnique({
      where: { id: inbox.agentId },
      select: { settings: true },
    });
    const loaded = await loadAgentConfig(db, {
      tenantId,
      instanceId,
      conversationId,
      agentId: inbox.agentId,
      threadId,
    });
    if (!loaded) {
      // NOTE: The config refuses a monitoring agent like a disabled one, but a disabled agent's burst
      // waits for the switch while an observing agent's is the observer's to read. Classified from a
      // read taken AFTER the refusal, since a flip can land between `agentRow` and the config load.
      const now = await db.agent.findUnique({
        where: { id: inbox.agentId },
        // NOTE: Settings from this same read: `agentRow` predates the flip, and the same edit
        // usually changes the `analysis` setting the observe arm reads.
        select: { enabled: true, mode: true, settings: true },
      });
      if (now?.enabled && isMonitoring(now.mode)) {
        return {
          observing: true as const,
          convDbId: conv.id,
          inboxDbId: conv.inboxId,
          agentId: inbox.agentId,
          contactInboxId: conv.contactInboxId,
          watermark: conv.lastHandledMessageId,
          settings: now.settings,
        };
      }
      return null;
    }
    return {
      convDbId: conv.id,
      inboxChatwootId: inbox.chatwootInboxId,
      contactInboxId: conv.contactInboxId,
      watermark: conv.lastHandledMessageId,
      perMessageFloor: conv.replyClaimFloorMessageId,
      loaded,
      settings: agentRow?.settings ?? {},
    };
  });
  // No conversation / no config → nothing to do (not a failure).
  if (ctx === null) return { outcome: "done" };
  // NOTE: The lower bound of every range a gate exit writes is the per-message floor, not the
  // watermark: an open message can sit below the mark, and below the floor the scalars decide.
  const gateExitFrom = ctx.perMessageFloor ?? ctx.watermark ?? null;

  // NOTE: An unbound inbox is a state an operator has to repair, so it leaves the same line the
  // webhook's direct path leaves rather than ending as a silent "done".
  if ("unbound" in ctx) {
    emitUnroutedMessage({
      tenantId,
      conversationRowId: ctx.convDbId,
      inboxRowId: ctx.inboxDbId ?? null,
      chatwootInboxId: ctx.chatwootInboxId ?? null,
      threadId,
      base,
    });
    return { outcome: "done" };
  }
  // Read as a literal, for the reason the gate exit gives above: `in` narrows nothing on this union.
  if (ctx.observing) {
    const handed = await ingestObservedBurst({
      tenantId,
      instanceId,
      conversationId,
      armedLast: readLastMessageId(job.payload),
      reactionArmed: readReactionArmed(job.payload),
      reactionFrom: readReactionFrom(job.payload),
      ctx,
      base,
      deps,
    });
    retryFlushOnFailedHandOver(handed, conversationId);
    return { outcome: "done" };
  }
  // NOTE: The gate closed after the arm (a human took it, or it left `pending`, often Chatwoot
  // escalating after a slow ack). The burst counts as handled, off the payload's newest id with no
  // fetch, or the first flush after a hand-back would re-answer it. No turn starts, so the line here
  // is the only record of the escalation.
  if (ctx.gateExit) {
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: ctx.convDbId,
        agentId: ctx.agentId,
        inboxId: ctx.inboxDbId,
        threadId,
        base,
      },
      {
        stage: "handoff",
        status: "ok",
        detail: ctx.gateClosed,
      },
    );
    const last = readLastMessageId(job.payload);
    // NOTE: The gate closed before the mode was read, so the observer is asked here from a read of
    // its own; the burst is marked only once the observer has it, as the other exits do.
    const handedAtGate = await handOverGateExitIfObserving({
      tenantId,
      instanceId,
      conversationId,
      agentId: ctx.agentId,
      convDbId: ctx.convDbId,
      contactInboxId: ctx.contactInboxId,
      armedLast: last,
      reactionArmed: readReactionArmed(job.payload),
      reactionFrom: readReactionFrom(job.payload),
      heldByAnotherBot: ctx.heldByAnotherBot,
      base,
      deps,
    });
    retryFlushOnFailedHandOver(handedAtGate, conversationId);
    if (
      last !== null &&
      handedAtGate !== "unread" &&
      handedAtGate !== "failed"
    ) {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: ctx.convDbId,
        toMessageId: last,
        // NOTE: A range: this exit decides before any fetch, over the span ("not ours to answer
        // now"), and `settleGateExit` below states the same two bounds to the ledger.
        dispensed: { kind: "range", afterMessageId: gateExitFrom },
        base,
      });
      await settleGateExit({
        tenantId,
        instanceId,
        conversationId,
        conversationRowId: ctx.convDbId,
        // O mesmo limite da dispensa acima, como nos outros dois exits: o ledger fecha o conjunto que
        // a decisão consumiu, e o `heldByAnotherBot` abaixo continua decidindo o ESCOPO daquele
        // fechamento, que é outra pergunta.
        afterMessageId: gateExitFrom,
        upToMessageId: last,
        heldByAnotherBot: ctx.heldByAnotherBot,
        base,
        label: "debounce flush",
      });
    }
    return { outcome: "done" };
  }

  // NOTE: The burst selector, shared by the spend-ceiling branch and the turn so both answer about the
  // same floor. The answered floor is re-read here, after the authorization call, since a message
  // refused meanwhile has moved it; never lower than the watermark read at claim time.
  const selectPending = async (messages: ChatwootMessageRow[]) => {
    const fresh = await readAnsweredFloor({
      tenantId,
      conversationDbId: ctx.convDbId,
      base,
    });
    const armed = ctx.watermark;
    const floor =
      fresh === null ? armed : armed === null ? fresh : Math.max(fresh, armed);
    // NOTE: Above the per-message floor the scalar does not decide: a claim on 1002 raises it over an
    // unclaimed 1001 too. `selectOpenMessages` is the shared rule (docs/debounce.md).
    const state = await readSelectionState({
      tenantId,
      conversationDbId: ctx.convDbId,
      messageIds: pendingIncoming(messages, null).map((m) => m.id),
      base,
    });
    return selectOpenMessages({
      page: messages,
      scalarFloor: floor,
      state,
      // NOTE: The loaded persona, not the payload's bot: the sender is `ctx.loaded.agentBotToken`,
      // and after a rebind the payload's bot would classify our own messages as a third party's.
      purpose: "reply",
      managedBotId: ctx.loaded.agentBotId,
      whatsappProvider: ctx.loaded.whatsappProvider,
    });
  };

  // NOTE: An agent flipped to monitoring during one of this flush's waits makes the burst the
  // observer's, so each exit (ceiling, authorization, turn) asks after its own I/O. Answers whether
  // the observer HAS the burst: one it could not read stays unmarked.
  const handOverIfObserving = async (): Promise<
    "not-observing" | "handed" | "unread" | "failed"
  > => {
    const observes = await agentObservesNow(tenantId, ctx.loaded.agentId, base);
    if (observes === "unreadable") return "failed";
    if (observes === "no") return "not-observing";
    return ingestObservedBurst({
      tenantId,
      instanceId,
      conversationId,
      armedLast: readLastMessageId(job.payload),
      reactionArmed: readReactionArmed(job.payload),
      reactionFrom: readReactionFrom(job.payload),
      ctx: {
        convDbId: ctx.convDbId,
        agentId: ctx.loaded.agentId,
        contactInboxId: ctx.contactInboxId,
        settings: ctx.settings,
      },
      base,
      deps,
    });
  };

  const armedLast = readLastMessageId(job.payload);
  // The catch-up read the two burst reads below ask: see `readBurstPage`.
  const flushCatchUp = {
    armedLast,
    after: ctx.watermark ?? null,
    reactionArmed: readReactionArmed(job.payload),
    reactionFrom: readReactionFrom(job.payload),
  };
  // NOTE: Nothing left to answer means nothing to refuse: a retry after an attempt that answered and
  // died before completing must not send a refusal. Only while the scalar speaks for the whole
  // backlog (no per-message floor); otherwise the `over` branch re-selects and stays silent if empty.
  const alreadyAnswered =
    ctx.perMessageFloor === null &&
    armedLast !== null &&
    ctx.watermark !== null &&
    ctx.watermark >= armedLast;
  // NOTE: The ceiling is asked again at the turn, minutes after the webhook's ask, and a refusal here
  // is the first one, so this flush owes the whole contract (docs/spend-ceiling.md).
  const flushCeiling = alreadyAnswered
    ? null
    : await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base,
      });
  // NOTE: Every ceiling write, the flow line included (it pages alerts and spends the notice window),
  // first asks whether `/reset` retired the burst; a retired burst refused nobody and keeps its
  // watermark. Lenient `jobRetired`: an unreadable row costs a sentence sent once too often.
  // Whether the announcement reached the conversation. From then on its remaining acts are this
  // run's to finish, deadline or not: a retry finds the conversation a person's and skips the note.
  let ceilingActed = false;
  const stillWanted = async (act: string): Promise<boolean> => {
    if (await jobRetired(job, base)) {
      logger.info(
        "debounce flush: spend-ceiling %s withdrawn with the burst (conv=%s) — the job was retired",
        act,
        String(conversationId),
      );
      return false;
    }
    // NOTE: And the operator's own silences: an agent switched off or flipped to monitoring since
    // the config was read sends no copy, note or handoff.
    if (!(await agentStillSpeaks(tenantId, ctx.loaded.agentId, base))) {
      logger.info(
        "debounce flush: spend-ceiling %s withheld (conv=%s) — the agent was switched off or flipped to monitoring",
        act,
        String(conversationId),
      );
      return false;
    }
    // NOTE: After the two reads above, the stretch the deadline can fire in.
    if (pastDeadline() && !ceilingActed) {
      logger.info(
        "debounce flush: spend-ceiling %s withheld (conv=%s): the job's deadline ended this run",
        act,
        String(conversationId),
      );
      return false;
    }
    return true;
  };
  // NOTE: And an empty burst (deleted, or nothing answerable) has nothing to refuse either. Asked
  // with the turn's own selection, and only when over the ceiling: the other states select for real.
  const ceilingBurst =
    flushCeiling?.state === "over"
      ? await selectAnswerableBurst(
          {
            tenantId,
            instanceId,
            conversationId,
            convDbId: ctx.convDbId,
            selectPending,
            settings: ctx.settings,
            label: "debounce flush",
            catchUp: flushCatchUp,
          },
          base,
          deps,
        )
      : null;
  if (flushCeiling?.state === "over" && !ceilingBurst) {
    logger.info(
      "debounce flush: over the ceiling with nothing to answer (conv=%s) — the burst is empty, so there is no refusal to report",
      String(conversationId),
    );
    return { outcome: "done" };
  }
  // Asked only when there is something to say: `allowed` writes nothing, so the common flush pays no
  // read for a fence over a line that was never going to exist.
  if (
    flushCeiling &&
    flushCeiling.state !== "allowed" &&
    (await stillWanted("line"))
  ) {
    announceSpendCeiling(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: ctx.convDbId,
        agentId: ctx.loaded.agentId,
        inboxId: ctx.loaded.inboxDbId,
        threadId,
        base,
      },
      flushCeiling,
      "inbox",
      tenantId,
      // NOTE: One line per refused burst, not per attempt: a retry repeats the payload's last id,
      // the next burst does not.
      flushCeiling.state === "over"
        ? {
            key: `burst:${ctx.convDbId}:${armedLast ?? "unknown"}`,
            windowMs: SPEND_CEILING_BURST_WINDOW_MS,
          }
        : undefined,
    );
  }
  if (flushCeiling?.state === "over") {
    logger.info(
      "debounce flush: spend ceiling reached (conv=%s used=%s ceiling=%s), dropping the burst",
      String(conversationId),
      String(flushCeiling.usedUsd),
      String(flushCeiling.ceilingUsd),
    );
    // NOTE: The persona's token: these are bot-token endpoints (docs/chatwoot.md). Null when the
    // persona has no Chatwoot bot, and then ChatwootMissingTokenError is the correct report.
    const ceilingClient = () =>
      loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps?.makeClient,
        botToken: ctx.loaded.agentBotToken ?? undefined,
      });
    // NOTE: Ownership, asked right before each customer-facing act, as the webhook's primitives do:
    // a human who claimed the conversation meanwhile is neither talked over nor has it reopened.
    const stillOurs = async (act: string): Promise<boolean> => {
      const owned = await conversationStillOurs({
        tenantId,
        instanceId,
        conversationId,
        agentBotId,
        base,
      });
      if (!owned.ours) {
        logger.info(
          "debounce flush: spend-ceiling %s skipped (conv=%s reason=%s) — the conversation is no longer the bot's",
          act,
          String(conversationId),
          owned.closed.outcome,
        );
      }
      return owned.ours;
    };
    await announceSpendCeilingOnConversation({
      tenantId,
      conversationRowId: ctx.convDbId,
      // The BURST is the refusal here, and its last id names it: a retry of this same job refuses
      // the same burst, and the next burst carries a later id.
      occasion: `burst:${armedLast ?? "unknown"}`,
      cfg: flushCeiling.cfg,
      verdict: flushCeiling,
      // NOTE: Client, then ownership, then the mode last, right before the write: the first two are
      // waits an operator's flip can land in. Same order the receiver's gate keeps.
      postPublicMessage: async (text) => {
        // Inside the try, deliberately: a fence that cannot answer has to report "not sent" like any
        // other failure, so the notice window it just claimed is given back.
        try {
          const client = await ceilingClient();
          if (!(await stillOurs("message")) || !(await stillWanted("message")))
            return false;
          await client.sendMessage(conversationId, text);
          ceilingActed = true;
          return true;
        } catch (err) {
          logger.warn(
            "debounce flush: spend-ceiling message not sent (conv=%s): %s",
            String(conversationId),
            err instanceof Error ? err.message : String(err),
          );
          return false;
        }
      },
      // No ownership fence, matching the webhook's own note: a private note is for the operator, it
      // is invisible to the customer, and a conversation a human just took is exactly the one where
      // the reason for the silence still needs saying.
      postPrivateNote: async (text) => {
        try {
          // Fenced by the command but not by ownership, and the two lines above say why for each
          // half: the note is the operator's, so a human inheriting the conversation does not
          // withhold it, and a burst the operator withdrew has nothing left to explain.
          const client = await ceilingClient();
          if (!(await stillWanted("note"))) return false;
          await client.sendPrivateNote(conversationId, text);
          return true;
        } catch (err) {
          logger.warn(
            "debounce flush: spend-ceiling note failed (conv=%s): %s",
            String(conversationId),
            err instanceof Error ? err.message : String(err),
          );
          return false;
        }
      },
      handoff: async () => {
        try {
          const client = await ceilingClient();
          if (!(await stillOurs("handoff")) || !(await stillWanted("handoff")))
            return false;
          await client.toggleStatus(conversationId, "open");
          ceilingActed = true;
          return true;
        } catch (err) {
          // Best-effort, like every other handoff: a Chatwoot that will not take the status change
          // must not strand the flush.
          logger.warn(
            "debounce flush: could not open the conversation for humans (conv=%s): %s",
            String(conversationId),
            err instanceof Error ? err.message : String(err),
          );
          return false;
        }
      },
    });
    const last = readLastMessageId(job.payload);
    // NOTE: Asked again before the last write, after three network round trips: a retired burst was
    // withdrawn, not answered, so the watermark stays where it was.
    if (last !== null && (await stillWanted("settlement"))) {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: ctx.convDbId,
        toMessageId: last,
        // NOTE: This gate exit names its members, since it already fetched the burst: the refused
        // message can sit below the watermark with no row, beyond a range's reach.
        dispensed: ceilingBurst
          ? {
              kind: "messages",
              messageIds: [
                ...ceilingBurst.pending,
                ...ceilingBurst.dropped,
              ].map((m) => m.id),
            }
          : { kind: "range", afterMessageId: gateExitFrom },
        base,
      });
      await settleGateExit({
        tenantId,
        instanceId,
        conversationId,
        conversationRowId: ctx.convDbId,
        // NOTE: Named, by the same set as the dispensal: a range here would also settle a delivery
        // another turn claimed and died holding, hiding a real loss.
        messageIds: ceilingBurst
          ? [...ceilingBurst.pending, ...ceilingBurst.dropped].map((m) => m.id)
          : undefined,
        afterMessageId: ctx.watermark ?? null,
        upToMessageId: last,
        // False, and for the reason the gate below gives: what closed this exit is a decision about
        // the TENANT, which holds for whichever route carried the message.
        heldByAnotherBot: false,
        base,
        label: "debounce flush",
      });
    }
    retryFlushOnFailedHandOver(await handOverIfObserving(), conversationId);
    return { outcome: "done" };
  }

  // NOTE: The contact-authorization gate again, where the turn begins: a refused message can ride
  // into a flush an earlier message armed, and a revocation can land inside the window. A refusal
  // ends the flush like a takeover (burst handled, nothing posted); the customer copy and handoff
  // belong to the webhook's refused delivery.
  let authContext: AuthContext | null = null;
  if (ctx.loaded.contactAuthConfig.enabled) {
    const auth = await authorizeContact({
      tenantId,
      agentId: ctx.loaded.agentId,
      contactDbId: ctx.loaded.contactDbId,
      conversationDbId: ctx.convDbId,
      conversationId,
      inboxId: ctx.inboxChatwootId,
      channelType: ctx.loaded.channelType,
      // The burst is many messages, not one: there is no single text to forward, and an unlock code
      // is something the customer sends on a message of their own, which the webhook path checks.
      messageText: null,
      // Its own asking, for the reason the nudge has one: it carries no message text and must never
      // join (or be joined by) the flight of an incoming message that does.
      requestKey: "debounce",
      cfg: ctx.loaded.contactAuthConfig,
      base,
      fetchImpl: deps?.contactAuthFetch,
    });
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        conversationId: ctx.convDbId,
        agentId: ctx.loaded.agentId,
        inboxId: ctx.loaded.inboxDbId,
        threadId,
        base,
      },
      contactAuthFlowEvent(auth),
    );
    // NOTE: The authorization call is the long wait here, and a verdict it returns after the job's
    // deadline is the retry's to act on.
    if (pastDeadline()) return { outcome: "done" };
    if (auth.outcome !== "allowed") {
      logger.info(
        "debounce flush: contact not authorized (conv=%s outcome=%s), dropping the burst",
        String(conversationId),
        auth.outcome,
      );
      const handed = await handOverIfObserving();
      retryFlushOnFailedHandOver(handed, conversationId);
      const last = readLastMessageId(job.payload);
      if (last !== null && handed !== "unread" && handed !== "failed") {
        await advanceHandledWatermark({
          tenantId,
          conversationDbId: ctx.convDbId,
          toMessageId: last,
          // NOTE: A range, like the gate exit above: its members are not known here.
          dispensed: { kind: "range", afterMessageId: gateExitFrom },
          base,
        });
        await settleGateExit({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: ctx.convDbId,
          // NOTE: The same lower bound as the dispensal, or an open message's delivery below the
          // mark would be reported as lost after the decision covered it.
          afterMessageId: gateExitFrom,
          upToMessageId: last,
          // False, and not read from anywhere: the gate above already proved this route owns the
          // conversation, and what closed THIS exit is a decision about the CONTACT. That decision
          // holds for whichever route carried the message, so the wide scope is the honest one.
          heldByAnotherBot: false,
          base,
          label: "debounce flush",
        });
      }
      return { outcome: "done" };
    }
    // The facts the endpoint volunteered about this contact, for the prompt of the turn below. They
    // come from the check THIS flush just made, so they are as fresh as the verdict that allowed it.
    authContext = auth.context ?? null;
    // Allowed, and the attribution gate above ran BEFORE a round-trip that may have taken ten
    // seconds. A human who took the conversation during it would otherwise get the burst answered
    // over their shoulder: the post gate withholds the reply, but the tools have run by then. Same
    // question as the gate above, asked again against the mirror; the burst still counts as handled,
    // exactly as it does when the gate was already closed on the way in.
    const recheck = await conversationStillOurs({
      tenantId,
      instanceId,
      conversationId,
      agentBotId,
      base,
    });
    if (!recheck.ours) {
      // NOTE: The same exit as the gate on the way in, so it writes the same line: in those seconds
      // Chatwoot can also escalate the conversation out of `pending` with nobody on it.
      emitFlowEvent(
        {
          tenantId,
          turnId: crypto.randomUUID(),
          source: "inbox",
          conversationId: ctx.convDbId,
          agentId: ctx.loaded.agentId,
          inboxId: ctx.loaded.inboxDbId,
          threadId,
          base,
        },
        { stage: "handoff", status: "ok", detail: recheck.closed },
      );
      logger.info(
        "debounce flush: the conversation left the bot during the authorization call (conv=%s reason=%s)",
        String(conversationId),
        recheck.closed.outcome,
      );
      const handed = await handOverIfObserving();
      retryFlushOnFailedHandOver(handed, conversationId);
      const last = readLastMessageId(job.payload);
      if (last !== null && handed !== "unread" && handed !== "failed") {
        await advanceHandledWatermark({
          tenantId,
          conversationDbId: ctx.convDbId,
          toMessageId: last,
          // NOTE: A range, like the gate exit above: its members are not known here.
          dispensed: { kind: "range", afterMessageId: gateExitFrom },
          base,
        });
        await settleGateExit({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: ctx.convDbId,
          // NOTE: The same lower bound as the dispensal, or an open message's delivery below the
          // mark would be reported as lost after the decision covered it.
          afterMessageId: gateExitFrom,
          upToMessageId: last,
          heldByAnotherBot: recheck.heldByAnotherBot,
          base,
          label: "debounce flush",
        });
      }
      return { outcome: "done" };
    }
  }

  // NOTE: A turn already running on this graph thread defers the flush: two concurrent invokes each
  // read-modify-write the channel and store the burst twice. Keyed by graph thread (per contact-inbox),
  // and done here, not in `coalesceAndRunTurn`, whose re-engage caller has nowhere to defer to.
  const graphThreadId = resolveGraphThreadId(
    tenantId,
    instanceId,
    conversationId,
    ctx.contactInboxId,
  );
  // NOTE: The in-process maps cannot see another replica, so the durable claim in the thread's row is
  // read too, as every other writer on the thread does. Only for a key that has a row: the
  // per-conversation fallback has no `agent_threads` row, and there the maps are the whole answer.
  const durableClaim =
    ctx.contactInboxId === null
      ? { held: false, staleHolders: 0 }
      : await readTurnClaim(
          {
            tenantId,
            instanceId,
            contactInboxId: ctx.contactInboxId,
            graphThreadId,
          },
          base,
        );
  // NOTE: A lapsed lease means a holder died mid-turn, and this flush is the recovery. It proceeds,
  // and logs it: nothing else reports a replica that went down holding a customer's thread.
  if (durableClaim.staleHolders > 0) {
    logger.warn(
      "debounce flush: the claim on thread %s is stale (%s holder(s), lease already expired); recovering the burst on conversation %s",
      graphThreadId,
      String(durableClaim.staleHolders),
      String(conversationId),
    );
  }
  // NOTE: The deferral deadline is the burst's, computed out here so both exclusion paths (this
  // branch, and the stand-down at acquisition) honour one ceiling.
  const nowMs = Date.now();
  // NOTE: A deadline, not a counter: `rescheduleJob` resets `attempts`, and a payload counter is
  // erased by the next re-arm. `deferringSince` is stamped on the first deferral and survives
  // re-arms, since a message during a CLAIMED flush opens a new burst with a fresh `burstStartedAt`.
  const deferringSince =
    readDeferringSince(job.payload) ?? readBurstStart(job.payload) ?? nowMs;
  const pastDeferralCeiling = nowMs >= deferringSince + DEFER_CEILING_MS;
  if (
    isTurnInFlight(graphThreadId) ||
    isFlushHeld(graphThreadId) ||
    durableClaim.held
  ) {
    if (!pastDeferralCeiling) {
      logger.info(
        "debounce flush: a turn is in flight (thread=%s), deferring the burst on conversation %s",
        graphThreadId,
        String(conversationId),
      );
      // NOTE: A reschedule, not a failure (which would spend an attempt, stamp `last_error` and
      // eventually dead-letter). Stamped under the arm lock, not as a `payloadPatch`, whose CAS fails
      // once a message re-armed the row to PENDING. See `stampDeferral`.
      await stampDeferral({
        tenantId,
        threadId,
        since: deferringSince,
        base,
      });
      return {
        outcome: "reschedule",
        runAt: new Date(nowMs + DEFER_ON_TURN_MS),
      };
    }
    // NOTE: Past the deadline the flush runs anyway: an unanswered customer is worse than a
    // duplicated line in memory. Logged loudly, since nothing else reports the wedged thread.
    logger.warn(
      "debounce flush: a turn has held thread %s past the deferral ceiling; answering conversation %s anyway",
      graphThreadId,
      String(conversationId),
    );
  }
  // NOTE: Reserved in the same event-loop turn as the check above, with no await between: two
  // conversations of one contact are claimed in the same tick and share this key. Its own registry,
  // not `markTurnReserved`, because `isTurnInFlight` also gates rollback and ingest drains.
  markFlushHold(graphThreadId);
  // NOTE: The deferral stamp is cleared once the waiting is over: left behind, it rides into the
  // next burst, ages past the ceiling, and switches the busy-thread check off. Only when this job
  // carried one (the claimed payload is the row's), keeping the write off the common path.

  // Coalesce the burst past the watermark and answer once. A thrown error (LLM/Chatwoot) bubbles to
  // the worker → retry with backoff (watermark not advanced, so the retry re-answers the same burst).
  // The error is also surfaced on the conversation so the operator can re-engage; a successful
  // answer clears it.
  try {
    // NOTE: Inside the try so the `finally` always releases the hold, and best-effort: a stale stamp
    // costs an early ceiling later, smaller than a failed turn, and the `.catch` keeps it out of the
    // turn-failure handler below.
    if (readDeferringSince(job.payload) !== null) {
      await clearDeferral({ tenantId, threadId, base }).catch((e) =>
        logger.warn(
          "debounce flush: could not clear the deferral stamp on thread %s: %s",
          graphThreadId,
          err(e),
        ),
      );
    }
    // Set by the claim, read once the turn is over: see the branch at the tail of this function.
    let claimLostPartial = false;
    const outcome = await coalesceAndRunTurn(
      {
        signal: params.signal,
        tenantId,
        instanceId,
        conversationId,
        threadId,
        agentBotId,
        convDbId: ctx.convDbId,
        loaded: ctx.loaded,
        settings: ctx.settings,
        // NOTE: The `/reset` fence: cancels reach PENDING rows only, and a CLAIMED flush would
        // rewrite the thread the command cleared. Handed down so `runLoadedTurn` asks it where the
        // turn writes (inside the `ingest:` lock) and again before each post.
        stillWanted: async ({ strict }) =>
          !(await (strict
            ? jobRetiredStrict(job, base)
            : jobRetired(job, base))),
        // The half of the exclusion a read cannot do. The check above closed the window "a turn
        // already owns this thread"; this one closes "two flushes started in the same instant", which
        // only the acquiring statement can see (`heldBefore`, ../../graph/thread-claim.ts). Off once
        // this flush has already decided to answer past the deferral ceiling: there the choice was
        // made deliberately, an unanswered customer being worse than a duplicated line in memory, and
        // standing down would put the burst back in the queue the ceiling exists to get it out of.
        standDownIfThreadHeld: !pastDeferralCeiling,
        authContext,
        // The same closure the ceiling branch above asked with; see its definition for the floor.
        selectPending,
        catchUp: flushCatchUp,
        // The flush answers messages ABOVE the mark, so a mark at or past its target says something
        // else settled them while the model was running.
        claimHandledCeiling: (target) => target - 1,
        initiatedBy: "automatic",
        managedBotId: ctx.loaded.agentBotId,
        whatsappProvider: ctx.loaded.whatsappProvider,
        onClaimLost: (reason) => {
          claimLostPartial = reason === "partial";
        },
        label: "debounce flush",
        coalesceStage: "debounce",
      },
      base,
      deps,
    );
    if (outcome === "posted") {
      await clearConversationError({
        tenantId,
        instanceId,
        chatwootConversationId: conversationId,
        base,
      });
    }
    // NOTE: Nothing to answer: the flush does not decide the conversation's fate on the hot path; it
    // arms the delayed judgement, which reads everything fresh.
    if (outcome === "empty" && ctx.convDbId !== null) {
      await armNothingToAnswer({
        tenantId,
        instanceId,
        threadId,
        conversationId,
        conversationDbId: ctx.convDbId,
        agentId: ctx.loaded.agentId,
        agentBotId: ctx.loaded.agentBotId,
        triggerMessageId:
          typeof job.payload.lastMessageId === "number"
            ? job.payload.lastMessageId
            : null,
        base,
      });
    }
    // NOTE: Nothing was written and the burst is still owed: another invoke held the thread at claim
    // time. Deferred like the busy thread above, with the stamp keeping the ceiling honest.
    if (outcome === "thread-busy") {
      await stampDeferral({
        tenantId,
        threadId,
        since: deferringSince,
        base,
      });
      return {
        outcome: "reschedule",
        runAt: new Date(Date.now() + DEFER_ON_TURN_MS),
      };
    }
    // NOTE: The operator silenced the agent mid-turn, and the burst is unmarked and in nobody's
    // memory: an observer's ingestion marks it once it has it; a switched-off agent's burst waits.
    if (outcome === "agent-unavailable") {
      retryFlushOnFailedHandOver(await handOverIfObserving(), conversationId);
    }
    // NOTE: A partial claim conflict is the one refusal with nothing coming after it: the unclaimed
    // members have no flush armed. Rescheduled, the next selection drops the taken message and
    // claims the rest; the deferral stamp keeps the ceiling honest.
    if (claimLostPartial) {
      await stampDeferral({
        tenantId,
        threadId,
        since: deferringSince,
        base,
      });
      return {
        outcome: "reschedule",
        runAt: new Date(Date.now() + DEFER_ON_TURN_MS),
      };
    }
    return { outcome: "done" };
  } catch (e) {
    // A hand-over that already failed is the retry itself, not a turn that threw: rethrown as is.
    if (e instanceof HandOverFailedError) throw e;
    // NOTE: A turn that threw after a flip to monitoring still hands the burst to the observer.
    // Best-effort, ahead of the rethrow; its own failure is logged, not reported instead.
    try {
      await handOverIfObserving();
    } catch (handErr) {
      logger.warn(
        "debounce flush: hand-over after a failed turn failed too (conv=%s): %s",
        String(conversationId),
        err(handErr),
      );
    }
    // NOTE: A throw unwinds past every `stillWanted`, so the `/reset` fence is asked here: a retired
    // run's failure would restore the error banner /reset just cleared. Unreadable counts as not
    // retired, so an unknown never swallows a real failure.
    if (!(await jobRetired(job, base))) {
      await recordConversationError({
        tenantId,
        instanceId,
        chatwootConversationId: conversationId,
        error: e,
        base,
      });
    }
    throw e;
  } finally {
    // Balanced, on every exit including the throw: an unbalanced release hands the thread to a
    // writer this flush is about to undo, and an unbalanced hold wedges the conversation until the
    // process restarts. The turn takes its own claim inside `runLoadedTurn`; this one only covers
    // the stretch before it.
    clearFlushHold(graphThreadId);
  }
}

// Production handler: no injected deps (real client/model/checkpointer).
function debounceFlushHandler(
  job: ClaimedJob,
  base: PrismaClient,
  ctx?: JobContext,
): Promise<JobResult> {
  return flushDebounceJob({ job, base, signal: ctx?.signal });
}

// The burst is definitively unanswered: the flush exhausted its attempts and the row is DEAD, so no
// retry is coming and the customer is waiting on nobody. This is the only place on this path where
// that can be said: the handler's catch runs on attempt 1 too, and cannot know whether another
// attempt exists.
export async function announceDeadDebounceFlush(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<void> {
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return;
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return;
  await announceFailedTurn({
    tenantId: job.tenantId,
    instanceId: parsed.instanceId,
    chatwootConversationId: parsed.conversationId,
    // NOTE: Re-read rather than trust the dead-letter that got us here: `armDebounce` upserts this
    // very row back to PENDING on the next inbound message, and a row that is queued again is a turn
    // that is coming — announcing over it is what would make an operator take over and close the
    // gate that queued flush depends on.
    assess: async () => {
      const row = await runScopedOn(base, sysCtx(job.tenantId), (db) =>
        db.schedulerJob.findUnique({
          where: { id: job.id },
          select: { status: true },
        }),
      );
      return { path: "job", deadLettered: row?.status === "DEAD" };
    },
    error,
    base,
  });
}

let registered = false;
export function registerDebounceHandler(): void {
  if (registered) return;
  registerJobHandler("DEBOUNCE", debounceFlushHandler);
  registerDeadLetterHandler("DEBOUNCE", announceDeadDebounceFlush);
  registered = true;
}
