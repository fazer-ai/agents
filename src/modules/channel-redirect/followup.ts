import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import {
  isRepairableNudgeRefusal,
  nextNudgeRetry,
  nudgeReachedConversation,
} from "@/graph/nudge-retry";
import type { RuntimeDeps } from "@/graph/runtime";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { isMonitoring } from "@/modules/agents/mode";
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
import {
  type JobContext,
  type JobResult,
  registerJobHandler,
} from "@/modules/scheduler/worker";
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

// Cross-channel follow-up for the WhatsApp to chat redirect: one REDIRECT_FOLLOWUP job per widget
// thread advances on the SAME row through "chat" (a nudge there), "whatsapp" (a FIXED link message on
// the sibling, 24h window applied) and "closing" (closing message on both, both resolved). A widget
// message re-arms it to "chat". Resolving the widget also closes the WhatsApp side; both paths go
// through deliverRedirectClosing, whose `redirectClosedAt` CAS delivers the closing AT MOST ONCE.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

export function followUpDedupeKey(widgetThreadId: string): string {
  return `redirect-followup:${widgetThreadId}`;
}

// Retire the ladder armed for a widget thread: the row set DONE (claimed included), EVERY row of the
// key stamped, and the claim token bumped. A claimed ladder must not run on to its closing stage,
// which messages and resolves both conversations after a /reset said the episode was cleared. DONE
// keeps a claimed row from wedging, and the bumped token makes the handler's final complete or
// reschedule write nothing. A re-arm replaces the payload wholesale, clearing the stamp.

// No arming cutoff, unlike the appointment reminders: the ladder lives on ONE permanent row per
// widget thread, so "created before the command" is true of every ladder that exists. The tombstone
// stays local to this kind rather than going into `cancelPendingJob`, which has eight callers across
// four modules that would each need their own handler-side fence.
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
  // The ladder sends templates and closing messages without ever loading the agent's config, so the
  // monitoring refusal `loadAgentConfig` makes for every other speaker has to be made here too.
  return (
    s.agentEnabled &&
    !isMonitoring(s.agentMode) &&
    !isTestSilenced(s.agentMode, s.testActivatedAt)
  );
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
  // Absent ⇒ armed by a build without this field, or by a Chatwoot that does not speak about
  // pairings; `null` ⇒ the event stated there is no pairing.
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
export function chatFollowupNudge(
  instructions: string,
  // WHICH REDIRECT EPISODE this ladder is running for. Nothing else in this descriptor separates two
  // of them: there is one stage that nudges, no step and no refs, so a second episode on the same
  // widget conversation would describe itself exactly like the first and lose its spend-ceiling row
  // and alert to the first's window. `originDisplayId` is already the field that tells the
  // retirement which ladder it means (see RedirectFollowUpPayload), so it is the episode's name
  // here too; absent or null is the ladder armed before that field existed, which is one episode.
  originDisplayId?: number | null,
): AgentNudge {
  return {
    source: "channel-redirect",
    kind: "chat-followup",
    instructions: instructions || undefined,
    occasionId: `episode:${originDisplayId ?? "none"}`,
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
  // nothing about a pairing, which is every Chatwoot whose fork does not send the origin.
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

// Resolve the WhatsApp entry half of a widget conversation's redirect episode: the conversation id to
// post on, the contact's Chatwoot id, and the 24h-window inputs. Powers stage 2 AND the closing,
// which RESOLVES the conversation it names; which row that is comes from episodeOriginQuery.
// null when there is no such conversation (never messaged that inbox, or the merge never linked it).
async function resolveWhatsAppSibling(
  tenantId: bigint,
  instanceId: bigint,
  widgetConversationId: number,
  entryInboxId: number,
  base: PrismaClient,
  // The episode to resolve FOR, when the caller is holding one: a closing that already posted on the
  // chat is committed, and a fresh read would let a re-entry redirect its goodbye. Stage 2 has no such
  // commitment and reads fresh, which is what lets a /reset stand it down.
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
  // be advanced to a closing that a re-enabled agent would then deliver.
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
  // The run's context: its signal goes to the chat stage's nudge, and a nudge that reached the
  // conversation commits it.
  ctx?: JobContext,
): Promise<JobResult> {
  const payload = parseRedirectFollowUpPayload(job.payload);
  if (!payload) return { outcome: "done" };

  // NOTE: Retired while this row sat claimed? The row is re-read (the payload is the claim-time
  // snapshot), before every stage and the reschedule. A read that fails does NOT retire the job.
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
      // NOTE: The EPISODE's activation, not this row's: two of the three stages message the WhatsApp
      // sibling, whose state this row does not hold.
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
  // NOTE: Retirement AND the agent's switch, re-asked from inside the stages in ONE round trip, so no
  // I/O sits between either answer and the write it guards. Fails OPEN on a read that fails; a
  // DELETED agent is an answer, and it is no. The activation stamp is read only for a test agent,
  // and its two reads share no snapshot: a gap of one statement, with no network in it.
  const fence = async (
    // Which question is being asked, in the sense `runAgentNudge` means it. The default is the one
    // every send-time ask wants: an unreadable answer is "go", because unwinding past a delivered
    // message abandons its watermark and the customer gets it twice. `strict` is the ask that runs
    // BEFORE anything is written — inside the thread's critical section, ahead of the divider and
    // the checkpoint — where guessing recreates the memory /reset just cleared and nothing later
    // catches it. Only the RETIREMENT half changes: liveness stays fail-open in both — including the
    // episode read inside it, which falls back to the row's own (null) answer rather than failing
    // open, so a failed read costs the episode's answer and never invents one.
    opts: { strict?: boolean } = {},
  ): Promise<LadderVerdict> => {
    const read = async (db: ScopedDb) => {
      // NOTE: The retirement read goes LAST, and that ordering is the whole of what the transaction
      // can offer: the two statements share a connection but not a snapshot (default READ COMMITTED),
      // so whichever is asked last is the one observed closest to the send. Retirement gets it, so a
      // /reset is never overtaken; the liveness answer carries a residual one statement wide.
      const a = await db.agent.findUnique({
        where: { id: agentId },
        select: { enabled: true, mode: true },
      });
      if (!a) return "stood-down" as const;
      // NOTE: A conclusive answer, taken before the fallible one. The stamp lookup below can throw,
      // and the catch around this whole read turns a failure into "go" — which is right for an answer
      // nobody could read, and wrong for one already in hand.
      if (!a.enabled) return "stood-down" as const;
      // NOTE: Retirement is answered BEFORE the fallible read: a statement PostgreSQL rejects aborts
      // the transaction, so a retirement read after it would fail too and the outer catch would
      // answer "go" on a ladder a /reset had retired.
      if (
        await (opts.strict
          ? jobRetiredStrict(job, base, db)
          : jobRetired(job, base, db))
      )
        return "retired" as const;
      // NOTE: A monitoring agent stands down at send time too: the liveness read at claim
      // time is minutes old by now, and an operator flipping the mode inside that window must not
      // see one more template go out.
      if (isMonitoring(a.mode)) return "stood-down" as const;
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
          // NOTE: the episode's answer, on this same connection. A sibling read that fails returns
          // this row's own answer (null, to have got here), so a failure can lose the episode's
          // answer, never invent a refusal.
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
        signal: ctx?.signal,
        tenantId,
        threadId: payload.widgetThreadId,
        nudge: chatFollowupNudge(
          cfg.chatFollowupInstructions,
          payload.originDisplayId,
        ),
        base,
        // NOTE: The composite fence, across the widest window in the ladder (the model turn), so a
        // switch flipped mid-turn does not reach the customer. A stand-down suppresses the send but
        // leaves the checkpointed turn in history, as every post-invoke gate of `runAgentNudge` does.
        // `rescheduleTo` asks the fence again, so the verdict is not carried to the advance. What is
        // left is a switch turned OFF and back ON inside the milliseconds before that ask, and an
        // agent live again by then has a defensible claim to the next stage.
        stillWanted: async ({ strict }) => (await fence({ strict })) === "go",
        deps,
      });
      // NOTE: a nudge that reached the chat spends the stage: a run past its deadline that got this far
      // has its advance written, or its retry nudges the lead a second time.
      if (nudgeReachedConversation(outcome)) ctx?.commit();
      // NOTE: The only stage a refusal can cost, so it retries the SAME stage rather than spend the
      // softest escalation on nothing. Through the same fence as `rescheduleTo`, so an agent switched
      // off ends the ladder. On exhaustion it falls through to the advance: the later stages send
      // fixed text with no model, so the ladder still escalates.
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
      // NOTE: the link sent spends the stage, like the chat stage's nudge.
      if (outcome === "sent") ctx?.commit();
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
    const closing = await deliverRedirectClosing({
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
    // NOTE: its own stamp already answers a retry "already-closed"; committed anyway, so the rule is
    // the same for every stage that sends.
    if (closing === "delivered") ctx?.commit();
  }
  return { outcome: "done" };
}

let registered = false;
export function registerRedirectFollowUpHandlers(): void {
  if (registered) return;
  registerJobHandler("REDIRECT_FOLLOWUP", (job, base, ctx) =>
    redirectFollowUpHandler(job, base, undefined, ctx),
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
  // The post-claim asks, covering retirement AND the agent's switch in one round trip.
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
  // the log line names the switch rather than a race that did not happen.
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

  // NOTE: The retirement fence and the CLAIM sit together, after every read: claiming earlier would
  // let a ladder retired mid-read burn the at-most-once anchor on a closing it then refuses to
  // deliver, leaving a funnel that can never close. A race loser only discards a few reads.
  const beforeClaim = await ask();
  if (beforeClaim !== "go") {
    return beforeClaim === "retired" ? "already-closed" : "stood-down";
  }

  // NOTE: The resolve trigger has no job to ask, and `redirectClosedAt: null` cannot tell "never
  // closed" from "/reset just cleared it". `lastInboundAt`, read before and compared in the claim,
  // is the fence (a new inbound also means the conversation reopened). When it is null nothing
  // distinguishes the episode from the one after a reset, so a caller with no job does not claim.
  if (!p.stillWanted && cx.widget.lastInboundAt === null) {
    logger.info(
      "channel-redirect: closing stood down — no job to ask and no episode token to compare (widget conv=%d)",
      p.widgetConversationId,
    );
    return "already-closed";
  }

  // NOTE: Claim the closing: set the watermark only if still unset AND the episode is the one this
  // run read (the origin, with null a value and not a wildcard), since a re-entry meanwhile would
  // have the goodbye resolve a thread no longer paired. With a null origin, the mark's NULLNESS
  // (never its value, which advances on every payload) tells "never told" from "told none". The
  // whole protocol: docs/channel-redirect.md, "The closing, at most once".
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

  // NOTE: Asked once more after the claim write, the last point where the episode can end without a
  // goodbye; a stand-down releases the anchor (CAS'd on this claim's instant), or the funnel could
  // never close again. NOT asked between the two deliveries: stopping halfway leaves it half-closed.
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

  // NOTE: The fence for a caller with no job: /reset CLEARS this anchor, so the claim is the token,
  // re-read the way a job re-reads `claim_seq` (still our exact instant, or not ours to deliver or
  // release). A closure, asked once per stretch of I/O that precedes each of the two sends.
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

  // NOTE: The job, asked again and LAST, since the claim read above is a round trip a /reset can land
  // in. Only one question can be last: this leaves open a concurrent closing taking the anchor (a
  // rare duplicate goodbye) and closes the reset (a conversation the operator was told was clean).
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
  // NOTE: ONE watermark read, then ONE fence, and nothing between the fence and the send (the fence
  // gets the last word: a stale one would send from a switched-off agent). Both are skipped once the
  // chat half was delivered, since a started delivery completes both halves. A stand-down releases
  // the claim; a lost watermark does not, since that claim belongs to another run.
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
