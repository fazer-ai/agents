import type { PrismaClient } from "@/../generated/prisma/client";
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

// WHY A LINE WITH NO ERROR TEXT IS A WARN OR AN ERROR lives in `detail`, and the body used to stop
// at `status` (issue #610). That field says how the stage ended, not why anyone is being told: a
// delivery recovered on retry ends `ok`, so its warn arrived as `[delivery] ok`, and 23 stranded
// deliveries arrived as `[delivery] error`, the same words a routine line would use.
//
// READ FROM AN ALLOWLIST, never from `detail` as a whole. The alert gets the event before the row's
// redaction runs, and `detail` is not text-free everywhere: a tool line carries the call's `args`
// and `output` when the operator turns tool values on. Every key below holds a closed vocabulary at
// every site that sets it (string literals, union types, a Prisma enum, the provider-failure
// classifier's output), and a value is still dropped unless it looks like one.
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
] as const;
// FLAGS whose value is a count or `true`, so only the key's presence carries the why.
const FLAG_KEYS = [
  "toolLimitHit",
  "retriedEmptyResponse",
  "silenceTokenSuppressed",
  "silenceTokenInReply",
  "retry",
] as const;
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
    `[${ev.stage}${via}] ${ev.errorMessage ?? statusWithWhy(ev)}`,
    300,
  );
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
  return parts.length === 0 ? head : `${head}: ${parts.join(" ")}`;
}

export async function dispatchAlertsForEvent(
  ctx: FlowContext,
  ev: FlowEvent & { level: FlowLevel },
  base: PrismaClient,
): Promise<void> {
  // NOTE: THE ONE LINE THAT CANNOT BECOME AN ALERT — the alert bus reporting its own death
  // (issue #356).
  //
  // A dead `AlertDelivery` is the operator's notification failing to arrive, and it is announced
  // like every other terminal failure. Routing that announcement back through here would queue a
  // new delivery to the very channel that just died — which dies, announces, and queues another.
  // The coalescing below does not bound it: it bumps a PENDING row, and the row this one would
  // follow is DEAD, so every cycle INSERTS. With two broken channels they alert about each other
  // forever, so excluding the dying channel would not close it either; the only sink that is not
  // the failing path is the flow-log row itself, which is written before this runs.
  if (ev.detail?.unit === ALERT_DELIVERY_UNIT) return;
  const rank = LEVEL_RANK[ev.level] ?? 0;
  await runScopedOn(base, sysCtx(ctx.tenantId), async (db) => {
    const channels = await db.alertChannel.findMany({
      where: { enabled: true },
      select: { id: true, minLevel: true, stages: true },
    });
    if (channels.length === 0) return;
    const summary = alertSummary(ev);
    for (const ch of channels) {
      // minLevel gate: a channel set to "error" ignores "warn" events (default rank = error = 2).
      if ((LEVEL_RANK[ch.minLevel] ?? 2) > rank) continue;
      // stage allowlist (empty = all stages).
      if (ch.stages.length > 0 && !ch.stages.includes(ev.stage)) continue;
      // Coalesce a burst: bump an existing pending delivery for this (channel, stage, level),
      // else insert one. A rare race may insert two rows; the worker's window still coalesces most.
      const bumped = await db.alertDelivery.updateMany({
        where: {
          channelId: ch.id,
          stage: ev.stage,
          level: ev.level,
          status: "PENDING",
        },
        data: { count: { increment: 1 } },
      });
      if (bumped.count === 0) {
        await db.alertDelivery.create({
          data: {
            tenantId: ctx.tenantId,
            channelId: ch.id,
            stage: ev.stage,
            level: ev.level,
            summary,
            // Where the event happened, so the alert can link to it (issue #665). Only here: the
            // bump above leaves them naming the first event, like `summary`.
            turnId: ctx.turnId,
            conversationId: ctx.conversationId ?? null,
          },
        });
      }
    }
  });
}
