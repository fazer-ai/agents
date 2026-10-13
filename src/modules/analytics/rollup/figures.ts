import type { PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import type { ScopedDb, TenantContext } from "@/lib/tenancy";
import type {
  FollowUpActivity,
  HandoffReasons,
  KnowledgeActivity,
  LabelOutcomes,
} from "../activity";
import type { BreakdownDimension, BreakdownRow } from "../breakdown";
import { type DashboardCosts, langfuseLink } from "../costs";
import type { HealthReport } from "../health";
import type { DashboardKpis } from "../service";
import type { OutcomeSeries, OutcomeTrend } from "../trends";
import {
  type Block,
  budgeted,
  type Progress,
  StaleDayError,
  type WindowLoad,
} from "./engine";
import { learnPgLerp } from "./lerp";
import {
  mergeBreakdown,
  mergeCosts,
  mergeFollowUps,
  mergeHandoffs,
  mergeHealth,
  mergeKnowledge,
  mergeKpis,
  mergeLabels,
  mergeTrend,
} from "./merge";

// Every block of the console from one window's days, the shape the stream sends after each part.
export interface DashboardFigures {
  kpis?: DashboardKpis;
  trend?: OutcomeTrend;
  series?: { agent: OutcomeSeries[]; inbox: OutcomeSeries[] };
  costs?: DashboardCosts;
  breakdown?: Record<BreakdownDimension, BreakdownRow[]>;
  handoffs?: HandoffReasons;
  labels?: LabelOutcomes;
  // Its problems are left out while the flow log's days are in only in part (`countable`).
  health?: Omit<HealthReport, "problems"> &
    Partial<Pick<HealthReport, "problems">>;
  followUps?: FollowUpActivity;
  knowledge?: KnowledgeActivity;
}

export interface DashboardSnapshot {
  progress: Progress;
  figures: DashboardFigures;
}

export async function figuresOf(
  ctx: TenantContext,
  load: WindowLoad,
  blocks: Block[],
  langfuse: DashboardCosts["langfuse"] = null,
  base: PrismaClient = metricsPrisma,
): Promise<DashboardFigures> {
  const w = { days: load.days };
  const want = new Set(blocks);
  const out: DashboardFigures = {};
  // A kept day changed under a percentile is computed again in memory; the merge then starts over, so
  // no figure mixes the day's old histogram with its new cells.
  // On what is left of a one-answer caller's budget (`load.deadline`); a stream's merge has its own.
  await budgeted(
    base,
    ctx,
    async (db) => {
      for (;;) {
        try {
          return await merge(db);
        } catch (error) {
          if (!(error instanceof StaleDayError)) throw error;
        }
      }
    },
    load.deadline,
  );
  return out;

  async function merge(db: ScopedDb) {
    // NOTE: first, because the percentiles below repeat the server's last-digit arithmetic.
    await learnPgLerp(db);
    const store = load.on(db);
    if (want.has("kpis")) out.kpis = await mergeKpis(store, w);
    // The blocks that count each conversation once, over the days that can say which day was first.
    const ledger = load.countable("ledger");
    // Each flow-log block over its own section's days, as its coverage reports them (`progress`).
    if (want.has("health")) {
      const log = load.countable("log", "log.problems");
      const h = await mergeHealth(store, w);
      out.health =
        log === load.days
          ? h
          : log
            ? {
                ...h,
                problems: (await mergeHealth(store, { days: log })).problems,
              }
            : { latency: h.latency };
    }
    if (want.has("followUps")) {
      const log = load.countable("log", "log.followups");
      out.followUps = log ? mergeFollowUps(store, { days: log }) : undefined;
    }
    if (want.has("knowledge")) out.knowledge = mergeKnowledge(store, w);
    if (want.has("outcomes")) {
      out.trend = await mergeTrend(db, store, w);
      out.series = {
        agent: (await mergeTrend(db, store, w, "agent")).series ?? [],
        inbox: (await mergeTrend(db, store, w, "inbox")).series ?? [],
      };
    }
    if (want.has("costs"))
      out.costs = ledger
        ? await mergeCosts(db, store, { days: ledger }, langfuse)
        : undefined;
    if (want.has("breakdown")) {
      const days = ledger ? { days: ledger } : null;
      out.breakdown = days
        ? {
            agent: await mergeBreakdown(db, store, days, "agent"),
            inbox: await mergeBreakdown(db, store, days, "inbox"),
            model: await mergeBreakdown(db, store, days, "model"),
            node: await mergeBreakdown(db, store, days, "node"),
          }
        : undefined;
    }
    if (want.has("handoffs")) {
      const log = load.countable("log", "log.handoffs");
      out.handoffs = log
        ? await mergeHandoffs(db, store, { days: log })
        : undefined;
    }
    if (want.has("labels")) out.labels = await mergeLabels(db, store, w);
  }
}

// On its own budget for a stream, whose request may have spent its own on the days computed before
// it; a caller that answers once reads it first, on its request's (`until`), before any day.
export async function costsLink(
  ctx: TenantContext,
  base: PrismaClient = metricsPrisma,
  until?: number,
): Promise<DashboardCosts["langfuse"]> {
  return ctx.tenantId === null
    ? null
    : langfuseLink(base, ctx, ctx.tenantId, fetch, (fn) =>
        budgeted(base, ctx, fn, until),
      );
}
