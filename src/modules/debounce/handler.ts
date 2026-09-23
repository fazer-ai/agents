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
import {
  authorizeContact,
  contactAuthFlowEvent,
} from "@/modules/contact-auth/service";
import {
  clearConversationError,
  recordConversationError,
} from "@/modules/conversations/error";
import { announceFailedTurn } from "@/modules/conversations/failure-note";
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

// The shared "re-fetch → coalesce a burst → answer once" tail, reused by the debounce flush AND the
// manual re-engage (item 6). The caller resolves the agent + conversation context; `selectPending`
// is the burst strategy (flush: incoming past the watermark; re-engage: incoming after the last
// outgoing). At-most-once is a monotonic CAS in `shouldPost` (NOT an advisory lock — the turn does
// network I/O and must not hold a transaction): a concurrent run that lost the CAS posts nothing.
//
// WHAT THAT CAS WRITES is `Conversation.lastRepliedMessageId`, and NOT the handled watermark (issue
// #452). The watermark is advanced by deliberate skips as well as by answers, so after a human-owned
// stretch it stands ahead of the tail the re-engage answers and a CAS there loses forever, reporting
// a race that never happened. One column for every posting path, so a flush retry and an operator's
// click on the same failed burst still elect one sender. Returns the runtime outcome, or "empty"
// when there is nothing to answer.
export interface CoalesceTurnContext {
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
  // Whether this caller is the operator's own re-engage, which is the only one entitled to answer
  // over a silence something chose deliberately (issue #452).
  initiatedBy: "automatic" | "operator";
  // ABRIR OS ANEXOS QUE NINGUÉM ABRIU AINDA, antes de montar o texto do turno (issue #757).
  //
  // A extração de imagem e documento é um passo da CHEGADA da mensagem (`runEagerMedia`), e o que
  // ela produz vive na meta do anexo. Uma conversa cujas mensagens chegaram antes de o agente
  // observar a caixa nunca passou por lá, e um turno que a relê hoje entrega ao modelo o marcador de
  // imagem sem extração — pedindo de volta o que está dentro do anexo que ninguém leu.
  //
  // POR PEDIDO DO CHAMADOR, e não sempre, porque o flush do debounce roda DEPOIS da passagem eager:
  // ali um anexo sem meta é um anexo cuja extração já falhou uma vez, e tentar de novo a cada flush
  // paga a mesma falha por turno. Quem liga isto é o caminho que sabe que a passagem eager nunca
  // aconteceu.
  fillMissingMedia?: boolean;
  // The Chatwoot id of this tenant's agent bot, so the post gate can tell OUR outgoing message from
  // everybody else's (PR #701, review round 1). Null when the caller has no bot to name, and then
  // every outgoing message on the page counts as somebody else's.
  managedBotId: number | null;
  // The WhatsApp provider of the inbox this conversation is on, which is the other half of the same
  // question: on a provider that reserves its send ids, an attendant's reply typed on the paired
  // phone is recognisable, and on one that does not, the same shape can be our own echo (PR #701,
  // review round 8). Null refuses that route, which is the safe direction.
  whatsappProvider: string | null;
  // Told when the claim was lost, so the caller can tell a burst that has something coming for it
  // from one that does not (issue #690, PR review round 4). Only the flush passes it.
  onClaimLost?: (
    reason: "claimed" | "handled" | "dispensed" | "partial",
  ) => void;
  // Label for the single summary log line ("debounce flush" / "reengage").
  label: string;
  // When set (the debounce flush passes "debounce"), emit a flow line for the coalescing under the
  // turn's group. Reengage leaves it unset (it is a manual re-fire, not message grouping).
  coalesceStage?: FlowStage;
  // THE MESSAGE THAT ARMED THIS FLUSH, and the mark to catch up from when the page does not carry
  // it (issue #746). See `readBurstPage`.
  catchUp?: {
    armedLast: number | null;
    after: number | null;
    reactionArmed: boolean;
    // The burst's earliest reaction, for a conversation with no mark (see `readReactionFrom`).
    reactionFrom?: number | null;
  };
}

// IS THERE A BURST TO ANSWER, and what is it? Step 1 of the coalescing tail, lifted out because two
// callers ask it and one of them is not running a turn: the spend-ceiling branch of the flush has to
// know whether the burst it is about to refuse EXISTS before it says a word to the customer. Asking
// it there with a second copy of this selection would be a second answer to one question, and the
// two would drift the first time the cap or the rendering changed.
//
// Null means there is nothing to answer, and it has already settled whatever "nothing" meant: a
// burst that renders to no answerable text never will, so the watermark advances past it or every
// future flush re-fetches and re-stops on the same messages.
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
  // SE A SELEÇÃO ESPEROU POR EXTRAÇÃO (issue #757): o religar abre aqui os anexos que ninguém tinha
  // aberto, e isso custa até 60 segundos por arquivo. Quem invoca o grafo precisa saber, porque uma
  // janela dessas é tempo para a conversa mudar de dono.
  waitedOnMedia: boolean;
}

// THE PAGE THE BURST IS SELECTED FROM, and the one message it can be missing (issue #746).
//
// The fork's default page is built from the last twenty messages that are NOT reactions, plus only
// the reactions whose `in_reply_to` points at one of them, and `in_reply_to` is resolved inside the
// same conversation. A customer reacting to a message of an earlier conversation (resolved, so the
// reaction opens a new one) or to anything older than those twenty sends a reaction that no default
// page carries. The webhook rendered it, armed this flush with its id, and the flush then found
// nothing above the mark: no turn, and a conversation left `pending` with nobody on it. Without
// debounce the same reaction opens its turn, because the direct path renders from the webhook.
//
// So when the burst holds a reaction, or the page lacks the message that armed the flush, the fork's
// catch-up read (by id, no reaction window) is asked from the mark, and what it adds is merged in.
// Only then: the common flush pays nothing more.
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
  // The catch-up read answers at most a hundred rows from `after`, oldest first, so it is read until
  // it runs dry. Stopping where it meets the page is not enough: the reaction it is asked for sorts
  // above the page's non-reaction messages, and a stop at the overlap leaves it unread (PR #821,
  // review round 2). Merging a partial read is worse than not merging: the rows sit below a gap, and
  // a reply in the gap would be missing from the history the reply-boundary selectors read, so a
  // request it already closed would come back as unanswered (round 1). A read the cap cuts short
  // therefore adds nothing.
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
  // vision extraction) reaches the flush (issue #49). Meta values, when present, stay authoritative.
  overlayMediaAnnotations(tenantId, instanceId, messages);
  let pending = await ctx.selectPending(messages);
  // AND NOT WHAT ANOTHER TURN IS ALREADY SPEAKING FOR (issue #690, PR review round 3). A claim is
  // taken before its turn sends and the watermark only moves after that turn returns, so between the
  // two a message sits above the mark with a row on it — invisible to a selection that asks the mark
  // alone. Carried into the burst, it makes this claim conflict, and the claim is all-or-nothing: the
  // whole burst is refused as `superseded`, the job completes, and the message BESIDE it, which
  // nobody claimed, is left with nothing coming for it. That is this issue's own defect, arriving
  // through the fix for it.
  //
  // Dropped here rather than repaired at the claim, because here it costs one indexed read and there
  // it would cost either answering half a burst or a second turn over the same text.
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
  // PAIRED WITH THE MESSAGE IT CAME FROM, so the ledger can read the same list the turn's input was
  // built from (issue #576, PR review round 10). Today the filter below drops nothing: `selectPending`
  // ends in `pendingIncoming`, which admits a message only on `content OR an attachment`, and that is
  // the exact complement of the one branch `renderInboundMessage` returns "" on. The pairing is
  // against DRIFT, not a live loss — the two predicates sit in different files, this function already
  // hedges the same way (the filter, and the `rendered.length === 0` exit below), and read off
  // `pending` a burst member the turn never saw would be recorded as covered and its own write-back
  // would find that record and stay quiet.
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
      // BY ID, not by span: this exit has already fetched the burst, so the members are known and
      // the exact fact is available. A range here would put an approximation on a path that had the
      // truth in hand (issue #690).
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

// OS ANEXOS DO BURST QUE NINGUÉM ABRIU AINDA, abertos agora (issue #757).
//
// Devolve SE alguma extração foi tentada, que é o mesmo que dizer se este turno esperou: quem invoca
// o grafo depois precisa saber, porque a espera é tempo para a conversa mudar de dono.
//
// Best-effort inteiro: um anexo que não abre, uma vision desligada ou uma credencial que sumiu
// deixam o turno acontecer com o que havia antes. O que esta função nunca faz é impedir a resposta.
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
  // O RELIGAR ABRE O QUE NINGUÉM NUNCA ABRIU. Não refaz, não complementa e não corrige passagem
  // anterior: mensagem que já carrega QUALQUER leitura — na meta do anexo, ou no agregado que o
  // overlay acabou de pousar vindo do stash — fica como está.
  //
  // A cerca é pelo agregado da mensagem porque é o único lugar onde as duas origens se encontram, e
  // porque uma leitura parcial não é convite para completar: uma mensagem cuja meta traz um anexo de
  // dois é uma mensagem que a chegada JÁ processou, e cujo stash tem o agregado dos dois. Reabrir o
  // que falta ali reextrai o que já existe e, se essa segunda tentativa perder um arquivo, publica um
  // agregado mais pobre por cima do completo — troca uma leitura boa por uma pior. O que a chegada
  // deixou por ler de propósito (o teto por mensagem) ou por falha está dito na contagem de não
  // lidos, que é o que o modelo recebe.
  const alvos = args.pending.filter(
    (m) =>
      hasUnextractedVisual(m.visuals) &&
      !m.imageDescription &&
      !m.extractedText,
  );
  if (alvos.length === 0) return false;

  // UMA MENSAGEM DE CADA VEZ, e os anexos DENTRO de cada uma em paralelo (é o que
  // `extractMessageVisuals` faz). O paralelo que importa é o de arquivos da mesma mensagem, que é
  // onde o cliente anexa o comprovante, o documento e o print de uma vez; disparar as mensagens
  // todas juntas multiplicaria o teto por mensagem sem nenhum ganho de latência que o cliente veja.
  for (const m of alvos) {
    try {
      const lido = await extractMessageVisuals({
        tenantId: args.tenantId,
        instanceId: args.instanceId,
        conversationId: args.conversationId,
        messageId: m.id,
        visuals: m.visuals,
        cfg,
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
      const latest = parseChatwootMessages(
        await client.getMessages(conversationId),
      );
      // ASKED BY IDENTITY, not with the arithmetic of the page (issue #698). "A newer message
      // arrived" used to be `maxIncomingId > targetWatermark`, which reads every incoming id above
      // this turn's target as a customer still waiting. Once the selection stopped deciding by a
      // single number, a turn can legitimately answer BELOW a message another turn already claimed —
      // and then the id above it is not a mid-turn arrival, it is the message that caused this one to
      // come back. Judged by arithmetic, the retry defers forever and the customer is never answered,
      // which is the same silence this issue is about, one gate further along.
      //
      // AND ASKED HERE, not through `ctx.selectPending` (PR #701, review round 5). That closure is
      // the CALLER's tail strategy, and the operator's click uses "everything after the last outgoing
      // message" — so a slow-tool acknowledgement of ours, posted mid-turn by `emitAck`, empties that
      // tail and the gate reads zero as "nothing came after me". The customer message underneath it
      // is still unclaimed, and the stale reply goes out on top of it. The gate's question does not
      // depend on who called: is there an OPEN message above what I am about to answer?
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
      // AND WHETHER THIS BURST IS STILL OURS TO ANSWER (PR #701, review round 1). The question above
      // is about what came AFTER; a person who answered the burst itself closes it without writing a
      // row anywhere, and the fence that keeps an orphan from being re-offered takes those ids out of
      // the selection — an emptiness that means "somebody already answered this" would otherwise read
      // as "nothing came after me, go ahead".
      //
      // Present but closed, never merely absent: `getMessages` returns a window, so a burst member
      // missing from it says nothing, and this gate treats an unreadable page as "carry on".
      //
      // Asked as the BOUNDARY rather than "are my ids still in the open set": a member another TURN
      // claimed is missing from that set too, and standing down on it would take the decision away
      // from the claim, whose `partial` is what sends this flush back for the members nobody took.
      const boundary = foreignReplyBoundary(latest, {
        managedBotId: ctx.managedBotId,
        whatsappProvider: ctx.whatsappProvider,
      });
      const answeredByOther = inTurn.some((m) => m.id <= boundary);
      // AS DUAS RECUSAS SÃO PALAVRAS DIFERENTES (issue #703), e a diferença é toda a contabilidade
      // que vem depois. `superseded` afirma que o flush da mensagem nova está armado, e é por isso
      // que ele deixa marca, dispensa e ledger onde estão: a rajada inteira vai ser respondida de
      // novo. Uma pessoa que respondeu não arma flush nenhum — a conversa foi atendida, e o que esta
      // rajada cobria tem que ser fechado como consumido, ou fica para sempre na lista de perdas e
      // volta pela recuperação de entrega.
      //
      // `openAbove` é perguntado primeiro: quando as duas valem, quem vem atrás manda, porque a
      // rajada dele ainda vai ser decidida por inteiro e esta decisão seria tomada duas vezes.
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
  // WHETHER THE BURST ENDED UP IN THE THREAD, reported by the runtime and not read off the outcome
  // (issue #576): `graph.invoke` persists the channel, and the outcome word straddles it in both
  // directions.
  //
  // WRITTEN THERE and not carried to the settlement below: a send that fails after the invoke jumps
  // past it, and the fact would be lost on a burst that really is in memory. Coverage only, never the
  // settlement — closing a row mid-turn takes it out of the sweep's sight.
  let foldedIn = false;
  const outcome = await runLoadedTurn({
    // O PORTÃO DE POSSE DO OUTRO LADO DA ESPERA (issue #757): quando a seleção parou para abrir
    // anexos, a janela entre a checagem de dono do religar e a invocação deixa de ser a rede de um
    // `getMessages` e passa a ser minutos.
    waitedBeforeInvoke: waitedOnMedia,
    onFoldedIn: async () => {
      // ONLY THE MESSAGES WHOSE WORDS THIS BURST HAD (issue #576, PR review round 8), and only the
      // ones that REACHED the turn's input at all (round 10). A voice note still waiting on STT is
      // in the burst as a placeholder — this flush may be the one an EARLIER message armed,
      // re-fetching before the transcription lands (docs/stt.md, "Known limits") — and claiming it
      // would suppress the ingest its own write-back exists to arm. `inTurn` rather than `pending`
      // for a different reason and not a second loss: the two lists are identical today (see
      // `selectAnswerableBurst`), and reading the one the turn's INPUT came from is what keeps them
      // identical, since a member filtered out of the text has no audio to fail the words test with
      // and would be claimed by a turn that never saw it.
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
    // THE AGE OF WHAT THE MODEL IS ABOUT TO READ, resolved here and not at the config load, because
    // this is the first point either caller knows it: the flush and the operator's re-engage both
    // load the config and only THEN fetch the thread (issue #749). Taken from the newest member of
    // `inTurn` rather than `pending`, for the same reason the claim is: a member that reached the
    // burst without reaching the model — a voice note still waiting on its transcription — is not
    // what the age describes.
    //
    // The re-render runs on every burst, including the prompts that carry no age placeholder, and
    // that is affordable rather than free: measured at 67 µs per call over an 8 KB prompt with both
    // the prompt and its audit rebuilt (2.000 calls, and the same 67 µs with the variable present,
    // so the placeholder is not what costs). A turn that is about to call a model takes seconds, so
    // skipping the pass by scanning the template for the two names would trade a measurable nothing
    // for a branch that has to be kept in step with the variable list.
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
    // The burst this turn is exclusive over, in the one column every posting path claims — which is
    // what keeps this flush, a retry of it and an operator's re-engage of the same tail from each
    // sending a reply (issue #452). `runLoadedTurn` also gives it back when the turn throws or
    // stands down, so a failed send does not leave a burst nothing answered marked as claimed.
    claimReply: {
      conversationDbId: convDbId,
      toMessageId: targetWatermark,
      maxHandledAllowed: ctx.claimHandledCeiling(targetWatermark),
      // THE MESSAGES THE TURN'S INPUT ACTUALLY CARRIED, which is `inTurn` and not `pending`
      // (issue #690). The two differ by exactly the members that reached the burst without reaching
      // the model — a voice note still waiting on its transcription renders to nothing — and
      // claiming one of those would close a message the reply never read, which is the defect this
      // list exists to remove rather than relocate.
      messageIds: inTurn.map((m) => m.id),
      initiatedBy: ctx.initiatedBy,
      ...(ctx.onClaimLost ? { onLost: ctx.onClaimLost } : {}),
    },
  });
  // Every completed outcome except "superseded" consumed the burst: answered ("posted", including
  // the input-guardrail template which claims through the same gate), or deliberately dropped
  // (taken over mid-turn, empty reply, guardrail "silent"). Advance so the next flush cannot
  // re-answer the same burst (issue #8: the pre-handoff backlog was re-coalesced — and the bot
  // re-transferred for the old reason — after a human returned the conversation). This is where the
  // watermark moves for BOTH callers now: the post gate claims in its own column, so the advance is
  // no longer a no-op the claim already performed.
  // "superseded" stays put by design: the re-armed flush answers the FULL burst.
  // "stale" stays put too, and NOT by the same reasoning: superseded means a newer message will
  // re-answer this burst, while stale means the burst was withdrawn with the thread the command
  // cleared. Advancing on it would declare handled a set of messages nothing ever answered, and the
  // next inbound would arm a flush that starts after them.
  // NOTE: Which this skip now preserves in EVERY window, including the one it could not before. A
  // retirement landing inside `shouldPost` is caught by the ask after it, and the claim it races is
  // no longer the watermark, so the burst is left unanswered AND unmarked instead of being marked by
  // a CAS that ran on the way past (issue #452).
  // "agent-unavailable" stays put as well (issue #209 review, round 9): the operator silenced the
  // agent while the turn ran, and the rolled-back turn left the burst in nobody's memory. The
  // caller reads the agent again — an observer's ingestion marks the burst once it HAS it, and a
  // switched-off agent's burst waits for the switch, as it does when the config refuses before a
  // turn. Marked here, a failed hand-over would leave it below the mark with nothing remembering it.
  // "thread-busy" stays put for a third reason, and it is the strongest of the three: the turn stood
  // down BEFORE writing anything at all, so nothing in the world has seen these messages. The burst
  // is owed to whoever comes back for it, and this caller is the one that will (the flush reschedules
  // on this word). Marking it here would declare handled a burst that was never even read, which is
  // the "gone and marked done" shape the durable claim exists to prevent (issue #593).
  //
  // AND THE LIST IS BY EXCLUSION, which is why this line is not optional: a word the condition does
  // not name advances the watermark by default. Measured while adding it — the flush correctly
  // answered nothing and rescheduled, and the mark moved to the end of the burst anyway.
  // E `taken-over-unread` FICA DE PÉ, pelo mesmo motivo que o `thread-busy` logo acima e com a mesma
  // força (issue #757): o turno parou ANTES do invoke, então nada no mundo viu estas mensagens — não
  // há divisor, não há claim, o canal não as tem. A palavra só alcança este caminho desde que o
  // religar passou a dizer que esperou (`waitedBeforeInvoke`), e o caminho direto já a exclui pela
  // razão que a #688 fixou. Marcada aqui, a rajada viraria a mensagem perdida: a marca avança, o
  // receptor liquida a entrega como consumida e a ingestão a pula. A lista é por EXCLUSÃO, então
  // esta linha não é opcional.
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
      // THE MIXED CASE, and it is why the parameter is a calculated set rather than a word
      // (issue #690). A turn that answered `[1003,1004,1005]` while the cap dropped `[1001,1002]`
      // closes five messages with two different reasons: the three it answered are already in
      // `message_reply_claims` from the claim it took before sending, and the two it dropped are
      // named here. Said as one word — "this path posted, write nothing" — the dropped pair would
      // be left with no record at all, which reads as open, and something answers them later.
      //
      // On a NON-posting outcome the whole burst is consumed the same way, so `pending` joins them:
      // no claim was taken, so nothing else speaks for those messages. `inTurn` is deliberately not
      // used — a member that reached the burst without reaching the model (a voice note still
      // waiting on its transcription) is not dispensed, it is waiting, and its write-back arms the
      // ingest that answers it.
      dispensed: {
        kind: "messages",
        messageIds:
          outcome === "posted" || outcome === "posted-partial"
            ? dropped.map((m) => m.id)
            : [...pending, ...dropped].map((m) => m.id),
      },
      base,
    });
    // And say so on the LEDGER, for the messages this burst actually contained. A burst re-fetched
    // from Chatwoot can carry a message whose own delivery died mid-processing — rescuing those is
    // what re-reading the thread buys — and that row is still sitting non-terminal with nothing
    // working it. Retired here, the stranded-delivery sweep needs no watermark arithmetic to tell a
    // message a turn covered from one nothing ever looked at (issue #228). Normally updates nothing.
    // Best-effort: a miss costs a line in the loss list, never a reply.
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
        // A DIFFERENT QUESTION from the word above (issue #576). `graph.invoke` persists the channel,
        // so a burst the model answered with nothing is in memory exactly as a posted one is, while
        // settling `consumed`. Reported by the runtime, because the outcome word straddles the invoke
        // in both directions (the input guardrail answers `posted` before it, the output guardrail
        // `blocked` after it).
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
}

// A gate exit consumed the burst without a turn, and the ledger has to hear it too.
//
// These three exits decide before any Chatwoot fetch, so the burst is not known message by message —
// what IS known is the watermark they advance, which says everything up to `last` is handled. A row
// still non-terminal below that is one whose delivery died before arming this very flush, and left
// unretired it becomes a reported loss for a message the product deliberately declined to answer
// (issue #228).
//
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
  // ...OR THE MEMBERS THEMSELVES, when the exit knows them (PR #701, review round 12). Only one of
  // the four gate exits fetched the page before deciding, and for that one the range is strictly
  // worse than the list: a burst that reaches down to an orphan below the watermark spans every
  // message BETWEEN the two, including the ones the selection deliberately left out — a message
  // some other turn claimed and died holding, whose delivery is a genuine loss the sweep still has
  // to report. Settled by range, it silently becomes PROCESSED, which is the one state the sweep
  // never looks at again. The same set the dispensal names, named here too.
  messageIds?: number[];
  // Whether the state that closed the gate is ANOTHER AgentBot, as opposed to a human, a status
  // change or a decision about the contact. The one thing about the gate this exit is scoped by.
  heldByAnotherBot: boolean;
  base: PrismaClient;
  label: string;
}): Promise<void> {
  // Another BOT holding the conversation is the exit that may not widen, and the rule is the direct
  // path's, at its own gate tail. Chatwoot fans a message to up to two routes (`agent_bots_for`: the
  // assignee bot and the inbox bot, each with its own delivery id), so the OWNER's delivery for a
  // message in this range may be `PROCESSING` right now — and a range write turns it `PROCESSED`,
  // the one state the sweep never looks at again. If that route then dies, a customer the owner was
  // answering goes unanswered with nothing anywhere saying so.
  //
  // Skipped whole rather than narrowed, because there is nothing here to narrow TO: the direct path
  // scopes to its own row, and a flush has none — every delivery that armed or extended this burst
  // reached `PROCESSED` at its own tx2, and what this exit retires is rows OTHER deliveries
  // stranded. Standing to close those comes from being the route that decided the silence, and once
  // another bot owns the conversation the silence is only about us.
  //
  // The cost is a strand of ours staying in the loss list while another bot answers the customer:
  // wrong and VISIBLE, correctable by the first turn that runs over the message.
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

// IS THE CONVERSATION STILL THIS ROUTE'S, asked against the mirror at the moment of asking.
//
// The gate at the top of a flush judges ONE instant, and what runs after it takes real time: the
// authorization gate waits on somebody else's endpoint, the spend ceiling on two of our own reads,
// and a human can claim the conversation while either does. So every gate that ACTS on the
// conversation afterwards has to ask again.
//
// One function rather than a block per gate, which is the whole reason it exists: the copy is the
// one that forgets `assigneeId`, and without it `shouldBotHandle` cannot tell OUR bot from another
// one, so a conversation handed to a different bot mid-gate reads as still ours.
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

// A burst the FLUSH found under a monitoring agent (issue #209 review, round 5). The receiver armed
// this job for a production agent, so it neither ingested the messages nor advanced the watermark:
// the turn was going to cover both. The operator then flipped the agent before the job fired. Left
// where the disabled case leaves it, the burst would be the one stretch of the conversation missing
// from the observer's memory — and the first flush after a flip back to production would answer it.
// So the flush does here what the receiver does for every message an observing agent reads: folds
// it into memory, and advances the handled watermark past it.
//
// The messages are re-read from Chatwoot as the flush would have read them, and selected above a
// FLOOR that depends on where the handled watermark stands (round 18). Still below the armed burst,
// the watermark is the floor: everything under it was handled — answered, observed, or deliberately
// skipped — and the burst is exactly what sits above it. Past the burst, it says nothing about the
// burst any more: an observed message that arrived after the flip moved it, and the burst under it
// was never folded in. Then the floor is the LAST REPLY, which is the one mark no observed message
// moves. Ingestion is idempotent by message id (../../graph/ingest.ts), so a message already folded
// costs a skip. Reading above the watermark where it applies is not only cheaper: a reply a hundred
// messages back — or none, for an agent that observed before it answered — would send the walk to
// its bound with the whole burst already in hand, and leave it unmarked for a later flush to answer
// a second time. The watermark moves only past what was actually read: a burst the walk could not
// bring into view stays unmarked (round 7), and the flush fails so the loss is visible (round 25):
// the ordinary flush reads one page and would advance the watermark past what the bound left out.
// Chatwoot's page size for a conversation's messages, and how far back the observed-burst read
// walks before it gives up on finding the floor: five pages is a hundred messages, well past any
// burst a debounce window can hold.
const CHATWOOT_MESSAGES_PAGE = 20;
const OBSERVED_BURST_MAX_PAGES = 5;

// A hand-over that FAILED is a flush worth retrying (round 17): a monitoring agent arms no second
// flush for the burst, and the next observed message moves the watermark past it, so completing the
// job here would be the one way to lose the burst for good. Thrown so the scheduler retries with
// backoff and, past the cap, dead-letters it where an operator sees it. "unread" — a bound reached,
// no thread — is permanent and stays a completed job, logged. A read of the AGENT that failed is
// "failed" too (round 20): collapsed into "not observing", it would have the exit mark the burst
// handled on an answer nobody got. So is a walk that reached its bound (round 25): deterministic,
// so the retries change nothing, but the dead-letter past the cap is what keeps the loss visible.
// Its own class, so the flush's catch can tell it from a turn that threw (round 20): that catch
// hands the burst over once more before rethrowing, which for THIS error would be a second attempt
// at the very read that just failed, on the way to a retry that makes the same attempt anyway.
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

// The gate-closed exit's own ask (round 15): that branch loads no config, so it reads the switch,
// the mode and the settings itself. "not-observing" leaves the exit exactly as it was.
async function handOverGateExitIfObserving(args: {
  tenantId: bigint;
  instanceId: bigint;
  conversationId: number;
  agentId: bigint | null;
  convDbId: bigint;
  contactInboxId: number | null;
  armedLast: number | null;
  // Whether the burst holds a customer's reaction (issue #746); see `readReactionArmed`.
  reactionArmed?: boolean;
  reactionFrom?: number | null;
  // Another BOT holds the conversation (round 16): Chatwoot fans one message out to both routes,
  // and the owner's own delivery of it may be in flight. The burst is still the observer's to
  // remember, but its delivery rows are not this route's to settle — the same scope
  // `settleGateExit` keeps.
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
  // No contact-inbox thread to fold the burst into means nothing of it can be remembered here, and
  // then nothing of it is marked either (round 8): left below the watermark, it is the burst a
  // later flush answers, rather than one consumed on the way to nowhere.
  if (ctx.contactInboxId === null) {
    logger.warn(
      "debounce flush: the agent is observing now (conv=%s) but the conversation has no contact-inbox thread; leaving the burst unmarked",
      String(conversationId),
    );
    return "unread";
  }
  let newest = armedLast;
  // HOISTED so the watermark advance at the tail can name what it closed (issue #690). Filled by the
  // fetch loop below, one id per message this route folded into memory.
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
      // The floor the walk reads down to and the burst is selected above (see the note on this
      // function). The watermark, while it still sits below the armed burst — and never lower than
      // the reply, which a claim can write a moment before the turn advances the watermark. Past
      // the burst, or with no armed id to compare it against, the reply.
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
      // PAGED BACKWARD until the floor is in view (round 6). Chatwoot answers with the newest page,
      // and enough traffic after the flip — every message of it observed, so the watermark is
      // already past this burst — pushes the armed messages off it; read from that page alone the
      // burst would be empty, the watermark would move anyway, and the messages would be the one
      // stretch nothing remembers. A page shorter than Chatwoot's is the conversation's first, and
      // the walk is bounded so a floor that never comes into view cannot turn into a crawl.
      let rows = parseChatwootMessages(
        await client.getMessages(conversationId),
      );
      const messages = [...rows];
      // Whether the walk SAW the floor — the conversation's first page, or a message at or below
      // it. Only then is every message of the burst in hand, and only then may the
      // watermark move past it (round 7): a walk that stopped at its bound has messages it never
      // read, and marking those handled would be the one way to lose them for good. Left unmarked,
      // they are still the burst the next flush after a flip back to production answers.
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
      // A REAÇÃO QUE NENHUMA PÁGINA TRAZ (issue #746): a mesma leitura complementar do flush, a
      // partir do piso que esta caminhada lê, para a observação lembrar o que o cliente reagiu.
      const caught = await withCaughtUp(client, conversationId, messages, {
        armedLast,
        after: floor,
        reactionArmed: args.reactionArmed === true,
        reactionFrom: args.reactionFrom ?? null,
      });
      if (caught !== messages) messages.splice(0, messages.length, ...caught);
      overlayMediaAnnotations(tenantId, instanceId, messages);
      // POR IDENTIDADE AQUI TAMBÉM (PR #701, review round 6). A observação ingere e MARCA a rajada,
      // então ela tem que enxergar o mesmo conjunto que o flush enxerga: a órfã abaixo da marca, que
      // esta PR ensinou a seleção a oferecer, ficaria sem ser ingerida e sem linha nenhuma, com a
      // troca para observação declarando a passagem bem-sucedida. Voltando para produção, um flush
      // depois executa aquele pedido velho.
      //
      // A PAGINAÇÃO CONTINUA SENDO A ESCALAR, de propósito: ela alcança de volta até o piso escalar,
      // e é o que limita o custo desta varredura. Uma mensagem aberta que esteja FORA dessa janela
      // continua fora daqui, e é o flush seguinte que a pega.
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
        // "Devo LEMBRAR disto?", que não é "posso responder a isto?" (PR #701, review rounds 7 e 8).
        // As duas cercas da resposta ficam de fora, e por motivos que são o mesmo motivo: a memória
        // do observador guarda o que o CLIENTE disse, e nem quem respondeu nem uma decisão de não
        // responder mudam isso. Ligada a primeira, uma resposta humana esconde da memória as
        // perguntas atrás dela; ligada a segunda, a recusa por teto esconde a rajada inteira que ela
        // acabou de nomear. Nos dois casos a passagem declara sucesso sem ter lembrado nada.
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
          agentId: ctx.agentId,
          compactionEnabled,
          base,
        });
        handedIds.push(m.id);
        if (newest === null || m.id > newest) newest = m.id;
      }
      // And on the LEDGER, for the messages the observer now has (round 15): a delivery whose
      // process died between arming this job and writing its final status sits non-terminal, and
      // the stranded-delivery sweep would otherwise recover — and re-run — a message already
      // remembered. The same retirement the flush makes after a turn; best-effort like it.
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
      // The burst was the customer's, and a watcher's verdict on it is armed the way the receiver
      // arms one for each message it hands over (issue #477): best-effort, after the memory has it.
      await armObserve({
        tenantId,
        instanceId,
        conversationId,
        agentId: ctx.agentId,
        reason: "burst",
        cfg: readMonitoringConfig(ctx.settings),
        // The newest message of the burst that was just handed over, in Chatwoot's own sequence:
        // the reset fence the tick is held to is asked in that order (issue #477 review, round 6).
        atMessageId: handedIds.length > 0 ? Math.max(...handedIds) : null,
        base,
      });
      if (!floorInView) {
        // "A later flush answers it" was the round-7 reasoning for leaving the burst unmarked, and
        // it does not hold (rounds 23 and 25): with the watermark already past the burst nothing
        // re-coalesces below it, and with the watermark still below, the ordinary flush reads the
        // NEWEST PAGE ONLY (selectAnswerableBurst) and advances the watermark past whatever the
        // bound left out of view. Either way the burst beyond the bound is gone quietly. Failed
        // instead — retried by the scheduler and, past the cap, dead-lettered where an operator
        // sees it: wrong and visible over quiet and wrong.
        logger.warn(
          "debounce flush: the armed burst was not fully in view after %d page(s) (conv=%s); failing the flush so the loss stays visible",
          OBSERVED_BURST_MAX_PAGES,
          String(conversationId),
        );
        return "failed";
      }
    } catch (e) {
      // Same rule as a walk that stopped short: what was not read is not marked. And unlike it,
      // TRANSIENT (round 17): a read or an enqueue that threw is a flush worth retrying, where a
      // bound reached or a missing thread is not — a monitoring agent arms no second flush, and
      // the next observed message moves the watermark past a burst this one gave up on.
      logger.warn(
        "debounce flush: could not hand the armed burst to ingestion (conv=%s), leaving the watermark for a retry: %s",
        String(conversationId),
        err(e),
      );
      return "failed";
    }
  }
  // The redirect ladder on a WIDGET conversation is retired on the hand-over too (round 22). Its
  // cancel-on-reply is the re-arm the receiver makes when it dispatches a turn, which this burst
  // had — and the turn stood down, or never ran. Left armed, the ladder waits out the mode (its own
  // fence stands it down while the agent observes) and the first flip back to production sends a
  // template to a lead who had already answered. Retired, not re-armed: nothing is owed here.
  // Best-effort, as the receiver's own retirement is.
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
      // Handed to ingestion rather than answered: the words are remembered and no reply is coming,
      // which is a dispensal, and this exit fetched the burst so it names its members (issue #690).
      //
      // EMPTY WHERE THE FETCH DID NOT HAPPEN, and that is left as it is rather than widened. `newest`
      // starts at `armedLast`, which the arm supplies without a fetch, so this tail can be reached
      // with no list — and the span that would cover it has no lower bound here (this function is
      // handed no watermark), so a range would reach back over the whole conversation and close
      // messages this decision never touched. Naming nothing leaves those messages as they were
      // before this table existed; naming everything would close a history on a guess.
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
        // Read here for one branch only: the spend ceiling's shortcut below, which is a claim about
        // this conversation's whole backlog and stops being true once the per-message era starts on
        // it (issue #698).
        replyClaimFloorMessageId: true,
      },
    });
    if (!conv?.inboxId) return null;
    // NOTE: Read above the gate so a gate that CLOSES can still say whose conversation it was: the
    // line it writes is filtered by agent on the Logs page, and one written without an agent id is
    // invisible in exactly the view an operator investigating one agent is looking at.
    //
    // NOTE: the unbound-inbox bail stays BELOW the gate, where it was. Above it, a closed gate on an
    // inbox that lost its agent would leave without advancing the watermark, and the burst it was
    // holding would be re-coalesced and answered after a later rebind. Attribution is worth a
    // nullable id here; it is not worth changing what the gate does.
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
        // AND O PISO DA ERA COM ELE (PR #701, review round 4). Sem este campo aqui, o `gateExitFrom`
        // logo abaixo cai de volta na marca exatamente no ramo em que o portão de posse fecha, e a
        // órfã abaixo da marca fica sem linha: o mesmo defeito que a rodada 3 consertou nos outros
        // sítios, sobrevivendo num ramo do contexto que não carregava o campo.
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
      // NOTE: The inbox has no agent — it never had one, or it lost it between the arm and this
      // flush. The burst is the customer's, and until issue #318 this exit was as silent as the
      // webhook's: same state, same line, written by the same producer. The watermark is
      // deliberately NOT advanced (see the note above): the burst has to survive a later rebind.
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
      // NOTE: The config refuses a monitoring agent the way it refuses a disabled one, and the two
      // must not share this exit: a disabled agent's burst waits for the switch, an observing
      // agent's burst is the observer's to read (issue #209 review, round 5). Classified from a
      // read taken AFTER the refusal (round 6): `agentRow` above and the config load are two
      // statements, and a flip landing between them would leave the row saying production while
      // the config says no — the burst then left where a disabled agent's is, unremembered.
      const now = await db.agent.findUnique({
        where: { id: inbox.agentId },
        // ...AND THE SETTINGS FROM THE SAME READ (issue #477 review, round 15). `agentRow` predates
        // the flip this branch just detected, and the same edit usually carries the `analysis`
        // setting the arm asks about — so arming off it can answer `off`, while the burst is
        // ingested and marked handled, leaving it permanently unobserved. Same defect the receiver
        // had on its own hand-over path (round 12); this is the flush's copy of it.
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
  // ONDE A AUSÊNCIA DE LINHA COMEÇA A SIGNIFICAR ALGUMA COISA, e por isso o limite inferior de toda
  // faixa que um gate exit grava (PR #701, review round 3). Um gate exit decide antes de qualquer
  // busca no Chatwoot, então ele não sabe nomear os membros e diz o VÃO que consumiu. O vão começava
  // na marca, e desde que a seleção parou de ser escalar existe mensagem aberta ABAIXO dela: a órfã
  // sem linha, que a faixa deixava de fora e o primeiro flush seguinte oferecia de novo, executando
  // um pedido que este exit já tinha descartado. Abaixo do piso da era nada precisa de linha, porque
  // lá os escalares decidem inteiros; entre o piso e o `last` está tudo que este exit consome.
  const gateExitFrom = ctx.perMessageFloor ?? ctx.watermark ?? null;

  // NOTE: An unbound inbox is a state an operator has to repair, so it leaves the same line the
  // webhook's direct path leaves rather than ending as a silent "done" (issue #318).
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
  // NOTE: The gate closed between the arm and this flush, and TWO different events wear that exit:
  // a human took the conversation, or it left `pending` with nobody on the other side — most often
  // Chatwoot escalating after a slow ack. Either way the burst counts as handled: the arm path kept
  // its newest message id in the payload precisely so this advance needs no network fetch (issue
  // #8), because without it the burst would sit below the watermark and the first flush after the
  // human returns the conversation would re-answer it.
  //
  // NOTE: the line is what this branch was missing (issue #271). The escalation closes THIS gate
  // rather than the runtime's recheck — no turn ever starts — so without a line here the case the
  // distinction exists for is the one case nothing records.
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
    // The gate closed BEFORE the mode was read, so the exits below never see an observer (issue
    // #209 review, round 15): a burst armed under production, then flipped to monitoring, then
    // taken by a human, was marked handled here with nothing remembering it. Asked from a read of
    // its own, since this branch loads no config; marked only once the observer has it, as the
    // other exits do.
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
        // A GATE EXIT, which is the one caller that cannot name its members: it decides before any
        // Chatwoot fetch, so the burst is not known message by message — only the span it advances
        // over, which is what `settleGateExit` below states to the ledger with the same two bounds.
        // The decision was taken over the span ("this is not ours to answer now"), so the span is
        // the fact rather than a hull of one (issue #690).
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

  // The spend ceiling, again, at the point the TURN happens, and for the reason the gate below is
  // asked twice: debounce means the message that ARMS a flush and the turn that runs it are minutes
  // apart, and the tenant can cross its ceiling inside that window — from its own other
  // conversations, or from this one's earlier burst. The webhook's ask covered the arming; this one
  // covers the turn, which is the thing that actually spends.
  //
  // The burst is dropped the way a refused contact drops it: the watermark advances off the payload's
  // own last id, nothing is answered, and the flow line is what tells the operator. Where it goes
  // further is that this refusal is the FIRST one. A contact refused here was already told and
  // handed off by the webhook delivery that was refused; a ceiling crossed inside the debounce
  // window never refused anything, so this flush owes the whole contract — the operator's sentence
  // to the customer, the handoff, and the note — under the same cooldown key the webhook gate uses.
  //
  // None of it can be left to the customer's next message. With `handoffEnabled` (the default) the
  // open is precisely what takes the conversation out of `pending`, so `shouldBotHandle` is false
  // from then on and no later message of theirs reaches a gate at all; with the handoff off the
  // conversation stays `pending`, but the burst being dropped here would go unanswered in silence
  // unless the customer happened to write a second time.
  // NOTHING LEFT TO ANSWER ⇒ NOTHING TO REFUSE, asked before the ceiling rather than after it. A
  // claimed job can be retried after an earlier attempt already advanced the watermark past this
  // payload's own last id — the attempt answered the burst and died before the scheduler could mark
  // the job done. Over the ceiling, the retry would then tell the customer the agent cannot answer,
  // hand the conversation off and write a refusal, all about a burst that was answered. Read off
  // the payload and the watermark this flush already holds, so it costs nothing; a payload with no
  // last id cannot say, and falls through to ask exactly as before.
  // THE BURST SELECTOR, hoisted: the ceiling branch below asks the same question the turn does, and
  // it has to be the same closure or the two would answer about different floors.
  //
  // Re-read, not the value captured before the authorization call: that call is a round-trip to
  // somebody else's endpoint with a ceiling of ten seconds, and a message that arrived and was
  // REFUSED inside that window has already had the watermark advanced past it by its own delivery.
  // Against the stale value it would be selected here and handed to the model, and the post gate
  // would only withhold the reply — after the tools had run. The floor is the one this flush read at
  // claim time, so a watermark that somehow reads lower cannot widen the burst.
  //
  // And it is the ANSWERED floor rather than the watermark, because the two can disagree: the reply
  // claim is written before the send and the watermark after the turn, so a reply whose watermark
  // write was lost leaves the message answered with the mark behind it (issue #452).
  const selectPending = async (messages: ChatwootMessageRow[]) => {
    const fresh = await readAnsweredFloor({
      tenantId,
      conversationDbId: ctx.convDbId,
      base,
    });
    const armed = ctx.watermark;
    const floor =
      fresh === null ? armed : armed === null ? fresh : Math.max(fresh, armed);
    // AND ABOVE THE PER-MESSAGE FLOOR THE SCALAR DOES NOT DECIDE (issue #698).
    //
    // A competing claim writes `last_replied_message_id`, which is exactly what the floor above
    // reads, so one turn claiming message 1002 raises it over 1001 too. 1001, which has no row
    // anywhere, would be excluded from this burst and from every burst after it, and nothing ever
    // comes back for it: the selection doing by arithmetic what the claim stopped doing in #690.
    //
    // The rule itself is `selectOpenMessages`, shared with the two supersede gates that ask the same
    // question, and its fences are the boundaries the scalar used to carry for free by the accident
    // of being one number that only moved forward. The first attempt at this carried none of them
    // and was reverted for it (#690, review round 7, 3bdbc1dd).
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
      // A PERSONA CARREGADA, não o bot que o payload nomeou (PR #701, review round 6). Quem envia é
      // `ctx.loaded.agentBotToken`, e o payload é de quando o job foi armado: com o inbox religado a
      // outra persona nesse meio-tempo, os dois divergem, e o aviso que ESTA persona acabou de postar
      // seria classificado como de terceiro — a fronteira fecharia a própria rajada dela e o portão
      // engoliria a resposta. Quem classifica a saída tem que ser o mesmo que a produz.
      purpose: "reply",
      managedBotId: ctx.loaded.agentBotId,
      whatsappProvider: ctx.loaded.whatsappProvider,
    });
  };

  // The operator flipped the agent to monitoring during one of this flush's waits (issue #209
  // review, rounds 6 and 9): the burst is the observer's, whichever exit the flush takes — the
  // ceiling's, the authorization's, or the turn's. Asked at each of those exits rather than once,
  // because each sits behind its own stretch of I/O.
  //
  // Answers whether the OBSERVER HAS the burst (round 11): an exit that marks the burst on its way
  // out asks first, and a hand-over that could not read it leaves the burst unmarked, for a later
  // flush — marked, it would be below the watermark with nothing remembering it.
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
  // The catch-up read the two burst reads below ask (issue #746): see `readBurstPage`.
  const flushCatchUp = {
    armedLast,
    after: ctx.watermark ?? null,
    reactionArmed: readReactionArmed(job.payload),
    reactionFrom: readReactionFrom(job.payload),
  };
  // ONLY WHILE THE SCALAR STILL SPEAKS FOR THE WHOLE BACKLOG (issue #698). The shortcut reads "the
  // mark covers this payload's last id, so there is nothing left to answer and nothing to refuse" —
  // a statement about every message below the mark, which was safe while the selection asked the
  // same single number. It is not safe once this conversation has a per-message floor: above that
  // floor a message with no row is still owed, and it sits BELOW the mark by exactly the accident
  // this issue is about. Taken there, the turn runs the model and its tools without the spend
  // verdict ever being asked, and suppressing the reply afterwards does not unspend it.
  //
  // Where the shortcut no longer applies, nothing is said to the customer by mistake: the `over`
  // branch below re-runs the same selection and returns silently when it finds nothing.
  const alreadyAnswered =
    ctx.perMessageFloor === null &&
    armedLast !== null &&
    ctx.watermark !== null &&
    ctx.watermark >= armedLast;
  const flushCeiling = alreadyAnswered
    ? null
    : await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base,
      });
  // THE COMMAND'S FENCE, asked before the LINE and not only before the acts below. `/reset` retires
  // the burst, and a flush already CLAIMED is past every cancel — that is the whole reason
  // `stillWanted` exists on the turn path, asked once per WRITE rather than once per run. The flow
  // line is a write like any other: it is what the Logs page counts refused customers by, and an
  // `over` line is `error` severity, so it pages the alert channels too. A burst the operator
  // withdrew refused nobody, so there is nothing to report about it — and the claim the announcement
  // spends is the same one the real refusal would need later, which is the second cost of writing it
  // here (`spendCeilingAnnouncement` consumes the window as it decides, deliberately).
  //
  // Retired ⇒ this refusal is withdrawn with the burst rather than delivered about it. The watermark
  // stays where it was, which is the contract the reset scenarios already fix: the burst was not
  // answered, it was taken back, and a later flush asks the ceiling again with a fresh notice window.
  // Lenient (`jobRetired`, not the strict probe): an unreadable retirement row leaves this acting,
  // which is where every caller outside the thread's critical section sits, and the cost of that
  // guess here is a sentence sent once too often.
  const stillWanted = async (act: string): Promise<boolean> => {
    if (await jobRetired(job, base)) {
      logger.info(
        "debounce flush: spend-ceiling %s withdrawn with the burst (conv=%s) — the job was retired",
        act,
        String(conversationId),
      );
      return false;
    }
    // And the operator's own silences (issue #209 review, round 6): the ceiling's copy, note and
    // handoff are this flush's outputs like a reply is, and the config they were decided under is
    // the burst fetch old by the time they run. An agent switched off or flipped to monitoring in
    // that stretch does none of them.
    if (!(await agentStillSpeaks(tenantId, ctx.loaded.agentId, base))) {
      logger.info(
        "debounce flush: spend-ceiling %s withheld (conv=%s) — the agent was switched off or flipped to monitoring",
        act,
        String(conversationId),
      );
      return false;
    }
    return true;
  };
  // NOTHING TO ANSWER ⇒ NOTHING TO REFUSE, the second half of that rule and the one the watermark
  // cannot see. The `alreadyAnswered` check above catches a burst an earlier attempt ANSWERED; this
  // catches one that has nothing in it — the armed message was deleted, or it is an attachment that
  // renders to no answerable text. Without the ceiling that burst reaches `coalesceAndRunTurn`,
  // which returns "empty" and says nothing to anybody; over it, the branch below would send the
  // operator's sentence to a customer who is not waiting for one, put the conversation in a human's
  // queue, and declare the burst handled.
  //
  // Asked with the SAME selector and the same rendering the turn uses (`selectAnswerableBurst`), and
  // only on the refusing branch: `allowed` and `warning` both go on to ask it for real, and paying a
  // Chatwoot page here would double every flush's fetch to answer a question that path answers
  // anyway. The refusal is already three network writes deep, so one read is not what makes it
  // expensive.
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
      // ONE LINE PER REFUSED BURST, not one per attempt at it. Advancing the watermark is the last
      // thing this branch does and it is a database write, so a flush that refuses and then throws
      // is re-pended by the scheduler and runs again on the same burst — writing a second `error`
      // line and paging the alert channels a second time about one refusal. Named by the burst the
      // way the customer-facing sequence below is: the conversation plus the payload's own last id,
      // which a retry repeats and the next burst does not.
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
    // The PERSONA's token, not an empty one. `sendMessage`, `sendPrivateNote` and `toggleStatus` are
    // all bot-token endpoints (docs/chatwoot.md), and a client built without it never reaches
    // Chatwoot at all: the call raises ChatwootMissingTokenError, the catch logs it, and the burst is
    // marked handled while the conversation stays on a bot that will not answer (issue #79 is that
    // shape). Null when the persona has no Chatwoot bot of its own, and then the same error is the
    // honest report — there is no identity to speak or hand off as.
    const ceilingClient = () =>
      loadChatwootClient(tenantId, instanceId, {
        base,
        makeClient: deps?.makeClient,
        botToken: ctx.loaded.agentBotToken ?? undefined,
      });
    // OWNERSHIP, a different question from the command's fence above and asked alongside it
    // immediately before EACH act — the fence the webhook's own primitives carry, and for the same
    // reason. The gate at the top of this flush judged the instant before two database reads, and
    // the send below is a network call the next act sits behind. A human
    // claiming the conversation inside either window would otherwise be talked over, or have it
    // pulled back out of their hands by a gate that had already decided to go quiet. Dropping the
    // burst is right either way; only what we say and the status change are theirs to lose.
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
      // THE CLIENT FIRST, then ownership, then the mode — and the mode LAST, one statement before
      // the write (round 23): the build resolves the base URL's host and the ownership probe is a
      // read, both waits an operator's flip can land in. Same order the receiver's gate keeps.
      postPublicMessage: async (text) => {
        // Inside the try, deliberately: a fence that cannot answer has to report "not sent" like any
        // other failure, so the notice window it just claimed is given back.
        try {
          const client = await ceilingClient();
          if (!(await stillOurs("message")) || !(await stillWanted("message")))
            return false;
          await client.sendMessage(conversationId, text);
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
    // The last write, and the last ask, because the three above are network round trips a command
    // can land inside. This is the one the reset scenarios name explicitly: a retired burst was
    // withdrawn, not answered, so the watermark stays where it was and a later flush re-coalesces
    // it against the thread the command cleared.
    if (last !== null && (await stillWanted("settlement"))) {
      await advanceHandledWatermark({
        tenantId,
        conversationDbId: ctx.convDbId,
        toMessageId: last,
        // A GATE EXIT, which is the one caller that cannot name its members: it decides before any
        // Chatwoot fetch, so the burst is not known message by message — only the span it advances
        // over, which is what `settleGateExit` below states to the ledger with the same two bounds.
        // The decision was taken over the span ("this is not ours to answer now"), so the span is
        // the fact rather than a hull of one (issue #690).
        // THIS gate exit CAN name its members, unlike the other three: the ceiling refusal already
        // fetched the page, to find out whether there was a burst to refuse at all, and
        // `ceilingBurst` is that burst. The span alone stopped being enough when the selection
        // stopped being scalar (PR #701, review round 2): it reaches back only to the watermark, and
        // the message this refusal is ABOUT can sit below that mark with no row on it, which is
        // exactly the orphan this PR teaches the ceiling to see. Left to the span, the withdrawn
        // request is executed by the first flush that has budget again.
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
        // NOMEADO, PELO MESMO CONJUNTO DA DISPENSA (PR #701, review rounds 3, 7 e 12). O ledger
        // fecha por faixa quando o exit decide antes de qualquer fetch, e daqui isso era errado nas
        // duas pontas: começando na marca, deixava a entrega da órfã consumida parada e reportada
        // como perda (rodada 3); parando no `last` do payload, deixava a da mensagem mais nova que
        // a releitura trouxe (rodada 7). Esticar a faixa consertou as duas e abriu uma terceira: a
        // faixa passa a cobrir tudo o que está ENTRE a órfã e o topo, inclusive o que a seleção
        // deixou de fora de propósito — a entrega que outro turno reivindicou e morreu segurando,
        // que é perda de verdade e some do relatório virando PROCESSED.
        //
        // Este é o único dos quatro gate exits que leu a página antes de decidir, então é o único
        // que pode nomear. Os outros três continuam na faixa porque não têm o que nomear.
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

  // The contact-authorization gate, again, at the point the TURN happens. The webhook checks every
  // incoming message, but the turn is not the message: debounce means one message can arm a flush
  // that a later, refused message then rides into. The refused delivery returns "consumed" and arms
  // nothing, yet the flush already pending re-fetches everything past the watermark, so the refused
  // message reaches the model anyway — and a revocation landing inside the coalescing window is the
  // same hole from the other side. "No turn for a contact the endpoint will not vouch for" is a
  // statement about turns, so it has to be checked where a turn begins.
  //
  // A refusal ends the flush exactly like a human takeover does: the burst counts as handled (the
  // watermark advances off the payload's own last id, no fetch needed) and nothing is posted. No
  // customer copy and no handoff — those answer a message the customer just sent, and the webhook
  // path already gave them to the delivery that was refused; a verdict that flipped inside the
  // window reaches the customer on their next message, which is what "re-checked every message"
  // means. The flow line is what tells the operator this burst was dropped.
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
          // Same gate exit, same reason as the one above: the span is what this decision was taken
          // over, and its members are not known here (issue #690).
          dispensed: { kind: "range", afterMessageId: gateExitFrom },
          base,
        });
        await settleGateExit({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: ctx.convDbId,
          // O MESMO LIMITE DA DISPENSA, sempre (PR #701, review round 4). O ledger fecha o conjunto
          // que a decisão consumiu, e desde a rodada 3 esse conjunto desce até o piso da era. Dois
          // limites diferentes para uma decisão só deixam a entrega da órfã parada, reportada como
          // perda que ninguém atendeu e elegível para recuperação, depois de a decisão já ter sido
          // tomada sobre ela.
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
      // NOTE: the same exit as the gate on the way in, so it says the same thing. The old line here
      // asserted a human takeover, which is the reading issue #225 measured as wrong: the ten
      // seconds this fence exists for are ten seconds in which Chatwoot can escalate the
      // conversation out of `pending` with nobody on it.
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
          // Same gate exit, same reason as the one above: the span is what this decision was taken
          // over, and its members are not known here (issue #690).
          dispensed: { kind: "range", afterMessageId: gateExitFrom },
          base,
        });
        await settleGateExit({
          tenantId,
          instanceId,
          conversationId,
          conversationRowId: ctx.convDbId,
          // O MESMO LIMITE DA DISPENSA, sempre (PR #701, review round 4). O ledger fecha o conjunto
          // que a decisão consumiu, e desde a rodada 3 esse conjunto desce até o piso da era. Dois
          // limites diferentes para uma decisão só deixam a entrega da órfã parada, reportada como
          // perda que ninguém atendeu e elegível para recuperação, depois de a decisão já ter sido
          // tomada sobre ela.
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

  // A TURN ALREADY RUNNING ON THIS THREAD is the one thing between here and the invoke that no gate
  // above asks about (issue #588), and the arm side decided it deliberately: `armDebounce` treats a
  // claim in flight as "the previous flush is finished business", so a customer writing mid-turn
  // opens a NEW burst and its flush fires a window later, while the first turn is still in the
  // model, in a tool, or paying out its split balloons.
  //
  // MEASURED rather than reasoned about, on 4b35f318: two flushes on one conversation gave a peak of
  // two concurrent model calls, both handed a history without the other's answer, and a checkpoint
  // whose channel held the customer's burst TWICE — each invoke is a read-modify-write of the whole
  // channel, so each appended what it had loaded. The duplicate is permanent memory the summarizer
  // reads. What did NOT happen is a second reply: the watermark CAS already dedups the post, which
  // is why this defers the TURN and not the answer.
  //
  // HERE AND NOT INSIDE `coalesceAndRunTurn`, which the operator's re-engage button calls too
  // (../conversations/reengage.ts): an exclusion in there would turn a deliberate human action into
  // a silent no-op. The flush is the caller that has somewhere to defer TO.
  //
  // THE GRAPH THREAD is the key, not the conversation's: the channel is per contact-inbox, so two
  // conversations of the same contact corrupt the same memory and have to take turns on it. The
  // narrower key would leave that case exactly as it is today.
  //
  // Same shape as continuous ingestion, which had this hazard first and answered it the same way
  // (../../graph/ingest-job.ts): put the work down and come back, rather than append into a channel
  // somebody else is about to overwrite.
  const graphThreadId = resolveGraphThreadId(
    tenantId,
    instanceId,
    conversationId,
    ctx.contactInboxId,
  );
  // THE MAPS ARE THIS PROCESS ONLY, and every other writer on this thread already knows it: ingest,
  // the reset gate, the delivery recovery and compaction all ask `turnOwnsThread`, which reads the
  // claim in the thread's own row. The flush was the one writer left asking only the registry, so on
  // the topology docs/deploy.md §4 sanctions it invoked a thread another replica was running
  // (issue #593, measured: 1 model call and 1 send where both had to be 0).
  //
  // ONLY FOR THE KEY THAT HAS A ROW. `resolveGraphThreadId` falls back to the per-conversation
  // thread when the contact inbox is unknown, and that key has no `agent_threads` row to hold, so
  // there the Map stays the whole answer at the cost issue #203 measured and accepted. Asking the
  // row for it would read "free" forever and add a query per flush for nothing.
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
  // A LAPSED LEASE MEANS A HOLDER DIED MID-TURN, and this flush is the recovery. It proceeds, which
  // is what expiry has always meant here, and says so: nothing else on this path would report that
  // a replica went down holding a customer's thread, and issue #593 asks for the line by name
  // ("there is no durable claim to find expired, so there is no recovery to log").
  if (durableClaim.staleHolders > 0) {
    logger.warn(
      "debounce flush: the claim on thread %s is stale (%s holder(s), lease already expired); recovering the burst on conversation %s",
      graphThreadId,
      String(durableClaim.staleHolders),
      String(conversationId),
    );
  }
  // THE DEADLINE IS THE BURST'S, NOT THE BRANCH'S, and it is computed out here for that reason.
  // There are TWO exclusion paths now and they have to honour one ceiling: this branch, reached when
  // the thread already reads busy, and the stand-down at acquisition time, reached when the thread
  // reads FREE and somebody takes it in the window before the turn's own claim. Round 3 of review
  // found the asymmetry: a flag set only inside this branch is false on the other path by
  // construction, so a burst already past its deadline could be stood down again on every
  // acquisition race and never be answered — the exact starvation the ceiling exists to stop.
  const nowMs = Date.now();
  // THE CEILING IS A DEADLINE, NOT A COUNTER, and both obvious counters are already ruled out.
  // `rescheduleJob` writes `attempts = 0`, so the scheduler's own retry budget never runs down and
  // a deferral loop never reaches DEAD. A counter carried in the payload is worse: `armDebounce`
  // re-arms with a full payload and `upsertJobRow` treats a present payload as authoritative, so
  // the next message the customer types ERASES it — the counter would vanish in exactly the case
  // it exists for, a customer who keeps writing at a thread that is stuck.
  //
  // `burstStartedAt` survives because `armDebounce` reads it back off the row and rewrites it
  // while the burst continues, which is the same anchor its own anti-starvation cap uses.
  //
  // `deferringSince` is stamped on the FIRST deferral and carried by `armDebounce` across every
  // re-arm of a live row. `burstStartedAt` alone was not enough and review of this change is what
  // showed it: a message arriving while the flush is CLAIMED opens a new burst by design, taking a
  // fresh `burstStartedAt` with it, so a customer who kept typing at a wedged thread pushed the
  // deadline forward on every arrival and was never answered. It falls back to `burstStartedAt`
  // for the first pass, before any stamp exists.
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
      // NOT a failure, and the distinction is load-bearing: a `fail` here would spend an attempt,
      // stamp `last_error` on the conversation and eventually dead-letter a burst whose only problem
      // is that it arrived at a busy moment.
      //
      // Stamped through its own write under the ARM lock rather than as a `payloadPatch` here: the
      // patch rides `rescheduleJob`, whose CAS requires the row to still be CLAIMED, and the window
      // the stamp has to survive is exactly the one where a message re-armed it to PENDING and the
      // CAS fails. See `stampDeferral`.
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
    // PAST THE DEADLINE WE RUN ANYWAY, which is a choice and not an oversight. A turn that never
    // releases the thread would otherwise leave the customer unanswered forever, and an unanswered
    // customer is worse than a duplicated line in the agent's memory. Loud, because a thread that
    // reaches this has something wrong with it that no other line would report.
    logger.warn(
      "debounce flush: a turn has held thread %s past the deferral ceiling; answering conversation %s anyway",
      graphThreadId,
      String(conversationId),
    );
  }
  // RESERVED IN THE SAME TURN OF THE EVENT LOOP as the check above, with no await between them, and
  // that adjacency is the whole point. A turn marks itself deep inside `runLoadedTurn`, several
  // awaits past here — a message fetch, the burst selection, the authorization gate — so between the
  // check and the mark there is a window in which a SECOND flush reads an unheld thread and passes.
  // The window is reachable: two conversations of one contact are two scheduler rows, claimed in the
  // same tick and started concurrently by `runDebounceTick`, and they share this key.
  //
  // ITS OWN REGISTRY, not `markTurnReserved`, and review is what showed why. `reserved` is counted
  // by `isTurnInFlight`, which two subsystems ask before doing their own work on this thread:
  // `undoRefusedTurn` refuses to roll back a superseded answer while it reads true, and
  // `claimIngestWrite` answers busy so `drainPendingIngest` reaches nothing. A hold across the whole
  // turn therefore made every debounce rollback skip and every queued message miss its own reply.
  // `markFlushHold` is read by this line and by nothing else.
  markFlushHold(graphThreadId);
  // THE WAITING IS OVER, so the stamp that measured it goes. Left behind, it outlives its burst: a
  // message arriving during this flush's delivery re-arms the row and carries the stamp into the
  // next burst, and completion cannot clear it because that CAS needs a CLAIMED row. Once it ages
  // past the ceiling every later flush skips the check above outright — the protection switching
  // itself off, which is worse than the defect it was built for.
  //
  // Only when this job actually carried one: the claimed payload IS the row's payload at claim time,
  // and no other writer stamps this thread, so an absent field means there is nothing to clear. That
  // keeps the extra write off the path almost every flush takes.

  // Coalesce the burst past the watermark and answer once. A thrown error (LLM/Chatwoot) bubbles to
  // the worker → retry with backoff (watermark not advanced, so the retry re-answers the same burst).
  // The error is also surfaced on the conversation (item 6) so the operator can re-engage; a
  // successful answer clears it.
  try {
    // INSIDE the try, so the `finally` below releases the hold no matter how this ends. Sitting
    // above it, a rejection here — a statement timeout on the cleanup write, say — left the hold
    // marked and never released, and every later burst on this graph thread then waited out its
    // five-minute ceiling until the process restarted (round 5 of the review).
    //
    // And best-effort on top of that, so a failed cleanup does not become a failed turn: a stale
    // stamp costs an early ceiling later, which is smaller than refusing to answer the customer.
    // The `.catch` also keeps it out of the turn-failure handler below, whose side effects (the
    // observer hand-over, the conversation error banner) are about a turn that ran, not about this.
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
        tenantId,
        instanceId,
        conversationId,
        threadId,
        agentBotId,
        convDbId: ctx.convDbId,
        loaded: ctx.loaded,
        settings: ctx.settings,
        // The command's fence. Every cancel reaches PENDING rows only, so a flush already CLAIMED
        // when /reset arrived is past all of them — and it is a queued TURN: coalescing the burst
        // and invoking rewrites the very thread the command cleared, with the operator having been
        // told the conversation was started over. The reply is the smaller half; the checkpoint is
        // the one that outlives the command.
        //
        // Handed down rather than asked here, because here is not where the turn writes. Asked at
        // the top it would answer about a moment before the message fetch, the burst selection and
        // the model — all waits the command lands inside — and the run would still recreate the
        // thread. `runLoadedTurn` asks it inside the `ingest:` lock, which is the boundary the
        // divider and the claim are written at, and again before each post.
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
    // NOTHING WAS WRITTEN and the burst is still owed: the turn found the thread occupied by another
    // invoke at the moment it claimed it (issue #593, two replicas flushing the same graph thread).
    // Same treatment as the deferral above, and for the same reason it is not a `fail`: the burst's
    // only problem is that it arrived in the same instant as another one, and the deferral stamp is
    // what keeps the ceiling honest so a thread that stays occupied is answered anyway.
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
    // The turn stood down because the operator silenced it while it ran (issue #209 review,
    // rounds 6 and 9). `coalesceAndRunTurn` left the burst UNMARKED, as it does for a withdrawn
    // one, and the rolled-back turn left it in nobody's memory: an observer's ingestion marks it
    // once it has it; a switched-off agent's burst waits for the switch.
    if (outcome === "agent-unavailable") {
      retryFlushOnFailedHandOver(await handOverIfObserving(), conversationId);
    }
    // A PARTIAL CONFLICT IS THE ONE REFUSAL WITH NOTHING COMING AFTER IT (issue #690, PR review
    // round 4). Every other `superseded` means a newer message arrived and its own flush is armed,
    // which is why this word completes the job. Here the competing claim is for a message this burst
    // shares, and the ones nobody claimed are left with no flush, no watermark move and no schedule:
    // the silence this issue is about, reached through the fix for it.
    //
    // The selection already drops what is spoken for at the moment it reads, so what lands here is a
    // claim taken inside the window between that read and this one. Rescheduled, the next selection
    // reads again, drops the message that was taken, and claims what is still free — one hop, and
    // the deferral stamp keeps the ceiling honest if it somehow is not.
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
    // A turn that THREW after the flip leaves through here (round 13): the burst is the observer's
    // just the same, and marked only once it has it — a retry under production would otherwise
    // answer a burst that was watched. Best-effort, ahead of the rethrow, and its own failure is
    // logged rather than replacing the error being reported.
    try {
      await handOverIfObserving();
    } catch (handErr) {
      logger.warn(
        "debounce flush: hand-over after a failed turn failed too (conv=%s): %s",
        String(conversationId),
        err(handErr),
      );
    }
    // The same ask the clean paths make, on the branch that reaches this write without passing any of
    // them: a throw from the invoke, the TTS call or a Chatwoot send unwinds past every `stillWanted`
    // above and lands here. `lastError`/`lastErrorAt` are state /reset clears, so recording a retired
    // run's failure puts back the failure banner the operator was just told had been cleared — and it
    // is about a turn that will never be retried, because the claim token this run holds was bumped.
    //
    // Asked HERE and not carried down from the fence above: everything between them is I/O, which is
    // exactly the stretch the answer decays over. Unreadable stays "not retired", the same direction
    // `jobRetired` takes everywhere else — an unknown must not swallow a real failure silently.
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
): Promise<JobResult> {
  return flushDebounceJob({ job, base });
}

// The burst is definitively unanswered: the flush exhausted its attempts and the row is DEAD, so no
// retry is coming and the customer is waiting on nobody. This is the only place on this path where
// that can be said — the handler's catch runs on attempt 1 too, and cannot know whether another
// attempt exists (issue #71).
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
