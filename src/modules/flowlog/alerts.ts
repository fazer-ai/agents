import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { FlowContext, FlowEvent } from "./service";
import { ALERT_DELIVERY_UNIT, type FlowLevel } from "./stages";

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
  if (ev.stage === "dead_letter") {
    const unit = vocabulary("unit", detail.unit);
    if (unit === null) return null;
    const kind = vocabulary("kind", detail.kind);
    return kind === null
      ? `dead_letter:${unit}`
      : `dead_letter:${unit}:${kind}`;
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
  const rank = LEVEL_RANK[ev.level] ?? 0;
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
    if (channels.length === 0) return;
    const summary = alertSummary(ev);
    const causeKey = causeKeyOf(ev);
    // A cause alert is at least a `warn` on the row: the line can be an `info` (a run the job
    // will retry against a dead key), and what the operator reads is that something needs fixing.
    const level: FlowLevel =
      causeKey !== null && ev.level === "info" ? "warn" : ev.level;
    for (const ch of channels) {
      // minLevel gate: a channel set to "error" ignores "warn" events (default rank = error = 2). A
      // cause passes it: the stage allowlist and the excluded agents below still apply, because those
      // name the stage and the agent, where the level is only a threshold.
      if (causeKey === null && (LEVEL_RANK[ch.minLevel] ?? 2) > rank) continue;
      // stage allowlist (empty = all stages).
      if (ch.stages.length > 0 && !ch.stages.includes(ev.stage)) continue;
      // NOTE: Agents this channel leaves out. A line with no agent is never excluded: the list
      // names agents, and an unrouted or tenant-wide line belongs to none of them.
      if (ctx.agentId != null && ch.excludeAgentIds.includes(ctx.agentId))
        continue;
      if (causeKey !== null) {
        // One delivery per (channel, cause) per window, whatever its status: a sent alert keeps
        // counting the repeats instead of a second one going out. Serialized per (channel, cause)
        // for the transaction, because the window is not a key a unique index can hold, and two
        // concurrent failures of a dead key are the normal case, not a rare one.
        await db.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`alert-cause:${ch.id}:${causeKey}`}, 0))`;
        const open = await db.alertDelivery.findFirst({
          where: {
            channelId: ch.id,
            causeKey,
            status: { not: "DEAD" },
            createdAt: { gte: new Date(Date.now() - causeWindowMs) },
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
            stage: ev.stage,
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
          stage: ev.stage,
          level,
          causeKey,
          summary,
          // NOTE: Where the event happened, so the alert can link to it. Only here: the bump
          // above leaves them naming the first event, like `summary`.
          turnId: ctx.turnId,
          conversationId: ctx.conversationId ?? null,
        },
      });
    }
  });
}
