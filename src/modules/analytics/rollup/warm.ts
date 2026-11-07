import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import metricsPrisma from "@/api/lib/prisma-metrics";
import config from "@/config";
import { parseDbId } from "@/lib/db-id";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import type { DashboardFilter } from "../filter";
import { addDays, dayCount, localDay } from "./days";
import { type DayWindow, filterKey, LIVE_DAYS, WindowLoad } from "./engine";
import { SECTIONS } from "./sections";

// KEEPING THE DAYS WARM (docs/dashboard.md, "Keeping the days warm"). A tenant whose old
// conversations change all day drops most of its kept days between two visits, and the next opening
// computes them in front of the viewer. The console records each view it opens (tenant, filter, zone,
// how far back it reaches); every DASHBOARD_WARM_INTERVAL_MS this pass settles the queue and computes
// again, one part at a time on the metrics pool, the past days each view opened in the last
// DASHBOARD_WARM_IDLE_DAYS reaches. An opening then computes only the days that are never kept.

export interface WarmView {
  tenantId: bigint;
  filterKey: string;
  tz: string;
  spanDays: number | null;
}

// The filter a key was made from (`filterKey`): source, agent, inbox and, when set, audience.
export function filterOfKey(key: string): DashboardFilter {
  const [source = "", agent = "", inbox = "", audience] = key.split("|");
  const f: DashboardFilter = {};
  if (source) f.source = source as DashboardFilter["source"];
  const agentId = parseDbId(agent);
  const inboxId = parseDbId(inbox);
  if (agentId !== null) f.agentId = agentId;
  if (inboxId !== null) f.inboxId = inboxId;
  if (audience) f.audience = audience as DashboardFilter["audience"];
  return f;
}

// How far back an opened window reaches: the days from its first day to today, whatever its last day,
// so a range of last June is kept warm with everything after it. Null for a window with no start. The
// console opens the window and the period before it as two streams, so each records its own reach.
export function spanOf(window: DayWindow, now = Date.now()): number | null {
  if (!window.first) return null;
  const today = localDay(now, window.tz);
  return today < window.first ? 1 : dayCount(window.first, today);
}

// Records an opening. A view opened within the idle window keeps the farthest reach opened since, so
// switching from 30 to 7 days does not let the 30 cool down; one idle longer starts from this reach.
export async function recordView(
  ctx: TenantContext,
  filter: DashboardFilter,
  window: DayWindow,
  base: PrismaClient = metricsPrisma,
): Promise<void> {
  if (ctx.tenantId === null) return;
  const span = spanOf(window);
  const now = new Date();
  const fresh = new Date(
    now.getTime() - config.dashboardWarm.idleDays * 86_400_000,
  );
  await runScopedOn(base, ctx, (db) =>
    db.$executeRaw(Prisma.sql`
      INSERT INTO dashboard_views (tenant_id, filter_key, tz, span_days, opened_at)
      VALUES (${ctx.tenantId}, ${filterKey(filter)}, ${window.tz}, ${span}, ${now})
      ON CONFLICT (tenant_id, filter_key, tz) DO UPDATE SET
        span_days = CASE
          WHEN dashboard_views.opened_at <= ${fresh} THEN EXCLUDED.span_days
          WHEN dashboard_views.span_days IS NULL OR EXCLUDED.span_days IS NULL THEN NULL
          ELSE GREATEST(dashboard_views.span_days, EXCLUDED.span_days) END,
        opened_at = EXCLUDED.opened_at`),
  );
}

// The days a view keeps warm: from as far back as it reaches up to the last day that is kept (the day
// before yesterday). Null when there is none.
export function warmWindow(
  view: Pick<WarmView, "tz" | "spanDays">,
  now = Date.now(),
): DayWindow | null {
  const today = localDay(now, view.tz);
  const last = addDays(today, -LIVE_DAYS);
  if (view.spanDays === null) return { tz: view.tz, first: null, last };
  const first = addDays(today, -(view.spanDays - 1));
  return first <= last ? { tz: view.tz, first, last } : null;
}

// The days one load of the pass holds. A load keeps every day it computes in memory, percentile cells
// included, and the pass never merges them, so it walks the view's days in loads of this many.
export const WARM_CHUNK_DAYS = 31;

// Computes the dropped days of one view, the most recent first, in loads of WARM_CHUNK_DAYS and each
// part on its own budget. Returns the parts run. A whole-history view walks back until a load finds
// no day with records.
export async function warmView(
  view: WarmView,
  base: PrismaClient = metricsPrisma,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<number> {
  const window = warmWindow(view, now);
  if (!window?.last) return 0;
  const ctx: TenantContext = {
    tenantId: view.tenantId,
    userId: null,
    role: "TENANT_ADMIN",
    actorType: "system",
  };
  const filter = { ...filterOfKey(view.filterKey), tz: view.tz };
  let parts = 0;
  for (let last = window.last; !signal?.aborted; ) {
    const from = addDays(last, -(WARM_CHUNK_DAYS - 1));
    const first = window.first && window.first > from ? window.first : from;
    const load = new WindowLoad(
      ctx,
      filter,
      [...SECTIONS],
      { tz: view.tz, first, last },
      base,
    );
    await load.prepare(signal);
    if (load.days.length === 0) break;
    while (!signal?.aborted && (await load.step(signal))) parts++;
    if (window.first && first <= window.first) break;
    last = addDays(first, -1);
  }
  return parts;
}

export async function warmViews(
  base: PrismaClient = metricsPrisma,
  signal?: AbortSignal,
): Promise<{ views: number; parts: number }> {
  const since = new Date(
    Date.now() - config.dashboardWarm.idleDays * 86_400_000,
  );
  const views = await asSuperAdminOn(base, (db) =>
    db.dashboardView.findMany({
      where: { openedAt: { gt: since } },
      select: { tenantId: true, filterKey: true, tz: true, spanDays: true },
      orderBy: { openedAt: "desc" },
    }),
  );
  let parts = 0;
  for (const v of views) {
    if (signal?.aborted) break;
    try {
      parts += await warmView(v, base, signal);
    } catch (error) {
      logger.warn(
        {
          error,
          tenantId: String(v.tenantId),
          filterKey: v.filterKey,
          tz: v.tz,
        },
        "dashboard warm: a view could not be kept warm; continuing",
      );
    }
  }
  return { views: views.length, parts };
}

interface Holder {
  timer: ReturnType<typeof setTimeout> | null;
  abort: AbortController | null;
  stopped: boolean;
}

const KEY = Symbol.for("fazerai.dashboardWarm");
function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder | undefined>;
  g[KEY] ??= { timer: null, abort: null, stopped: false };
  return g[KEY];
}

const FIRST_DELAY_MS = 60_000;

export function startDashboardWarm(): void {
  const h = holder();
  if (h.timer !== null || config.dashboardWarm.intervalMs === 0) return;
  h.stopped = false;
  const arm = (ms: number) => {
    h.timer = setTimeout(() => {
      const abort = new AbortController();
      h.abort = abort;
      const startedAt = Date.now();
      void warmViews(metricsPrisma, abort.signal)
        .then(({ views, parts }) => {
          if (parts > 0)
            logger.info(
              { views, parts, ms: Date.now() - startedAt },
              "dashboard warm: dropped days computed again",
            );
        })
        .catch((error) => logger.warn({ error }, "dashboard warm: pass failed"))
        .finally(() => {
          h.abort = null;
          if (!holder().stopped) arm(config.dashboardWarm.intervalMs);
        });
    }, ms);
    h.timer.unref?.();
  };
  arm(FIRST_DELAY_MS);
}

// Stops arming passes; the one in flight stops after its current part.
export function stopDashboardWarm(): void {
  const h = holder();
  h.stopped = true;
  h.abort?.abort();
  if (h.timer !== null) clearTimeout(h.timer);
  h.timer = null;
}
