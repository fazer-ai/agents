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

// A single sanitized line for the alert body — never message text. Stage + provider + the
// already-sanitized error / status. Bounded.
function summarize(ev: FlowEvent & { level: FlowLevel }): string {
  const head = ev.errorMessage ?? ev.status ?? ev.level;
  const via = ev.provider ? ` via ${ev.provider}` : "";
  return sanitizeErrorMessage(`[${ev.stage}${via}] ${head}`, 300);
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
    const summary = summarize(ev);
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
          },
        });
      }
    }
  });
}
