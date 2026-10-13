import type { PrismaClient } from "@/../generated/prisma/client";
import metricsPrisma from "@/api/lib/prisma-metrics";
import type { TenantContext } from "@/lib/tenancy";
import {
  getFollowUpActivity,
  getHandoffReasons,
  getKnowledgeActivity,
  getLabelOutcomes,
} from "../activity";
import { getBreakdown } from "../breakdown";
import { getDashboardCosts } from "../costs";
import type { DashboardFilter } from "../filter";
import { getHealth } from "../health";
import { getKpis } from "../service";
import { getOutcomeTrend } from "../trends";
import {
  alignedDays,
  BLOCK_SECTIONS,
  type Block,
  type Progress,
  WindowLoad,
} from "./engine";
import { costsLink, type DashboardFigures, figuresOf } from "./figures";
import type { Section } from "./sections";

const HEARTBEAT_MS = 4_000;

// How long the stream stays quiet before it says it is still working. A test replaces `wait`.
export const heartbeat = { wait: () => Bun.sleep(HEARTBEAT_MS) };

export const BLOCKS: Block[] = [
  "kpis",
  "outcomes",
  "costs",
  "breakdown",
  "handoffs",
  "labels",
  "health",
  "followUps",
  "knowledge",
];

export type StreamEvent =
  // Before the window's days are known (the queue settling, a connection awaited): only alive.
  | { kind: "waiting" }
  | { kind: "computing"; progress: Progress }
  | {
      kind: "snapshot";
      progress: Progress;
      figures: DashboardFigures;
      done: boolean;
    };

// The console's view of a window as it fills: what is kept first, then the figures again after every
// part, today's and yesterday's parts before the older ones. Stops when `signal` aborts (the viewer
// left or changed the view); a part already running finishes and is kept for the next request.
export async function* streamFigures(
  ctx: TenantContext,
  filter: DashboardFilter,
  blocks: Block[],
  signal?: AbortSignal,
  base: PrismaClient = metricsPrisma,
): AsyncGenerator<StreamEvent> {
  const w = alignedDays(filter);
  const waiting = (): StreamEvent => ({ kind: "waiting" });
  if (!w) {
    yield* beating(
      liveFigures(ctx, filter, blocks, base).then((figures) => ({
        kind: "snapshot",
        progress: settled(0),
        figures,
        done: true,
      })),
      waiting,
    );
    return;
  }
  const sections = [
    ...new Set(blocks.flatMap((b) => BLOCK_SECTIONS[b])),
  ] as Section[];
  const load = new WindowLoad(ctx, filter, sections, w, base);
  let langfuse: Awaited<ReturnType<typeof costsLink>> = null;
  yield* beating(
    (async () => {
      await load.prepare(signal);
      if (signal?.aborted) return null;
      if (blocks.includes("costs")) langfuse = await costsLink(ctx, base);
      return null;
    })(),
    waiting,
  );
  if (signal?.aborted) return;
  const snapshot = async (): Promise<StreamEvent> => ({
    kind: "snapshot",
    progress: load.progress(),
    figures: await figuresOf(ctx, load, blocks, langfuse, base),
    done: load.done(),
  });
  const idle = (): StreamEvent => ({
    kind: "computing",
    progress: load.progress(),
  });
  yield* beating(snapshot(), idle);
  while (!load.done()) {
    if (signal?.aborted) return;
    const computing: StreamEvent = {
      kind: "computing",
      progress: { ...load.progress(), computing: load.next() },
    };
    yield computing;
    yield* beating(
      load.step(signal).then(() => null),
      () => computing,
    );
    if (signal?.aborted) return;
    yield* beating(snapshot(), idle);
  }
}

// What `work` yields once it settles, with `beat` said every few seconds until then: an idle
// connection is closed by the server (Bun's idle timeout is 10 s) and by proxies, and a part, or the
// merge of a snapshot waiting for a connection, may take most of the budget.
async function* beating(
  work: Promise<StreamEvent | null>,
  beat: () => StreamEvent,
): AsyncGenerator<StreamEvent> {
  let settled = false;
  const done = work.finally(() => {
    settled = true;
  });
  while (!settled) {
    await Promise.race([done.catch(() => null), heartbeat.wait()]);
    if (!settled) yield beat();
  }
  const out = await done;
  if (out) yield out;
}

function settled(days: number): Progress {
  const c = { total: days, ready: days, noData: 0, gaps: [] };
  return {
    total: days,
    ready: days,
    computing: null,
    pending: [],
    families: { conv: c, ledger: c, log: c, know: c },
  };
}

// The same figures from the live readers, for a window the kept days cannot answer (one that does not
// start and end on local midnights).
async function liveFigures(
  ctx: TenantContext,
  f: DashboardFilter,
  blocks: Block[],
  base: PrismaClient,
): Promise<DashboardFigures> {
  const out: DashboardFigures = {};
  const want = new Set(blocks);
  if (want.has("kpis")) out.kpis = await getKpis(ctx, f, base);
  if (want.has("outcomes")) {
    out.trend = await getOutcomeTrend(ctx, f, undefined, base);
    out.series = {
      agent: (await getOutcomeTrend(ctx, f, "agent", base)).series ?? [],
      inbox: (await getOutcomeTrend(ctx, f, "inbox", base)).series ?? [],
    };
  }
  if (want.has("costs")) out.costs = await getDashboardCosts(ctx, f, base);
  if (want.has("breakdown"))
    out.breakdown = {
      agent: await getBreakdown(ctx, f, "agent", base),
      inbox: await getBreakdown(ctx, f, "inbox", base),
      model: await getBreakdown(ctx, f, "model", base),
      node: await getBreakdown(ctx, f, "node", base),
    };
  if (want.has("handoffs"))
    out.handoffs = await getHandoffReasons(ctx, f, base);
  if (want.has("labels")) out.labels = await getLabelOutcomes(ctx, f, base);
  if (want.has("health")) out.health = await getHealth(ctx, f, base);
  if (want.has("followUps"))
    out.followUps = await getFollowUpActivity(ctx, f, base);
  if (want.has("knowledge"))
    out.knowledge = await getKnowledgeActivity(ctx, f, base);
  return out;
}
