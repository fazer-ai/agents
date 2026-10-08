import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { isTransientProviderStatus } from "@/lib/provider-failure";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import type { FlowContext, FlowEvent } from "./service";
import { ALERT_DELIVERY_UNIT, type FlowLevel, type FlowStage } from "./stages";

// Alert fan-out for a warn/error execution-flow event. Called fire-and-forget from emitFlowEvent
// (real traffic only). Matches enabled channels by minLevel + stage allowlist, then COALESCES: a
// pending delivery for the same (channel, stage, level) is bumped (count++) instead of inserting a
// new one — the anti-flood guard. The alert worker drains these on a debounced window so the count
// accumulates before the single POST. The ledger row carries NO PII (only stage/level/summary).

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

const LEVEL_RANK: Record<string, number> = { info: 0, warn: 1, error: 2 };

// Why a warn or error line with no error text was raised lives in `detail`; `status` only says how
// the stage ended (a delivery recovered on retry ends `ok`). Read from an ALLOWLIST, never from
// `detail` as a whole: the alert gets the event before the row's redaction runs, and a tool line
// can carry the call's args and output. Every key below holds a closed vocabulary at every site
// that sets it, and a value is still dropped unless it looks like one.
//
// The CAUSE is the first of these present, printed bare: it answers the question on its own.
const CAUSE_KEYS = ["skipped", "failed", "outcome", "state", "reason"] as const;
// CONTEXT for the cause, printed as `key=value` because the value alone would mislead: a turn
// answered by the fallback ends `ok`, and `ok: timeout` reads as a turn that timed out.
const LABELED_KEYS = [
  "fallbackUnavailable",
  "fallbackReason",
  "phase",
  "action",
  "direction",
  "strandedOn",
  // Which limit a `capacity` line waited on (`debounce_lane` | `model_semaphore`): the one thing
  // the operator needs to know to act, since the two are raised differently.
  "waitedOn",
  // What a `channel_error` was classified as, and the channel's own error number: `action` alone
  // says what was done about it, not what the channel answered.
  "class",
  "code",
] as const;
// FLAGS whose value is a count or `true`, so only the key's presence carries the why.
const FLAG_KEYS = [
  "toolLimitHit",
  "retriedEmptyResponse",
  "silenceTokenSuppressed",
  "silenceTokenInReply",
  "retry",
  // A turn that ended with no reply, no `skip_reply` and no handoff: the line's whole point.
  "silenceUnexplained",
  // A proactive turn that ran beside another invoke holding its thread past the lease (nudge.ts).
  "threadWaitExpired",
] as const;
// BOOLEANS whose `false` says as much as their `true`, so both are printed, labeled. A `false`
// `resolveDiscarded` is a conversation left pending with no owner; `silenceRetried` is `true` for a
// silence the retry could not recover and `false` for one the agent's own switch left unretried.
const BOOLEAN_KEYS = ["resolveDiscarded", "silenceRetried"] as const;
// Every `detail` key the body can print, for the fence that holds each warn and error line to name at
// least one (tests/modules/flowlog-alert-summary.test.ts): a line with none alerts as its bare status.
export const ALERT_DETAIL_KEYS: readonly string[] = [
  ...CAUSE_KEYS,
  ...LABELED_KEYS,
  ...FLAG_KEYS,
  ...BOOLEAN_KEYS,
];
// On these stages `reason` names what TRIGGERED the work, not what went wrong: `observe` stamps
// `burst` or `resolved` on every line, so `skipped: burst` would name the wrong thing.
const TRIGGER_REASON_STAGES: ReadonlySet<string> = new Set(["observe"]);
// A slug: no space, so no sentence, and none of what an address or a URL needs. `fallbackReason`
// alone may be a phrase, because the provider-failure classifier words its output that way (`HTTP
// 503`, `provider error`, the empty-completion sentence); it is still a fixed set.
const SLUG_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const PHRASE_VALUE = /^[A-Za-z0-9][A-Za-z0-9 _.:()-]{0,63}$/;
const PHRASE_KEYS: ReadonlySet<string> = new Set(["fallbackReason"]);

function vocabulary(key: string, value: unknown): string | null {
  const shape = PHRASE_KEYS.has(key) ? PHRASE_VALUE : SLUG_VALUE;
  return typeof value === "string" && shape.test(value) ? value : null;
}

// A single sanitized line for the alert body — never message text. Stage + provider + the error
// text, or else the status and why `detail` says it was raised. Bounded.
//
// A coalesced delivery keeps the body of the FIRST event of its window while `count` grows, so
// `(×23)` with `stranded` says the first one was stranded, not that all 23 were.
export function alertSummary(ev: FlowEvent & { level: FlowLevel }): string {
  const via = ev.provider ? ` via ${ev.provider}` : "";
  return sanitizeErrorMessage(
    `[${ev.stage}${via}] ${ev.errorMessage ? withUnread(ev.errorMessage, ev) : statusWithWhy(ev)}`,
    300,
  );
}

// The error says why a read failed; `unread` says what the customer's message lost, which is what the
// operator weighs (`image`, `document`). Set only on the line that ended an extraction empty.
function withUnread(text: string, ev: FlowEvent): string {
  const unread = vocabulary("unread", ev.detail?.unread);
  return unread === null ? text : `${text} (${unread} left unread)`;
}

function statusWithWhy(ev: FlowEvent & { level: FlowLevel }): string {
  const head = ev.status ?? ev.level;
  const detail = ev.detail ?? {};
  const parts: string[] = [];
  for (const key of CAUSE_KEYS) {
    if (key === "reason" && TRIGGER_REASON_STAGES.has(ev.stage)) continue;
    const value = vocabulary(key, detail[key]);
    if (value !== null) {
      parts.push(value);
      break;
    }
  }
  for (const key of LABELED_KEYS) {
    const value = vocabulary(key, detail[key]);
    if (value !== null) parts.push(`${key}=${value}`);
  }
  for (const key of FLAG_KEYS) {
    if (detail[key] !== undefined && detail[key] !== false) parts.push(key);
  }
  for (const key of BOOLEAN_KEYS) {
    if (typeof detail[key] === "boolean") parts.push(`${key}=${detail[key]}`);
  }
  return parts.length === 0 ? head : `${head}: ${parts.join(" ")}`;
}

// The failures that are the ACCOUNT, not the moment: the same endpoint answers them the same way until
// someone fixes a key, a quota or a plan, so they are causes and not noise to coalesce for 30 seconds.
const ACCOUNT_FAILURES: ReadonlySet<string> = new Set([
  "HTTP 401",
  "HTTP 403",
  "HTTP 429",
]);

// What an operator has to fix, when this line names something only a person can: the key a cause
// alert is deduplicated on per channel for `ALERT_CAUSE_WINDOW_MS`, and the reason it passes the
// channel's `minLevel` (a TTS key that died is a `warn`, since the reply went as text, and it is the one
// thing an error-only channel needs to hear). Null for every other line. Built from closed
// vocabularies only (`failure` is `providerFailure`'s word, `unit` and `kind` are enums, a channel
// code is a slug), so the key never carries text a server wrote.
export function causeKeyOf(ev: FlowEvent): string | null {
  const detail = ev.detail ?? {};
  if (ev.stage === "spend_ceiling") {
    return detail.state === "over" ? "spend_ceiling:over" : null;
  }
  if (ev.stage === "channel_error") {
    return `channel_error:${vocabulary("code", detail.code) ?? "unknown"}`;
  }
  // An answer to a stranded message that came late enough that the customer waited for it: a cause,
  // so it reaches a channel whatever its minimum level, and a run of them is one alert.
  if (ev.stage === "delivery") {
    return isLateAnswer(ev) ? "delivery:late_answer" : null;
  }
  if (ev.stage === "dead_letter") {
    // A discarded outcome is a warning on a job that is still live and will run again, not lost work:
    // giving it the death's key would let it take the window and fold the real death into its count.
    if (detail.discarded !== undefined) return null;
    const unit = vocabulary("unit", detail.unit);
    if (unit === null) return null;
    const kind = vocabulary("kind", detail.kind);
    return kind === null
      ? `dead_letter:${unit}`
      : `dead_letter:${unit}:${kind}`;
  }
  // A primary the fallback took the turn from on an account failure (a 429, the one the fallback is
  // asked for): the line is `ok` and labelled with the fallback, and the cause is the primary's.
  const from = detail.fallbackFrom;
  const primary = detail.primaryFailure;
  if (
    typeof from === "string" &&
    typeof primary === "string" &&
    ACCOUNT_FAILURES.has(primary)
  ) {
    return `${ev.stage}:${vocabulary("provider", from) ?? "-"}:${primary}`;
  }
  const failure = detail.failure;
  if (
    ev.status === "error" &&
    typeof failure === "string" &&
    ACCOUNT_FAILURES.has(failure)
  ) {
    return `${ev.stage}:${vocabulary("provider", ev.provider) ?? "-"}:${failure}`;
  }
  return null;
}

// A line whose failure a fallback's line already classified as an account failure: that line is the
// alert (`causeKeyOf`), and this one, labelled with the primary, is only the turn's record.
function coveredByCause(ev: FlowEvent): boolean {
  const reported = ev.detail?.fallbackFailure;
  return typeof reported === "string" && ACCOUNT_FAILURES.has(reported);
}

export async function dispatchAlertsForEvent(
  ctx: FlowContext,
  ev: FlowEvent & { level: FlowLevel },
  base: PrismaClient,
  causeWindowMs: number = config.alertWorker.causeWindowMs,
): Promise<void> {
  // NOTE: A dead `AlertDelivery` never becomes an alert. Routing it back here would queue a
  // delivery to the channel that just died, which dies and queues another (coalescing does not
  // bound it: the row it would follow is DEAD, so every cycle inserts). The flow-log row, written
  // before this runs, is the only sink that is not the failing path.
  if (ev.detail?.unit === ALERT_DELIVERY_UNIT) return;
  // NOTE: A turn whose fallback died on its account: the fallback's own line is the cause alert,
  // deduplicated for the window, so this line paging every 30 seconds beside it would undo that.
  if (coveredByCause(ev)) return;
  const causeKey = causeKeyOf(ev);
  await deliverAlert(ctx, base, {
    stage: ev.stage,
    // A cause alert is at least a `warn` on the row: the line can be an `info` (a run the job will
    // retry against a dead key), and what the operator reads is that something needs fixing.
    level: causeKey !== null && ev.level === "info" ? "warn" : ev.level,
    rank: LEVEL_RANK[ev.level] ?? 0,
    summary: alertSummary(ev),
    cause:
      causeKey === null ? null : { key: causeKey, windowMs: causeWindowMs },
  });
}

interface AlertToDeliver {
  stage: FlowStage;
  level: FlowLevel;
  // The rank the channel's `minLevel` is compared with; a cause skips that comparison.
  rank: number;
  summary: string;
  cause: { key: string; windowMs: number } | null;
  // Asked per channel past its gates, for an alert whose trigger depends on what the channel keeps:
  // the summary to deliver, or null when this channel does not get one.
  summaryFor?: (
    db: ScopedDb,
    excludeAgentIds: bigint[],
  ) => Promise<string | null>;
}

async function deliverAlert(
  ctx: FlowContext,
  base: PrismaClient,
  alert: AlertToDeliver,
): Promise<void> {
  const { stage, level, cause } = alert;
  await runScopedOn(base, sysCtx(ctx.tenantId), async (db) => {
    const channels = await db.alertChannel.findMany({
      where: { enabled: true },
      select: {
        id: true,
        minLevel: true,
        stages: true,
        excludeAgentIds: true,
      },
    });
    for (const ch of channels) {
      // minLevel gate: a channel set to "error" ignores "warn" events (default rank = error = 2). A
      // cause passes it: the stage allowlist and the excluded agents below still apply, because those
      // name the stage and the agent, where the level is only a threshold.
      if (cause === null && (LEVEL_RANK[ch.minLevel] ?? 2) > alert.rank)
        continue;
      // stage allowlist (empty = all stages).
      if (ch.stages.length > 0 && !ch.stages.includes(stage)) continue;
      // NOTE: Agents this channel leaves out. A line with no agent is never excluded: the list
      // names agents, and an unrouted or tenant-wide line belongs to none of them.
      if (ctx.agentId != null && ch.excludeAgentIds.includes(ctx.agentId))
        continue;
      const summary = alert.summaryFor
        ? await alert.summaryFor(db, ch.excludeAgentIds)
        : alert.summary;
      if (summary === null) continue;
      if (cause !== null) {
        // One delivery per (channel, cause) per window, whatever its status: a sent alert keeps
        // counting the repeats instead of a second one going out. Serialized per (channel, cause)
        // for the transaction, because the window is not a key a unique index can hold, and two
        // concurrent failures of a dead key are the normal case, not a rare one.
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`alert-cause:${ch.id}:${cause.key}`}, 0))`;
        const open = await db.alertDelivery.findFirst({
          where: {
            channelId: ch.id,
            causeKey: cause.key,
            status: { not: "DEAD" },
            createdAt: { gte: new Date(Date.now() - cause.windowMs) },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true },
        });
        if (open) {
          // NOTE: Raw, so `updated_at` stays put: it is the SENDING lease the worker reaps by, and a
          // dead key repeating faster than the stale window would otherwise keep a crashed claim alive
          // for the whole cause window.
          await db.$executeRaw`UPDATE alert_deliveries SET count = count + 1 WHERE id = ${open.id}`;
          continue;
        }
      } else {
        // Coalesce a burst: bump an existing pending delivery for this (channel, stage, level),
        // else insert one. A rare race may insert two rows; the worker's window still coalesces most.
        const bumped = await db.alertDelivery.updateMany({
          where: {
            channelId: ch.id,
            stage,
            level,
            status: "PENDING",
            causeKey: null,
          },
          data: { count: { increment: 1 } },
        });
        if (bumped.count > 0) continue;
      }
      await db.alertDelivery.create({
        data: {
          tenantId: ctx.tenantId,
          channelId: ch.id,
          stage,
          level,
          causeKey: cause?.key ?? null,
          summary,
          // NOTE: Where the event happened, so the alert can link to it. Only here: the bump
          // above leaves them naming the first event, like `summary`.
          turnId: ctx.turnId,
          conversationId: ctx.conversationId ?? null,
          agentId: ctx.agentId ?? null,
        },
      });
    }
  });
}

// The stages that call a model provider, where a timeout or an overloaded endpoint is the provider's
// state rather than our request. `tool` is not one: an HTTP tool's 502 is the operator's own API.
const RATE_STAGES: ReadonlySet<string> = new Set([
  "generate",
  "vision",
  "stt",
  "tts",
  "normalize",
  "embed",
]);

// Every `failure` word that counts toward a provider's rate: `timeout`, and each `HTTP <nnn>` the
// shared set calls the endpoint's momentary state. Enumerated once, so the count is a plain `IN`.
const TRANSIENT_FAILURES: readonly string[] = [
  "timeout",
  ...Array.from({ length: 500 }, (_, i) => i + 100)
    .filter(isTransientProviderStatus)
    .map((status) => `HTTP ${status}`),
];

// The provider a line's failure counts against, when it is a transient failure on a model stage:
// recovered or not, and whatever its level, since a retried attempt is `info` and still a failure.
export function rateSubjectOf(
  ev: FlowEvent,
): { stage: FlowStage; provider: string | null } | null {
  if (!RATE_STAGES.has(ev.stage)) return null;
  // A primary the fallback took the turn from: the line is `ok` and labelled with the fallback, and
  // the failure it records is the primary's, so it counts toward the primary's rate.
  const from = ev.detail?.fallbackFrom;
  const primary = ev.detail?.primaryFailure;
  if (typeof from === "string" && typeof primary === "string")
    return TRANSIENT_FAILURES.includes(primary)
      ? { stage: ev.stage, provider: from }
      : null;
  if (ev.status !== "error") return null;
  const failure = ev.detail?.failure;
  if (typeof failure !== "string" || !TRANSIENT_FAILURES.includes(failure))
    return null;
  return { stage: ev.stage, provider: ev.provider ?? null };
}

export interface RateOptions {
  threshold: number;
  windowMs: number;
}

// A provider failing now and then is recovered by retries and alerts nobody; one failing every few
// minutes slows every turn it touches. Counted from the flow log itself, which already holds every
// failure line with its stage, provider and `failure` word (indexed on tenant, stage and time), so
// there is no counter to keep in step. At the threshold the alert is a cause keyed on the stage and
// provider, deduplicated over the same window: a provider that stays degraded alerts again once the
// window has passed, and the failures in between are counted on the delivery.
export async function dispatchRateAlert(
  ctx: FlowContext,
  ev: FlowEvent,
  base: PrismaClient,
  opts: RateOptions = {
    threshold: config.alertWorker.rateThreshold,
    windowMs: config.alertWorker.rateWindowMs,
  },
): Promise<void> {
  const subject = rateSubjectOf(ev);
  if (subject === null) return;
  const since = new Date(Date.now() - opts.windowMs);
  // Counted per channel, without the agents it leaves out: an evaluation agent failing on
  // purpose is not a degraded provider to the channel that excludes it. A line with no agent counts.
  const failuresFor = (db: ScopedDb, excludeAgentIds: bigint[]) =>
    db.executionLog.count({
      where: {
        stage: subject.stage,
        source: "inbox",
        createdAt: { gte: since },
        AND: [
          {
            OR: [
              // The provider's own failure lines.
              {
                provider: subject.provider,
                status: "error",
                OR: TRANSIENT_FAILURES.map((failure) => ({
                  detail: { path: ["failure"], equals: failure },
                })),
              },
              // The turns a fallback took from it, which are `ok` lines labelled with the fallback.
              ...(subject.provider === null
                ? []
                : [
                    {
                      detail: {
                        path: ["fallbackFrom"],
                        equals: subject.provider,
                      },
                      OR: TRANSIENT_FAILURES.map((failure) => ({
                        detail: { path: ["primaryFailure"], equals: failure },
                      })),
                    },
                  ]),
            ],
          },
          ...(excludeAgentIds.length > 0
            ? [
                {
                  OR: [
                    { agentId: null },
                    { agentId: { notIn: excludeAgentIds } },
                  ],
                },
              ]
            : []),
        ],
      },
    });
  // The tenant's count bounds every channel's from above, so below the threshold nobody gets one.
  const failures = await runScopedOn(base, sysCtx(ctx.tenantId), (db) =>
    failuresFor(db, []),
  );
  if (failures < opts.threshold) return;
  const via = subject.provider ? ` via ${subject.provider}` : "";
  const minutes = Math.max(1, Math.round(opts.windowMs / 60_000));
  const summaryOf = (n: number) =>
    sanitizeErrorMessage(
      `[${subject.stage}${via}] provider degraded: ${n} transient failures in ${minutes} min`,
      300,
    );
  await deliverAlert(ctx, base, {
    stage: subject.stage,
    level: "warn",
    rank: LEVEL_RANK.warn as number,
    summary: summaryOf(failures),
    summaryFor: async (db, excludeAgentIds) => {
      if (excludeAgentIds.length === 0) return summaryOf(failures);
      const n = await failuresFor(db, excludeAgentIds);
      return n < opts.threshold ? null : summaryOf(n);
    },
    cause: {
      key: `rate:${subject.stage}:${vocabulary("provider", subject.provider) ?? "-"}`,
      windowMs: opts.windowMs,
    },
  });
}

// The outcomes that close a stranded delivery with nothing left for a person: a recovery that replayed
// it (`recovered`), and a later turn that folded it in (`consumed_late`) or answered it
// (`answered_late`). The losses (`unanswered`, `memory_unrecovered`) and the stranded line itself are
// not among them: those still need someone and page on their own.
const RECOVERED_OUTCOMES: ReadonlySet<string> = new Set([
  "recovered",
  "consumed_late",
  "answered_late",
]);

// A stranded delivery that ended well: it pages nobody alone and counts toward the recovery rate. An
// answer that came more than `lateReplyAgeMs` after the message is the exception, since the customer
// waited for it, so it keeps its own alert. A healthy instance strands almost none, so one at a time
// says nothing an operator acts on, and after an incident the backlog drains for hours: paging each
// one buries the alert that means a customer is still waiting.
export function recoverySubjectOf(ev: FlowEvent): boolean {
  if (ev.stage !== "delivery") return false;
  const outcome = ev.detail?.outcome;
  if (typeof outcome !== "string" || !RECOVERED_OUTCOMES.has(outcome))
    return false;
  return !isLateAnswer(ev);
}

// An `answered_late` whose answer came more than `lateReplyAgeMs` after the message arrived.
function isLateAnswer(
  ev: FlowEvent,
  lateReplyAgeMs: number = config.alertWorker.lateReplyAgeMs,
): boolean {
  if (ev.stage !== "delivery" || ev.detail?.outcome !== "answered_late")
    return false;
  const age = ev.detail?.ageMs;
  return typeof age === "number" && age > lateReplyAgeMs;
}

// The cause key of the recovery rate, read by the alert body to word its link.
export const RECOVERY_RATE_KEY = "rate:delivery:recovered";

export interface RecoveryRateOptions {
  threshold: number;
  windowMs: number;
}

// One alert per window for the stranded deliveries that ended well, counted from the flow log like the
// provider rate: at the threshold it is a cause keyed `rate:delivery:recovered` with the window as its
// dedupe window, so the recoveries after it in the window are counted on it, and a run that goes on
// past the window alerts again.
export async function dispatchRecoveryRateAlert(
  ctx: FlowContext,
  base: PrismaClient,
  opts: RecoveryRateOptions = {
    threshold: config.alertWorker.recoveryThreshold,
    windowMs: config.alertWorker.recoveryWindowMs,
  },
): Promise<void> {
  const since = new Date(Date.now() - opts.windowMs);
  const recoveredFor = async (db: ScopedDb, excludeAgentIds: bigint[]) => {
    const scope = {
      stage: "delivery",
      source: "inbox",
      createdAt: { gte: since },
      ...(excludeAgentIds.length > 0
        ? {
            OR: [{ agentId: null }, { agentId: { notIn: excludeAgentIds } }],
          }
        : {}),
    };
    const all = await db.executionLog.count({
      where: {
        ...scope,
        AND: [
          {
            OR: [...RECOVERED_OUTCOMES].map((outcome) => ({
              detail: { path: ["outcome"], equals: outcome },
            })),
          },
        ],
      },
    });
    // The late answers alert on their own (`causeKeyOf`), so they are not counted here too. Taken
    // off by subtraction rather than a NOT in the count: a line without `ageMs` (written before the
    // sweep stated it) makes the comparison NULL, and a NOT over NULL would drop it from the count,
    // where `recoverySubjectOf` counts it.
    const late = await db.executionLog.count({
      where: {
        ...scope,
        AND: [
          { detail: { path: ["outcome"], equals: "answered_late" } },
          {
            detail: {
              path: ["ageMs"],
              gt: config.alertWorker.lateReplyAgeMs,
            },
          },
        ],
      },
    });
    return all - late;
  };
  const recovered = await runScopedOn(base, sysCtx(ctx.tenantId), (db) =>
    recoveredFor(db, []),
  );
  if (recovered < opts.threshold) return;
  const minutes = Math.max(1, Math.round(opts.windowMs / 60_000));
  const summaryOf = (n: number) =>
    `[delivery] ${n} stranded deliveries were recovered in ${minutes} min`;
  await deliverAlert(ctx, base, {
    stage: "delivery",
    level: "warn",
    rank: LEVEL_RANK.warn as number,
    summary: summaryOf(recovered),
    summaryFor: async (db, excludeAgentIds) => {
      if (excludeAgentIds.length === 0) return summaryOf(recovered);
      const n = await recoveredFor(db, excludeAgentIds);
      return n < opts.threshold ? null : summaryOf(n);
    },
    cause: { key: RECOVERY_RATE_KEY, windowMs: opts.windowMs },
  });
}
