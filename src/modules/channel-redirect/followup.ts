import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import { isRepairableNudgeRefusal, nextNudgeRetry } from "@/graph/nudge-retry";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { isTestSilenced } from "@/modules/agents/test-mode";
import { loadAgentBot, loadChatwootClient } from "@/modules/chatwoot/instance";
import {
  type ObservedConversation,
  recordResolutionOrigin,
} from "@/modules/conversations/record-resolution";
import {
  type ClaimedJob,
  enqueueJob,
  jobRetired,
  jobRetiredStrict,
  retireJobsByDedupeKey,
} from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import {
  buildTemplatePayload,
  type ProactiveSendMode,
  proactiveSendMode,
  readServiceWindowConfig,
} from "@/modules/service-window/service";
import { episodeOriginQuery, episodeTestActivatedAt } from "./episode";
import { interpolateLink, resolveRedirectLink } from "./gate";
import {
  type ChannelRedirectConfig,
  REDIRECT_LINK_TTL_SECONDS,
  type RedirectDelayUnit,
  readChannelRedirectConfig,
  redirectDelayMinutes,
} from "./service";

// Cross-channel follow-up for the WhatsApp→chat redirect (see service.ts's header comment for the
// whole feature): once a lead lands on the widget conversation, a single REDIRECT_FOLLOWUP scheduler
// job chases them across three stages, advancing on the SAME row (mirrors appointments/reminders.ts):
//   1. "chat"     — idle in the widget conversation → a nudge THERE.
//   2. "whatsapp" — still idle → re-send the LINK on the WhatsApp SIBLING conversation as a FIXED
//                   message (waFollowupMessage, NOT AI — the lead may have left the chat, so this pulls
//                   them back); proactiveSendMode applies the 24h window/HSM template on official WhatsApp.
//   3. "closing"  — still idle after the WhatsApp escalation → post the closing message on BOTH channels
//                   (the website chat AND the WhatsApp sibling) and resolve both. A new widget message
//                   re-arms back to stage "chat" (enqueueJob upserts by dedupeKey), so replying in the
//                   chat supersedes a pending escalation/close.
// A closing also fires when the widget conversation is resolved by anyone (the webhook's resolve-
// transition detection) — there only the WhatsApp side is messaged, since the chat is already being
// resolved by the trigger. Both paths funnel through deliverRedirectClosing, which CAS-guards a
// per-conversation watermark (Conversation.redirectClosedAt) so the closing is delivered AT MOST ONCE.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function followUpDedupeKey(widgetThreadId: string): string {
  return `redirect-followup:${widgetThreadId}`;
}

// Retire the ladder armed for a widget thread: the pending row cancelled, and EVERY row of the key
// stamped so an in-flight handler can see it.
//
// `cancelPendingJob` alone is not enough here and the gap is the worst one in the feature: it reaches
// PENDING rows only, so a ladder the worker had already claimed runs to completion — and this
// ladder's terminal stage posts a closing message on BOTH conversations and resolves them. A /reset
// would report the episode cleared and the customer would then be said goodbye to and closed.
//
// The tombstone is the same mechanism appointment reminders use, kept local to this kind rather than
// pushed into cancelPendingJob: that primitive has eight callers across four modules, and each of
// them would need its own handler-side fence to make the change mean anything.
//
// NO arming cutoff here, unlike the appointment reminders: this ladder lives on ONE permanent row
// per widget thread, so "created before the command" is true of every ladder that exists and a
// re-arm does not move it. A cutoff on it would buy nothing and could only fail in the direction
// that leaves a claimed closing running — the one that messages and resolves both conversations.
//
// DONE even for a row the worker is holding, and that pairs with the bump rather than duplicating it.
// Bumping alone leaves a CLAIMED row nobody can finish — the in-flight worker's complete, reschedule
// and fail all CAS on the old token and no-op, while no claim can pick it up again because it is
// still CLAIMED — so it sits wedged until the stale-job sweep records a failure that never happened.
// Terminal here, superseded there: the handler's writes land on nothing and the row is already
// finished.
//
// The claim token is bumped with it, and that is what makes the fence hold at the LAST boundary the
// handler does not own: its return value. `completeJob`/`rescheduleJob`/`failJob` all CAS on the
// token the claim handed out (issue #164), so a stamp landing after the handler's final read still
// wins — the reschedule writes nothing instead of replacing the payload and re-arming the stage the
// stamp was meant to stop. The mechanism already existed for exactly this sentence: "a run that was
// superseded while it worked writes nothing".
//
// A re-arm replaces the payload wholesale (enqueueJob's upsert is authoritative), so a lead who
// replies in the chat clears the stamp along with the rest of the old payload.
export async function retireRedirectFollowUp(
  tenantId: bigint,
  widgetThreadId: string,
  base: PrismaClient = basePrisma,
): Promise<number> {
  return retireJobsByDedupeKey(
    tenantId,
    "REDIRECT_FOLLOWUP",
    followUpDedupeKey(widgetThreadId),
    base,
  );
}

export interface RedirectFollowUpLiveness {
  // Agent.enabled — an operator switched the agent off after the ladder was armed.
  agentEnabled: boolean;
  // Agent.mode + the WIDGET conversation's testActivatedAt: a test agent is silent until /teste.
  agentMode: string;
  testActivatedAt: Date | null;
}

// The ladder's own liveness gate. The generic follow-up cannot cover this path by construction —
// its managedByRedirect term excludes exactly these conversations — and two of the three stages
// send FIXED text (the WhatsApp link re-send, the closing) without ever passing through
// runAgentNudge, where the test-mode gate lives. So the ladder asks here, for EVERY stage.
export function isRedirectFollowUpLive(s: RedirectFollowUpLiveness): boolean {
  return s.agentEnabled && !isTestSilenced(s.agentMode, s.testActivatedAt);
}

export type RedirectFollowUpStage = "chat" | "whatsapp" | "closing";

export interface RedirectFollowUpPayload {
  stage: RedirectFollowUpStage;
  widgetThreadId: string;
  // Agent.id, serialized as a string — scheduler job payloads are plain JSON.
  agentId: string;
  entryInboxId: number | null;
  // The redirect episode this ladder was armed for, as the pairing stood in the EVENT that armed it
  // — not as the row read, which can still be holding the previous pairing back (see the savepoint
  // in chatwoot/mirror.ts). The dedupe key names the conversation and every episode it ever has
  // shares it, so this is the only thing that tells the retirement which ladder is the one it means.
  // Absent ⇒ armed before this field existed, or by a Chatwoot that does not speak about pairings;
  // `null` ⇒ the event stated there is no pairing.
  originDisplayId?: number | null;
}

// Parse (and validate) a claimed job's raw payload. Pure — no I/O — so "is this payload usable" is
// unit-testable without a DB. Returns null on anything malformed.
export function parseRedirectFollowUpPayload(
  payload: Record<string, unknown>,
): RedirectFollowUpPayload | null {
  const stage =
    payload.stage === "whatsapp"
      ? "whatsapp"
      : payload.stage === "closing"
        ? "closing"
        : payload.stage === "chat"
          ? "chat"
          : null;
  const widgetThreadId =
    typeof payload.widgetThreadId === "string" ? payload.widgetThreadId : null;
  const agentId = typeof payload.agentId === "string" ? payload.agentId : null;
  const entryInboxId =
    typeof payload.entryInboxId === "number" ? payload.entryInboxId : null;
  if (!stage || !widgetThreadId || !agentId) return null;
  // Read as three states, and put back the same way: a stage advance rebuilds the payload field by
  // field, so anything this drops is gone from the job for good.
  const origin = payload.originDisplayId;
  return {
    stage,
    widgetThreadId,
    agentId,
    entryInboxId,
    ...(typeof origin === "number"
      ? { originDisplayId: origin }
      : origin === null
        ? { originDisplayId: null }
        : {}),
  };
}

// Pure: the nudge content for each stage, kept separate from I/O so "what do we say" is trivially
// testable. A blank `instructions` yields no operator guidance — renderNudge (in graph/nudge.ts)
// already handles the directive + trigger fields on its own.
export function chatFollowupNudge(instructions: string): AgentNudge {
  return {
    source: "channel-redirect",
    kind: "chat-followup",
    instructions: instructions || undefined,
  };
}

// Pure: `now` + a delay in minutes → the run_at for the next stage. No I/O, `now` injected — mirrors
// computeReminderJobs's discipline in appointments/reminders.ts.
export function minutesFromNow(minutes: number, now: Date): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

export interface ArmRedirectChatFollowUpParams {
  tenantId: bigint;
  instanceId: bigint;
  widgetThreadId: string;
  agentId: bigint;
  entryInboxId: number | null;
  // The episode this message belongs to, taken from the EVENT. Omitted when the payload said
  // nothing about a pairing, which is every Chatwoot without fazer-ai/chatwoot#418.
  originDisplayId?: number | null;
  cfg: {
    chatFollowupEnabled: boolean;
    chatFollowupDelayValue: number;
    chatFollowupDelayUnit: RedirectDelayUnit;
    waFollowupEnabled: boolean;
    closingEnabled: boolean;
  };
  base?: PrismaClient;
  now?: Date;
}

// (Re-)arm the ladder at stage 1 (chat idle) whenever the lead messages the widget conversation this
// agent manages. enqueueJob upserts by dedupeKey — a fresh call always resets run_at AND resets the
// sequence's payload back to stage "chat" (a re-enqueue's payload is authoritative, see enqueueJob's
// doc), so re-arming on every message is ALSO the cancel-on-reply: a pending "whatsapp"/"closing" stage
// from a prior idle period is superseded rather than needing an explicit cancel — this is what stops a
// WhatsApp follow-up / closing from firing while the lead is actively replying in the chat. A no-op when
// EVERY follow-up step is disabled, or the thread doesn't belong to this tenant/instance (defense in
// depth — mirrors threadBelongsToTenant's fence in graph/nudge.ts). `enqueue` is injectable for tests.
export async function armRedirectChatFollowUp(
  p: ArmRedirectChatFollowUpParams,
  enqueue: typeof enqueueJob = enqueueJob,
): Promise<boolean> {
  if (
    !p.cfg.chatFollowupEnabled &&
    !p.cfg.waFollowupEnabled &&
    !p.cfg.closingEnabled
  ) {
    return false;
  }
  const parsed = parseThreadId(p.widgetThreadId);
  if (
    !parsed ||
    parsed.tenantId !== p.tenantId ||
    parsed.instanceId !== p.instanceId
  ) {
    return false;
  }
  const now = p.now ?? new Date();
  await enqueue({
    tenantId: p.tenantId,
    kind: "REDIRECT_FOLLOWUP",
    dedupeKey: followUpDedupeKey(p.widgetThreadId),
    // NOTE: The key is the widget THREAD, reused by every idle period this lead ever has, and this
    // call is what a LEAD MESSAGE triggers: the ladder pending from the previous silence is
    // superseded, and what is being armed is the ladder for the silence starting now. Without the
    // reset, a ladder that dead-lettered once would leave every later idle period on that thread
    // with one attempt.
    rearm: "new-work",
    runAt: minutesFromNow(
      redirectDelayMinutes(
        p.cfg.chatFollowupDelayValue,
        p.cfg.chatFollowupDelayUnit,
      ),
      now,
    ),
    payload: {
      stage: "chat",
      widgetThreadId: p.widgetThreadId,
      agentId: p.agentId.toString(),
      entryInboxId: p.entryInboxId,
      ...(p.originDisplayId !== undefined
        ? { originDisplayId: p.originDisplayId }
        : {}),
    },
    base: p.base,
  });
  return true;
}

interface WhatsAppSibling {
  chatwootConversationId: number;
  // Mirrored status AND its version, read before the closing toggle: see record-resolution.ts
  // rule 2 and the floor in ObservedConversation.
  status: string;
  chatwootStatusAt: number | null;
  chatwootContactId: number;
  lastInboundAt: Date | null;
  channelType: string | null;
  provider: string | null;
}

// Resolve the WhatsApp entry half of a widget conversation's redirect episode. Returns everything the
// proactive WhatsApp touches need — the sibling's conversation id (to post on), the contact's Chatwoot
// id (the token identity), plus the 24h-window inputs (lastInboundAt + inbox channel/provider). Powers
// stage 2 (re-send the link) AND the closing, which RESOLVES the conversation it names.
//
// WHICH row that is comes from episodeOriginQuery: the pairing the fork stored at resolve time, or —
// only when there is none — the most-recently-active predicate this function used to apply on its own.
// #222 is why: the closing acts destructively on the answer, and the old predicate is an inference
// about an event this side never observes.
//
// null when there is no such conversation (never messaged that inbox, or the merge never linked it).
async function resolveWhatsAppSibling(
  tenantId: bigint,
  instanceId: bigint,
  widgetConversationId: number,
  entryInboxId: number,
  base: PrismaClient,
  // The episode to resolve FOR, when the caller is holding one. A closing that has already posted on
  // the chat is committed to an episode: re-reading the pairing at that point lets a re-entry landing
  // during those round trips redirect the WhatsApp half — a clear leaves the original thread open, a
  // move sends the goodbye to (and RESOLVES) the conversation the new episode just paired with. The
  // ladder's own stage-2 send has no such commitment and keeps reading fresh, which is what lets a
  // /reset stand it down.
  pinned?: {
    contactId: bigint | null;
    redirectOriginDisplayId: number | null;
    chatwootRedirectOriginAt: number | null;
  },
): Promise<WhatsAppSibling | null> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const widgetConv =
      pinned ??
      (await db.conversation.findUnique({
        where: {
          tenantId_chatwootInstanceId_chatwootConversationId: {
            tenantId,
            chatwootInstanceId: instanceId,
            chatwootConversationId: widgetConversationId,
          },
        },
        select: {
          contactId: true,
          redirectOriginDisplayId: true,
          chatwootRedirectOriginAt: true,
        },
      }));
    if (!widgetConv) return null;
    const originQuery = episodeOriginQuery({
      tenantId,
      instanceId,
      entryInboxId,
      widget: {
        redirectOriginDisplayId: widgetConv.redirectOriginDisplayId,
        chatwootRedirectOriginAt: widgetConv.chatwootRedirectOriginAt,
        contactId: widgetConv.contactId,
      },
    });
    if (!originQuery) return null;
    const sibling = await db.conversation.findFirst({
      where: originQuery.where,
      ...(originQuery.orderBy ? { orderBy: originQuery.orderBy } : {}),
      select: {
        chatwootConversationId: true,
        status: true,
        chatwootStatusAt: true,
        lastInboundAt: true,
        contact: { select: { chatwootContactId: true } },
        inbox: { select: { channelType: true, provider: true } },
      },
    });
    if (!sibling?.contact?.chatwootContactId) return null;
    return {
      chatwootConversationId: sibling.chatwootConversationId,
      status: sibling.status,
      chatwootStatusAt: sibling.chatwootStatusAt,
      chatwootContactId: sibling.contact.chatwootContactId,
      lastInboundAt: sibling.lastInboundAt,
      channelType: sibling.inbox?.channelType ?? null,
      provider: sibling.inbox?.provider ?? null,
    };
  });
}

export type WhatsAppFollowUpOutcome =
  | "retired"
  // The agent stopped being live while this stage did its own I/O. Distinct from "retired"
  // because the CALLER answers them differently: a retired ladder is gone, a stood-down one must not
  // be advanced to a closing that a re-enabled agent would then deliver (issue #246).
  | "stood-down"
  | "sent"
  | "no-sibling"
  | "misconfigured";

// Whether a stage that is about to say something to the customer may still say it. ONE ask covering
// BOTH reasons it may not — the ladder was retired (/reset, a new inbound), or the agent stopped
// being live — because each ask is a round trip, and a second one placed after the first puts I/O
// between that first answer and the write it guards. THE RULE the file states for the retirement
// question ("one ask per stretch of I/O that precedes a write, and never any I/O between an ask and
// the write it guards") is only satisfiable for both questions if they are one ask.
export type LadderVerdict = "go" | "retired" | "stood-down";

export interface SendWhatsAppFollowUpParams {
  // Asked immediately before the send, after the sibling lookup and the token mint — both of which
  // are round trips a /reset or an operator's switch can land inside. Absent, the answer is "go".
  fence?: () => Promise<LadderVerdict>;
  tenantId: bigint;
  instanceId: bigint;
  agentId: bigint;
  // The widget conversation whose contact's WhatsApp sibling we re-engage.
  widgetConversationId: number;
  entryInboxId: number;
  cfg: ChannelRedirectConfig;
  // agent.settings — for the service-window config (the 24h-window gate).
  settings: unknown;
  base: PrismaClient;
  now: Date;
}

// Stage 2: re-send the redirect LINK on the WhatsApp sibling as a FIXED message (cfg.waFollowupMessage),
// NOT an AI nudge — the lead may have left the chat, so this fixed link is what pulls them back. Re-mints
// the token (a fresh, valid link) and posts via the persona bot, honoring the 24h window on official
// WhatsApp: free-form inside (and on no-window channels like baileys), a template outside if configured,
// else a private note (the lead's next WhatsApp message re-triggers the gate, which re-sends the link).
export async function sendWhatsAppFollowUp(
  p: SendWhatsAppFollowUpParams,
): Promise<WhatsAppFollowUpOutcome> {
  if (p.cfg.widgetInboxId === null) return "misconfigured";
  const sibling = await resolveWhatsAppSibling(
    p.tenantId,
    p.instanceId,
    p.widgetConversationId,
    p.entryInboxId,
    p.base,
  );
  if (!sibling) return "no-sibling";

  const url = await resolveRedirectLink({
    tenantId: p.tenantId,
    instanceId: p.instanceId,
    chatwootContactId: sibling.chatwootContactId,
    widgetInboxId: p.cfg.widgetInboxId,
    // The link is re-sent ON the sibling, so the sibling IS this redirect's origin.
    originDisplayId: sibling.chatwootConversationId,
    openWidget: p.cfg.openWidget,
    ttlSeconds: REDIRECT_LINK_TTL_SECONDS,
    base: p.base,
  });
  if (url === null) return "misconfigured";
  const text = interpolateLink(p.cfg.waFollowupMessage, url);

  const bot = await loadAgentBot(p.tenantId, p.instanceId, p.agentId, p.base);
  const client = await loadChatwootClient(p.tenantId, p.instanceId, {
    base: p.base,
    botToken: bot?.accessToken,
  });
  // NOTE: The link mint above is an HTTP round trip to Chatwoot, so the answer the caller had is older than
  // this line. Nothing has left yet, which makes this the last free place to stop.
  const verdict = p.fence ? await p.fence() : "go";
  if (verdict !== "go") return verdict;
  const sw = readServiceWindowConfig(p.settings);
  const mode = proactiveSendMode(sw, sibling.lastInboundAt, p.now, {
    channelType: sibling.channelType,
    provider: sibling.provider,
  });
  if (mode === "template") {
    const payload = buildTemplatePayload(sw, null);
    if (payload) {
      await client.sendTemplate(sibling.chatwootConversationId, payload);
      return "sent";
    }
    // No template configured → fall through to a private note (never a rejected free-form send).
  }
  await client.sendMessage(sibling.chatwootConversationId, text, {
    private: mode === "note",
  });
  return "sent";
}

export async function redirectFollowUpHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<JobResult> {
  const payload = parseRedirectFollowUpPayload(job.payload);
  if (!payload) return { outcome: "done" };

  // Retired while this row sat claimed? `job.payload` is the claim-time snapshot, which is exactly
  // the moment before the stamp lands, so the row is re-read. Every stage of this ladder is
  // customer-visible and the last one resolves both conversations, so the check goes before all of
  // them — including the reschedule, since advancing a retired ladder just moves the problem.
  //
  // A read that fails does NOT retire the job: an unknown answer must not silently drop work that
  // was legitimately armed.
  // Takes the caller's connection when there is one — see jobRetired: asked from inside the nudge's
  // thread claim, a second connection would stall on the pool while the advisory lock is held.
  // Its own short scope: the nudge's thread claim no longer holds a transaction to borrow one from
  // (issue #225).
  const retired = (): Promise<boolean> => jobRetired(job, base);
  if (await retired()) return { outcome: "done" };
  const parsed = parseThreadId(payload.widgetThreadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return { outcome: "done" };
  const tenantId = job.tenantId;
  let agentId: bigint;
  try {
    agentId = BigInt(payload.agentId);
  } catch {
    return { outcome: "done" };
  }

  // Reload the redirect config FRESH — an operator may have changed or disabled it since this job
  // was armed, and a scheduled delay can span that change. Never trust the arm-time snapshot.
  // The agent's own state travels with the config, for the same reason: a scheduled delay can span
  // an operator switching the agent off, and a test agent whose widget conversation was never
  // activated with /teste must not be chased either.
  const loaded = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { enabled: true, mode: true, settings: true },
    });
    if (!agent) return null;
    const conv = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId,
          chatwootInstanceId: parsed.instanceId,
          chatwootConversationId: parsed.conversationId,
        },
      },
      select: {
        testActivatedAt: true,
        contactId: true,
        inbox: { select: { chatwootInboxId: true } },
      },
    });
    return {
      agent,
      // The EPISODE's activation, not this row's. The ladder is keyed by the widget thread but two of
      // its three stages message the WhatsApp sibling, so a row read on its own answers for a
      // destination whose state it does not hold (issue #249).
      testActivatedAt: await episodeTestActivatedAt({
        tenantId,
        instanceId: parsed.instanceId,
        cfg: readChannelRedirectConfig(agent.settings),
        agentMode: agent.mode,
        conv: {
          testActivatedAt: conv?.testActivatedAt ?? null,
          contactId: conv?.contactId ?? null,
          chatwootInboxId: conv?.inbox?.chatwootInboxId ?? null,
        },
        base,
        scoped: db,
      }),
    };
  });
  if (!loaded) return { outcome: "done" };
  const { agent } = loaded;
  const cfg = readChannelRedirectConfig(agent.settings);
  if (!cfg.enabled) return { outcome: "done" };
  // Dropping the ladder (not rescheduling) matches the !cfg.enabled arm above: a fresh customer
  // message re-arms it from stage "chat" via the dedupeKey upsert.
  if (
    !isRedirectFollowUpLive({
      agentEnabled: agent.enabled,
      agentMode: agent.mode,
      testActivatedAt: loaded.testActivatedAt,
    })
  ) {
    return { outcome: "done" };
  }
  // Both questions, re-asked from inside the stages in ONE round trip, because the answer at
  // the top of this handler is taken before a sibling lookup, a link mint (an HTTP round trip) and a
  // client build — and an operator reaching for the switch is likeliest to do it WHILE the agent is
  // chasing somebody (issue #246). Asking them separately would put one round trip between the other
  // answer and the write it guards, which is THE RULE this file states for the retirement half.
  //
  // Fail OPEN on a read that fails, the same call `jobRetired` makes and for the same reason: an
  // unknown answer must not silently drop work that was legitimately armed. A DELETED agent is an
  // answer, and it is no.
  //
  // The activation stamp is read only for a test agent, so the common path is a single row read after
  // the job row and nothing straddles it. For a test agent the two reads share the transaction but not
  // a snapshot (`runScopedOn` uses the default isolation), which leaves a gap of one statement with no
  // network in it — narrower than the window this whole fence exists to close.
  //
  // Opens its own transaction, always. It used to take the nudge's connection when the nudge had one,
  // because a claim that HELD a transaction across a checkpointer round trip could drain the pool a
  // second connection then had to wait on. That claim holds no transaction any more — the critical
  // section is a process-local queue with short transactions inside it — so there is no caller
  // connection to inherit, and the branch that inherited one was unreachable.
  const fence = async (
    // Which question is being asked, in the sense `runAgentNudge` means it. The default is the one
    // every send-time ask wants: an unreadable answer is "go", because unwinding past a delivered
    // message abandons its watermark and the customer gets it twice. `strict` is the ask that runs
    // BEFORE anything is written — inside the thread's critical section, ahead of the divider and
    // the checkpoint — where guessing recreates the memory /reset just cleared and nothing later
    // catches it. Only the RETIREMENT half changes: liveness stays fail-open in both — including the
    // episode read inside it, which falls back to the row's own (null) answer rather than failing
    // open, because that is the answer this fence gave before that read existed.
    opts: { strict?: boolean } = {},
  ): Promise<LadderVerdict> => {
    const read = async (db: ScopedDb) => {
      // NOTE: The retirement read goes LAST, and that ordering is the whole of what the transaction
      // can offer: the two statements share a connection but not a snapshot (default READ COMMITTED),
      // so whichever is asked last is the one observed closest to the send. Retirement gets it,
      // because that is the position it held before this fence existed — a /reset must not be
      // overtaken by a question added on top of it — and the liveness answer carries the residual,
      // which is one statement wide rather than the round trip this fence exists to close.
      const a = await db.agent.findUnique({
        where: { id: agentId },
        select: { enabled: true, mode: true },
      });
      if (!a) return "stood-down" as const;
      // NOTE: A conclusive answer, taken before the fallible one. The stamp lookup below can throw,
      // and the catch around this whole read turns a failure into "go" — which is right for an answer
      // nobody could read, and wrong for one already in hand.
      if (!a.enabled) return "stood-down" as const;
      // NOTE: Retirement is answered BEFORE the fallible read, not after it, and that ordering is
      // what a `catch` alone cannot buy: a query PostgreSQL rejects leaves the transaction aborted,
      // so every later statement in it fails too — the retirement read included, and the outer catch
      // would then answer "go" on a ladder a /reset had already retired. Taken first, that answer is
      // already in hand when the stamp read can go wrong.
      //
      // The cost is that for a TEST agent the retirement answer is one statement older than the send
      // instead of the last thing read. For every other agent nothing moves: the stamp is not read at
      // all, so retirement stays last.
      if (
        await (opts.strict
          ? jobRetiredStrict(job, base, db)
          : jobRetired(job, base, db))
      )
        return "retired" as const;
      if (a.mode !== "test") return "go" as const;
      // NOTE: The stamp lookup fails open ON ITS OWN: unknown liveness is live, and the answer that
      // matters more — retirement — is already decided above.
      try {
        const c = await db.conversation.findUnique({
          where: {
            tenantId_chatwootInstanceId_chatwootConversationId: {
              tenantId,
              chatwootInstanceId: parsed.instanceId,
              chatwootConversationId: parsed.conversationId,
            },
          },
          select: {
            testActivatedAt: true,
            contactId: true,
            inbox: { select: { chatwootInboxId: true } },
          },
        });
        return isRedirectFollowUpLive({
          agentEnabled: a.enabled,
          agentMode: a.mode,
          // The episode's answer, on this same connection. A sibling read that fails returns this
          // row's own answer — which, to have got here, is null — so the worst a failure can do is
          // reproduce the behaviour this call replaced. It can lose the fix, never invent a refusal.
          testActivatedAt: await episodeTestActivatedAt({
            tenantId,
            instanceId: parsed.instanceId,
            cfg,
            agentMode: a.mode,
            conv: {
              testActivatedAt: c?.testActivatedAt ?? null,
              contactId: c?.contactId ?? null,
              chatwootInboxId: c?.inbox?.chatwootInboxId ?? null,
            },
            base,
            scoped: db,
          }),
        })
          ? ("go" as const)
          : ("stood-down" as const);
      } catch (err) {
        logger.warn(
          "channel-redirect: could not read the activation stamp (widget thread=%s): %s",
          payload.widgetThreadId,
          err instanceof Error ? err.message : String(err),
        );
        return "go" as const;
      }
    };
    const answer = await runScopedOn(base, sysCtx(tenantId), read).catch(
      async (err: unknown) => {
        // The strict ask does not get an answer it could not read. Its caller is about to write, so
        // "go" here is the guess this whole distinction exists to refuse: the scheduler's own bounded
        // retry carries the job instead.
        if (opts.strict) throw err;
        logger.warn(
          "channel-redirect: could not re-read the ladder's fence (widget thread=%s): %s",
          payload.widgetThreadId,
          err instanceof Error ? err.message : String(err),
        );
        // NOTE: The liveness half is unknown here, and unknown is live. Retirement is not allowed to be
        // unknown by association: a statement the server rejects leaves the transaction aborted, so it
        // cannot be asked in THAT one — it gets a fresh one. A /reset is the strongest fence in this
        // file and it must not be overtaken by a question that was added on top of it.
        const stillRetired = await jobRetired(job, base).catch(() => false);
        return stillRetired ? ("retired" as const) : ("go" as const);
      },
    );
    return answer;
  };
  const entryInboxId = cfg.entryInboxId ?? payload.entryInboxId;

  // Reschedule this same job to the next stage after its configured delay. The payload is authoritative
  // on re-enqueue, so this advances the ladder on the SAME row (mirrors the two-stage original).
  // Advancing the ladder REPLACES the row's payload (enqueueJob's upsert is authoritative), which
  // would wipe the very stamp that retires it — a /reset landing mid-stage would be undone by the
  // stage it interrupted, and the ladder would go on to its closing. So the question is asked once
  // more here: a retired ladder ends, it does not advance.
  const rescheduleTo = async (
    stage: RedirectFollowUpStage,
    value: number,
    unit: RedirectDelayUnit,
  ): Promise<JobResult> =>
    (await fence()) !== "go"
      ? { outcome: "done" }
      : {
          outcome: "reschedule",
          runAt: minutesFromNow(redirectDelayMinutes(value, unit), new Date()),
          payload: {
            stage,
            widgetThreadId: payload.widgetThreadId,
            agentId: payload.agentId,
            entryInboxId,
            ...(payload.originDisplayId !== undefined
              ? { originDisplayId: payload.originDisplayId }
              : {}),
          },
        };

  if (payload.stage === "chat") {
    if (cfg.chatFollowupEnabled) {
      const outcome = await runAgentNudge({
        tenantId,
        threadId: payload.widgetThreadId,
        nudge: chatFollowupNudge(cfg.chatFollowupInstructions),
        base,
        // NOTE: The composite fence. This stage's window is the widest
        // in the ladder — the config load is fail-closed on `enabled`, but the model turn runs after
        // it and the post comes after that — so a switch flipped mid-turn would otherwise reach the
        // customer from an agent that is already off.
        //
        // A stand-down here suppresses the send and leaves the generated turn in the thread's
        // history, because the graph has already checkpointed it by the time any post-invoke gate
        // answers. That is `runAgentNudge`'s shared behaviour — the ownership re-probe and a /reset
        // land the same way — and it is #251, not this fence's to change.
        //
        // The verdict is not carried out to the advance below, deliberately. `rescheduleTo` asks the
        // fence again, so an agent still off there ends the ladder anyway; what is left uncovered is
        // an operator switching OFF during the turn and back ON inside the milliseconds before that
        // ask, and an agent that is live again by then has a defensible claim to the next stage.
        stillWanted: async ({ strict }) => (await fence({ strict })) === "go",
        deps,
      });
      // NOTE: This stage is the only one of the three that needs an agent to author anything, so it is
      // the only one that can lose its turn to a refusal. Retry the SAME stage rather than advancing:
      // the ladder's stages are an escalation, and spending the softest one on a message nobody
      // received puts the lead one step closer to the closing for no reason.
      //
      // Asked through the same fence as `rescheduleTo`, which is what keeps this from re-deciding
      // #219: an agent switched off is one of the states behind `agent-unavailable`, and the fence
      // answers that one by ending the ladder instead of waiting for it to come back.
      //
      // On exhaustion, fall through to the advance below on purpose: the `whatsapp` and `closing`
      // stages send fixed text with no model in the path, so a ladder that cannot author is still a
      // ladder that can escalate.
      if (isRepairableNudgeRefusal(outcome)) {
        const retry = nextNudgeRetry(job.payload);
        if (retry.retry) {
          return (await fence()) !== "go"
            ? { outcome: "done" }
            : {
                outcome: "reschedule",
                runAt: retry.runAt,
                payload: {
                  stage: "chat",
                  widgetThreadId: payload.widgetThreadId,
                  agentId: payload.agentId,
                  entryInboxId,
                  nudgeRetries: retry.attempt,
                  ...(payload.originDisplayId !== undefined
                    ? { originDisplayId: payload.originDisplayId }
                    : {}),
                },
              };
        }
        logger.warn(
          "redirectFollowUp: chat stage giving up after %d %s retries (thread=%s), escalating without it",
          retry.attempt,
          outcome,
          payload.widgetThreadId,
        );
      }
    }
    if (cfg.waFollowupEnabled) {
      return await rescheduleTo(
        "whatsapp",
        cfg.waFollowupDelayValue,
        cfg.waFollowupDelayUnit,
      );
    }
    if (cfg.closingEnabled) {
      return await rescheduleTo(
        "closing",
        cfg.closingDelayValue,
        cfg.closingDelayUnit,
      );
    }
    return { outcome: "done" };
  }

  if (payload.stage === "whatsapp") {
    // NOTE: The two stages below send FIXED text rather than a nudge, so `stillWanted` never reaches them:
    // the question is asked here instead, immediately before the send. Both cross channels — this one
    // messages the WhatsApp sibling, the closing messages and RESOLVES both — so a stamp that landed
    // while the config and the sibling were being resolved has to be seen.
    if (await retired()) return { outcome: "done" };
    if (cfg.waFollowupEnabled && entryInboxId !== null) {
      const outcome = await sendWhatsAppFollowUp({
        fence,
        tenantId,
        instanceId: parsed.instanceId,
        agentId,
        widgetConversationId: parsed.conversationId,
        entryInboxId,
        cfg,
        settings: agent.settings,
        base,
        now: new Date(),
      });
      if (outcome !== "sent") {
        logger.info(
          "channel-redirect: WhatsApp follow-up %s (widget thread=%s)",
          outcome,
          payload.widgetThreadId,
        );
      }
      // The ladder ENDS on a stand-down instead of advancing. Arming the closing here would leave it
      // pointed at an episode nobody is chasing any more: re-enable the agent before that delay
      // expires and the closing messages and resolves BOTH conversations, with no fresh inbound
      // behind it. A customer message re-arms the ladder from stage "chat" the normal way.
      if (outcome === "stood-down") return { outcome: "done" };
    }
    if (cfg.closingEnabled) {
      return await rescheduleTo(
        "closing",
        cfg.closingDelayValue,
        cfg.closingDelayUnit,
      );
    }
    return { outcome: "done" };
  }

  // stage === "closing" — the ladder's terminal give-up: post the closing on BOTH channels + resolve, once.
  if (await retired()) return { outcome: "done" };
  if (cfg.closingEnabled && entryInboxId !== null) {
    await deliverRedirectClosing({
      stillWanted: async () => !(await retired()),
      fence,
      tenantId,
      instanceId: parsed.instanceId,
      widgetConversationId: parsed.conversationId,
      entryInboxId,
      closingMessage: cfg.closingMessage,
      closeChat: true,
      base,
      deps,
    });
  }
  return { outcome: "done" };
}

let registered = false;
export function registerRedirectFollowUpHandlers(): void {
  if (registered) return;
  registerJobHandler("REDIRECT_FOLLOWUP", (job, base) =>
    redirectFollowUpHandler(job, base),
  );
  registered = true;
  logger.debug("channel-redirect follow-up handler registered");
}

// Post the fixed closing message on ONE conversation + resolve it. deliverRedirectClosing calls it once
// per channel (chat + WhatsApp) with a single shared bot client. sendMode gates visibility: freeform
// (in-window, or the web widget, which has no window) → a customer-visible goodbye; template/note
// (official WhatsApp outside the 24h window, where free-form is blocked) → a private note (a goodbye is
// best-effort, never worth burning an HSM template on).
async function deliverClosing(
  client: Awaited<ReturnType<typeof loadChatwootClient>>,
  conversationId: number,
  closingMessage: string,
  sendMode: ProactiveSendMode,
  origin: {
    tenantId: bigint;
    instanceId: bigint;
    base: PrismaClient;
    // The conversation as the caller loaded it, before this function's own toggle.
    observed: ObservedConversation;
  },
): Promise<void> {
  await client.sendMessage(conversationId, closingMessage, {
    private: sendMode !== "freeform",
  });
  await client.toggleStatus(conversationId, "resolved");
  // NOTE: Tidying up the channel the episode moved AWAY from. Whatever the outcome was, it was not decided
  // here, so this closing is not a resolution the agent can be credited with.
  await recordResolutionOrigin({
    tenantId: origin.tenantId,
    conversation: {
      chatwootInstanceId: origin.instanceId,
      chatwootConversationId: conversationId,
    },
    origin: "redirect_closing",
    observed: origin.observed,
    base: origin.base,
  });
}

export interface DeliverRedirectClosingParams {
  // Asked twice inside: before the watermark is claimed (a retired ladder must not burn the
  // at-most-once anchor) and again before the sends, after the reads and the client build. Absent,
  // the answer is yes — the resolve-transition caller has no job to retire.
  stillWanted?: () => Promise<boolean>;
  // The post-claim asks, covering retirement AND the agent's switch in one round trip (issue #246).
  // `stillWanted` stays for the pre-claim ask because its PRESENCE is also a signal — it means the
  // caller holds a job token, which the /reset rule below reads — and the resolve-transition caller
  // has no job while still needing the liveness half. Absent, the answer is "go".
  fence?: () => Promise<LadderVerdict>;
  tenantId: bigint;
  instanceId: bigint;
  // The WIDGET conversation's chatwootConversationId. The closing watermark lives on this row; the agent
  // (bot token), the service-window config + the chat channel are all derived from it.
  widgetConversationId: number;
  // The agent's configured entry (official WhatsApp) inbox — used to find the sibling to close.
  entryInboxId: number;
  // The fixed goodbye, posted verbatim on BOTH channels (not AI: the WhatsApp closing nudge silences).
  closingMessage: string;
  // Post + resolve the CHAT (widget) conversation too. true from the timed ladder's closing stage (the
  // goodbye goes out on both channels). false from the webhook's resolve-transition, where the chat is
  // already being resolved by the trigger — only the WhatsApp sibling still needs the closing.
  closeChat: boolean;
  base?: PrismaClient;
  deps?: RuntimeDeps;
}

export type DeliverRedirectClosingOutcome =
  | "delivered"
  | "already-closed"
  // The agent stopped being live while this run did its reads. Told apart from "already-closed" so
  // the log line names the switch rather than a race that did not happen (issue #246).
  | "stood-down";

// The single closing entry point, shared by the ladder's terminal "closing" stage and the webhook's
// widget-resolve detection. The closing is a FIXED message posted on BOTH channels — the website chat and
// the WhatsApp sibling — each followed by a resolve, via the agent's persona bot. A CAS on
// Conversation.redirectClosedAt makes it AT MOST ONCE per episode: whichever trigger fires first wins the
// watermark and delivers; a later/concurrent trigger (including the resolve webhook re-entered by our own
// chat resolve) sees it set and no-ops.
export async function deliverRedirectClosing(
  p: DeliverRedirectClosingParams,
): Promise<DeliverRedirectClosingOutcome> {
  const base = p.base ?? basePrisma;
  const now = new Date();

  // Everything the sends need — the agent (bot token), the widget conv's channel + lastInboundAt, and the
  // service-window config — derived from the widget conversation. Both channels post via THIS agent's bot.
  const cx = await runScopedOn(base, sysCtx(p.tenantId), async (db) => {
    const widget = await db.conversation.findUnique({
      where: {
        tenantId_chatwootInstanceId_chatwootConversationId: {
          tenantId: p.tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.widgetConversationId,
        },
      },
      select: {
        status: true,
        chatwootStatusAt: true,
        lastInboundAt: true,
        contactId: true,
        redirectOriginDisplayId: true,
        chatwootRedirectOriginAt: true,
        inbox: { select: { agentId: true, channelType: true, provider: true } },
      },
    });
    if (!widget?.inbox?.agentId) return null;
    const agent = await db.agent.findUnique({
      where: { id: widget.inbox.agentId },
      select: { settings: true },
    });
    return { widget, agentId: widget.inbox.agentId, settings: agent?.settings };
  });
  // NOTE: No agent bound to the widget inbox (shouldn't happen once redirect is live): nothing to post, and
  // now nothing claimed either — the anchor stays free for a trigger that CAN deliver.
  if (!cx) return "delivered";

  const bot = await loadAgentBot(p.tenantId, p.instanceId, cx.agentId, base);
  const client = await loadChatwootClient(p.tenantId, p.instanceId, {
    base,
    botToken: bot?.accessToken,
    makeClient: p.deps?.makeClient,
  });
  const sw = readServiceWindowConfig(cx.settings);

  // ONE ask per fence site, and the fence is the composite one when the caller has it: asking
  // the two questions separately would put a round trip between the first answer and the write it
  // guards, which is the rule stated below. A caller that passes only `stillWanted` — no agent to ask
  // about, or a direct call — keeps every fence it always had, answered by the retirement half alone.
  const ask = async (): Promise<LadderVerdict> => {
    if (p.fence) return p.fence();
    if (p.stillWanted && !(await p.stillWanted())) return "retired";
    return "go";
  };

  // NOTE: The retirement fence and the CLAIM sit together, here rather than at the top, and the ordering is
  // the point: everything above is a read, and claiming before them meant a ladder retired mid-read
  // burned the at-most-once anchor on a closing it then refused to deliver — leaving a funnel that
  // could never close again. Claiming last costs a loser of the race a few reads it will discard,
  // which is the cheaper side of the trade.
  const beforeClaim = await ask();
  if (beforeClaim !== "go") {
    return beforeClaim === "retired" ? "already-closed" : "stood-down";
  }

  // What the resolve trigger has instead of a job to ask about — and the reason it needs anything at
  // all. `redirectClosedAt: null` cannot tell "never closed" from "was closed and /reset just cleared
  // it": the values are identical, so on its own the CAS is not a fence against the command, it is a
  // door the command OPENS. Something read BEFORE the command has to be compared after it.
  //
  // `lastInboundAt` is that something, when it is set: same snapshot above, cleared by the same reset
  // in the same statement, and already read to pick the send mode, so comparing it costs no new
  // state. A genuine new inbound moves it too, and standing down there is correct rather than
  // collateral — the trigger was a RESOLVE, and a customer who has written since is on a conversation
  // that reopened.
  //
  // Null is the case that comparison cannot cover, because /reset writes null as well and the
  // predicate would match straight across the command it is fencing. There is no other column here
  // that necessarily changes: every one the command touches goes TO null or to zero, so any of them
  // can be null on both sides. So a caller with no job and no token does not get to claim — it is the
  // one combination where nothing distinguishes the episode it read from the one after the reset, and
  // the write it is holding is a goodbye to a customer. The ladder path is unaffected: its `stillWanted`
  // IS the token, and it is armed by an inbound, so this watermark is set whenever it runs.
  if (!p.stillWanted && cx.widget.lastInboundAt === null) {
    logger.info(
      "channel-redirect: closing stood down — no job to ask and no episode token to compare (widget conv=%d)",
      p.widgetConversationId,
    );
    return "already-closed";
  }

  // Claim the closing: set the watermark only if still unset AND the episode is the one this run read.
  //
  // `redirectOriginDisplayId` is the third condition, and the one this path has nothing else to put
  // in its place. The closing RESOLVES the WhatsApp conversation the pairing names; the resolve
  // trigger reaches here straight from a webhook, with no job to ask about, so every fence the ladder
  // gets from `stillWanted` is one this caller skips. Between the read at the top and this write sit
  // an agent read, a bot load and a client build — a re-entry accepted in that window re-points the
  // episode, and a goodbye sent afterwards resolves a thread this conversation is no longer paired
  // with. Losing the claim leaves the anchor free, so the episode that IS current still gets its own.
  //
  // Null is a value here, not a wildcard: a widget conversation with no stored pairing (every one of
  // them, until fazer-ai/chatwoot#418 is deployed) matches only while it still has none, so the
  // arrival of a first pairing stands this run down rather than letting it act on the recency
  // fallback it read.
  //
  // And the mark comes in ONLY where the origin cannot answer, which is when the origin is null.
  // `(null, null)` is nobody ever told us and licenses the recency fallback this run may have used;
  // `(null, set)` is the fork saying this episode has no WhatsApp half. A clear landing between the
  // read and this write turns the first into the second without changing the origin.
  //
  // Its NULLNESS, never its value. The mark is a version: it advances on every payload that states
  // the pairing, the ones that state the SAME pairing included. Compared for equality it turns any
  // ordinary webhook arriving mid-run into "the episode moved", and on this path that is permanent —
  // the ladder is cancelled by the time the resolve trigger runs, so this is the only closing the
  // episode will ever get. The identity is the origin; the mark only tells two nulls apart.
  const won = await runScopedOn(base, sysCtx(p.tenantId), async (db) => {
    const res = await db.conversation.updateMany({
      where: {
        tenantId: p.tenantId,
        chatwootInstanceId: p.instanceId,
        chatwootConversationId: p.widgetConversationId,
        redirectClosedAt: null,
        lastInboundAt: cx.widget.lastInboundAt,
        redirectOriginDisplayId: cx.widget.redirectOriginDisplayId,
        ...(cx.widget.redirectOriginDisplayId === null
          ? {
              chatwootRedirectOriginAt:
                cx.widget.chatwootRedirectOriginAt === null
                  ? null
                  : { not: null },
            }
          : {}),
      },
      data: { redirectClosedAt: now },
    });
    return res.count === 1;
  });
  if (!won) return "already-closed";

  // NOTE: Asked once more, because the claim is a write and the answer above it predates it. Nothing
  // has reached anybody yet, so this is the last point where the episode can still end without a
  // goodbye — and the anchor goes back with it, since an anchor set on a closing nobody delivered is
  // a funnel that can never close again.
  //
  // The release is CAS'd on the exact instant this claim wrote, so it cannot clear an anchor another
  // trigger won afterwards. A release that fails leaves the anchor set, which is precisely what not
  // releasing at all would do — it can only improve on doing nothing.
  //
  // Deliberately NOT asked again between the two channel deliveries below: once the first goodbye
  // has left, the closing has happened, and stopping halfway leaves the episode half-closed rather
  // than clean.
  const releaseClaim = async (): Promise<void> => {
    await runScopedOn(base, sysCtx(p.tenantId), (db) =>
      db.conversation.updateMany({
        where: {
          tenantId: p.tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.widgetConversationId,
          redirectClosedAt: now,
        },
        data: { redirectClosedAt: null },
      }),
    ).catch((err) => {
      logger.warn(
        "channel-redirect: could not release the closing watermark (widget conv=%d): %s",
        p.widgetConversationId,
        err instanceof Error ? err.message : String(err),
      );
    });
  };
  const afterClaim = await ask();
  if (afterClaim !== "go") {
    await releaseClaim();
    return afterClaim === "retired" ? "already-closed" : "stood-down";
  }

  // And the fence for the caller that has no job to ask about. The resolve trigger reaches here
  // straight from a webhook, so `stillWanted` is undefined for it and every check above is one this
  // path skips — while /reset CLEARS this very anchor, deliberately, so the funnel can be tested
  // again. The two together let a closing that claimed before the command send its goodbye and
  // resolve the sibling after the reset had finished, on an episode the operator was told was erased.
  //
  // The claim is the token, and this re-reads it the way a claimed job re-reads `claim_seq`: the
  // anchor still holding the exact instant written above means nobody took it. Cleared, or won by
  // someone else, means this run is not the one delivering. No release here — the anchor is already
  // not ours to give back.
  //
  // A closure and not a single check, because this function delivers TWICE and the two are separated
  // by a lookup: asked once at the top it would answer about a moment before the sibling read, which
  // is the same mistake the anchors made. One ask per stretch of I/O that precedes a send.
  const stillDelivering = async (): Promise<boolean> => {
    const held = await runScopedOn(base, sysCtx(p.tenantId), (db) =>
      db.conversation.count({
        where: {
          tenantId: p.tenantId,
          chatwootInstanceId: p.instanceId,
          chatwootConversationId: p.widgetConversationId,
          redirectClosedAt: now,
        },
      }),
    ).catch(() => 1);
    if (held === 1) return true;
    logger.info(
      "channel-redirect: the closing claim was taken while this run read (widget conv=%d)",
      p.widgetConversationId,
    );
    return false;
  };
  if (!(await stillDelivering())) return "already-closed";

  // AND THE JOB, ASKED AGAIN AND ASKED LAST. The ask above answered about a moment before the claim
  // read, and that read is a database round trip — which is exactly the gap THE RULE names (one ask
  // per stretch of I/O that precedes a write, and never any I/O between an ask and the write it
  // guards). A /reset landing in it retires this job while the claim check, which asks about the
  // ANCHOR and not about the job, still says the run is the one delivering: the goodbye then goes
  // out and both conversations are resolved, on an episode the operator was told had been erased.
  //
  // The claim question cannot also be last, and this is the honest ordering rather than a complete
  // one: what stays open is a concurrent closing run taking the anchor inside this final round trip,
  // which the claim CAS already makes rare and which costs a duplicate goodbye. What closes is the
  // reset, which is what this whole change is about and which costs the operator a conversation they
  // were told was clean.
  const beforeSends = await ask();
  if (beforeSends !== "go") {
    await releaseClaim();
    return beforeSends === "retired" ? "already-closed" : "stood-down";
  }

  // Chat (website widget): post the goodbye + resolve. Skipped on the resolve-path, where the chat is
  // already being resolved by the trigger. A web widget has no 24h window → proactiveSendMode → freeform.
  if (p.closeChat) {
    const chatMode = proactiveSendMode(sw, cx.widget.lastInboundAt, now, {
      channelType: cx.widget.inbox?.channelType ?? null,
      provider: cx.widget.inbox?.provider ?? null,
    });
    await deliverClosing(
      client,
      p.widgetConversationId,
      p.closingMessage,
      chatMode,

      {
        tenantId: p.tenantId,
        instanceId: p.instanceId,
        base,
        observed: {
          status: cx.widget.status,
          statusAt: cx.widget.chatwootStatusAt,
        },
      },
    );
  }

  // WhatsApp channel: the sibling conversation (same contact, the entry inbox). Post the goodbye + resolve.
  //
  // The lookup below is a read of its own, and it is the read /reset invalidates: the command clears
  // the identity it consults. Between it returning a sibling and the send there is nothing else, but
  // between the ask above and it there is now the chat delivery AND the lookup — so the answer is
  // taken again below, right before the send.
  const sibling = await resolveWhatsAppSibling(
    p.tenantId,
    p.instanceId,
    p.widgetConversationId,
    p.entryInboxId,
    base,
    // The episode this run CLAIMED, not whatever the row says now. By here the chat half may already
    // have had its goodbye and its resolve, so this run is committed to an episode; a re-entry
    // landing during those round trips must not move the conversation the WhatsApp half closes.
    {
      contactId: cx.widget.contactId,
      redirectOriginDisplayId: cx.widget.redirectOriginDisplayId,
      chatwootRedirectOriginAt: cx.widget.chatwootRedirectOriginAt,
    },
  );
  // NOTE: ONE watermark read and ONE fence, in that order, and nothing between the fence and the
  // send. Asking the watermark again after the fence — which is what a second `stillDelivering()`
  // here would be — puts a round trip behind the fence's answer and hands the last word back to the
  // question that was not supposed to have it.
  //
  // Both asks are skipped once the chat has ALREADY been messaged and resolved. Standing down there
  // would leave the episode half-closed — the widget said goodbye and is resolved, the WhatsApp side
  // still open — and report `delivered` for it. Nothing can un-send the first half, so the honest
  // completion of a started delivery is both halves; the asks are what stop one that has not started.
  //
  // Which of the two gets that word is a real choice: a stale watermark costs a duplicate goodbye in
  // a race the claim CAS already makes rare, while a stale fence costs a message from an agent the
  // operator switched off, which is what this fence exists to prevent.
  //
  // The stand-down releases the claim; the watermark refusal does not, and that asymmetry is the
  // point — a claim lost to another run is not ours to give back, while a stand-down leaves this run
  // holding one over a goodbye nobody delivered.
  let deliverToSibling = Boolean(sibling) && p.closeChat;
  if (sibling && !p.closeChat && (await stillDelivering())) {
    const beforeSibling = await ask();
    if (beforeSibling !== "go") {
      await releaseClaim();
      return beforeSibling === "retired" ? "already-closed" : "stood-down";
    }
    deliverToSibling = true;
  }
  if (sibling && deliverToSibling) {
    const waMode = proactiveSendMode(sw, sibling.lastInboundAt, now, {
      channelType: sibling.channelType,
      provider: sibling.provider,
    });
    await deliverClosing(
      client,
      sibling.chatwootConversationId,
      p.closingMessage,
      waMode,

      {
        tenantId: p.tenantId,
        instanceId: p.instanceId,
        base,
        observed: {
          status: sibling.status,
          statusAt: sibling.chatwootStatusAt,
        },
      },
    );
  }
  return "delivered";
}
