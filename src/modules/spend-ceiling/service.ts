import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import config from "@/config";
import type { UsageSource } from "@/graph/usage";
import { AppError, TenantTargetRequiredError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { claimContactAuthNotice } from "@/modules/contact-auth/state";
import {
  emitFlowEvent,
  type FlowContext,
  type FlowEvent,
} from "@/modules/flowlog/service";
import {
  ceilingFor,
  decideSpend,
  monthEnd,
  monthStart,
  projectMonthEnd,
  type SpendVerdict,
} from "./decide";
import {
  readSpendCeilingConfig,
  SPEND_CEILING_DEFAULTS,
  type SpendCeilingConfig,
} from "./settings";

// Reading the snapshot, and asking ./decide.ts. Nothing here decides anything.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// WHAT THE POLL LAST KNEW about one (tenant, source, month): the figure the gate decides on, and its
// health. `costUsd` is the ledger's priced cost for the month at the last poll; `polledAt` that
// poll; the `pollError` pair the last failure, which never overwrites the figure.
export interface SpendSnapshot {
  costUsd: number;
  polledAt: Date | null;
  pollError: string | null;
  pollFailedAt: Date | null;
}

// THE MONTH IS THE ARGUMENT, not one edge of it. `at` is any instant inside the month being asked
// about and the key is derived here, which is the only reason no caller can name the wrong month by
// accident: an instant captured at 23:59:59.9 and a read that runs at 00:00:00.1 would otherwise
// answer the NEW month's row for the OLD month's verdict, and the tenant whose budget just reset
// would be refused on the strength of it. Rare by the clock and certain over a fleet.
export async function readSpendSnapshot(
  tenantId: bigint,
  source: UsageSource,
  at: Date,
  base: PrismaClient = basePrisma,
): Promise<SpendSnapshot | null> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.spendCostSnapshot.findUnique({
      where: {
        tenantId_source_monthStart: {
          tenantId,
          source,
          monthStart: monthStart(at),
        },
      },
    }),
  );
  if (!row) return null;
  return {
    costUsd: Number(row.costUsd),
    polledAt: row.polledAt,
    pollError: row.pollError,
    pollFailedAt: row.pollFailedAt,
  };
}

// The figure alone, for a caller holding an id it took from a row. A month with no row is a month
// nobody has polled: nothing is known, and nothing known is nothing spent.
export async function spendUsedInMonth(
  tenantId: bigint,
  source: UsageSource,
  at: Date,
  base: PrismaClient = basePrisma,
): Promise<number> {
  return (await readSpendSnapshot(tenantId, source, at, base))?.costUsd ?? 0;
}

// WHEN A FIGURE STOPS BEING FRESH: three missed polls. Under that the gate keeps deciding on the
// last good figure regardless, but past it the console says so out loud and the alert line has
// already fired. Derived from the cadence rather than fixed, so an operator who polls every minute
// is told about a three-minute silence.
export const SPEND_SNAPSHOT_STALE_AFTER_MS =
  3 * config.spendCeiling.pollIntervalMs;

export function spendPollIntervalMs(): number {
  return config.spendCeiling.pollIntervalMs;
}

export interface SpendSnapshotHealth {
  polledAt: Date | null;
  pollError: string | null;
  pollFailedAt: Date | null;
  stale: boolean;
}

export function snapshotHealth(
  row: SpendSnapshot,
  now: Date,
  staleAfterMs: number = SPEND_SNAPSHOT_STALE_AFTER_MS,
): SpendSnapshotHealth {
  return {
    polledAt: row.polledAt,
    pollError: row.pollError,
    pollFailedAt: row.pollFailedAt,
    stale:
      row.polledAt === null ||
      now.getTime() - row.polledAt.getTime() > staleAfterMs,
  };
}

export interface SpendCeilingParams {
  tenantId: bigint;
  source: UsageSource;
  base?: PrismaClient;
  // Injectable clock, so a test can sit on a month boundary without waiting for one.
  now?: Date;
  // Already-read settings, when the caller has them. Saves a read on the turn path.
  cfg?: SpendCeilingConfig;
}

// THE VERDICT CARRIES THE INSTANT IT WAS EVALUATED AT: everything downstream is about a MONTH, and
// a verdict read at 23:59:59.9 and announced at 00:00:00.1 must report the month it was read in.
// Carried in the value so none of the gates has to remember to pass a `now`. `snapshot` is null
// where no row was read (block off, no ceiling on this half, month not polled yet).
export type SpendCeilingResult = SpendVerdict & {
  cfg: SpendCeilingConfig;
  evaluatedAt: Date;
  snapshot: SpendSnapshotHealth | null;
};

// THE ASK. A ceiling that cannot be read ALLOWS the turn: refusing a waiting customer because our
// own database hiccuped is worse than one turn's cost, and the poll keeps writing either way, so the
// next message re-asks with nothing else lost.
export async function spendCeilingVerdict(
  params: SpendCeilingParams,
): Promise<SpendCeilingResult> {
  const base = params.base ?? basePrisma;
  const evaluatedAt = params.now ?? new Date();
  let cfg = SPEND_CEILING_DEFAULTS;
  try {
    cfg = params.cfg ?? (await readTenantSpendCeiling(params.tenantId, base));
    if (!cfg.enabled) {
      return {
        state: "allowed",
        usedUsd: 0,
        ceilingUsd: null,
        cfg,
        evaluatedAt,
        snapshot: null,
      };
    }
    // NO CEILING ON THIS HALF ⇒ NO READ. `0` is the operator saying this source is unbounded, and
    // the row below could only ever be compared against a ceiling that is not there. Asked before
    // the read rather than after, because the common configuration is exactly this one: a tenant
    // that bounds only its playground would otherwise pay a read on every customer message to learn
    // a fact `cfg` already contains. `usedUsd` is 0 here and unread: `decideSpend` reports
    // `allowed` for a null ceiling whatever the figure, and the console's own numbers come from
    // `spendCeilingUsage`, which always reads both halves.
    if (ceilingFor(cfg, params.source) === null) {
      return {
        state: "allowed",
        usedUsd: 0,
        ceilingUsd: null,
        cfg,
        evaluatedAt,
        snapshot: null,
      };
    }
    const row = await readSpendSnapshot(
      params.tenantId,
      params.source,
      evaluatedAt,
      base,
    );
    const snapshot = row ? snapshotHealth(row, evaluatedAt) : null;
    return {
      ...decideSpend({
        cfg,
        source: params.source,
        usedUsd: row?.costUsd ?? 0,
      }),
      cfg,
      evaluatedAt,
      snapshot,
    };
  } catch (err) {
    // The fail-open above, carried out. The catch wraps BOTH reads on purpose: the settings row and
    // the snapshot fail the same way (a pool with no free connection, a statement timeout) and a
    // caller cannot be asked to tell them apart to know whether it may answer its customer.
    logger.warn(
      { err, tenantId: String(params.tenantId), source: params.source },
      "spend ceiling: could not be read; letting the call through",
    );
    return {
      state: "allowed",
      usedUsd: 0,
      ceilingUsd: null,
      cfg,
      evaluatedAt,
      snapshot: null,
    };
  }
}

export async function readTenantSpendCeiling(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<SpendCeilingConfig> {
  const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    }),
  );
  return readSpendCeilingConfig(row?.settings ?? {});
}

// HOW OFTEN THE WARNING IS SAID. `over` is per message (one refused turn, counted on the Logs page);
// `warning` describes the MONTH and stays true from the fraction to the ceiling, and the alert bus
// only coalesces a burst. So it is claimed once per six hours per (tenant, source), not per
// `noticeCooldownSeconds` (a per-conversation cooldown on what a customer sees). In-process, so a
// restart re-announces once, which is the right failure direction for a warning.
export const SPEND_CEILING_WARN_COOLDOWN_MS = 6 * 60 * 60 * 1000;

export function spendCeilingWarnKey(
  tenantId: bigint,
  source: UsageSource,
  now: Date,
): string {
  // THE MONTH IS PART OF THE IDENTITY, because the warning is a statement ABOUT a month: "this
  // month's budget is 80% spent". A window that outlived the rollover would suppress the first
  // warning of a month whose ledger reads zero, on the strength of a sentence about a month that
  // has ended. Six hours is longer than the gap between 23:xx and 00:xx by construction, so the
  // overlap is not a corner: it is every rollover in which a tenant was already past its fraction.
  // The month start ITSELF, not a cut of it: `monthStart` already normalises everything past the
  // month away, so the whole timestamp is the month, and a bare slice here would be one more entry
  // in the astral-cap ledger for nothing.
  return `spend_ceiling_warn:${tenantId}:${source}:${monthStart(now).toISOString()}`;
}

// WHAT, IF ANYTHING, TO WRITE, separate from the emit so the frequency rule is testable without a
// database. CLAIMING IS THE DECISION: it returns the event or null having already spent the window,
// so asking twice would consume it twice.
// The occasion makes the `over` line one per refused OCCASION, not per ask: Chatwoot fans one message
// to two bots (two concurrent deliveries), and a repairable nudge refusal is rescheduled many times
// against the same wall. Only the caller knows what an occasion is: a message id for a delivery, the
// conversation for a scheduled job.
export interface SpendCeilingOccasion {
  key: string;
  windowMs: number;
}

// Long enough to outlast the fan-out of one message, which is two deliveries racing in the same
// second. The size barely matters and a fixed one is deliberate: the key already carries the message
// id, so this can never suppress a line about a different message, and reading it off
// `noticeCooldownSeconds` would let an operator who set that to 0 switch the de-duplication off
// without knowing they had.
export const SPEND_CEILING_MESSAGE_WINDOW_MS = 60_000;

// THE SCHEDULER'S OWN LADDER, for the occasion a debounce flush refuses: a job that throws after
// writing the refusal is re-pended and runs again on the SAME burst. Ten minutes covers the
// scheduler's retry ladder (`MAX_ATTEMPTS`, `backoffMs`) several times over, and the key carries the
// burst's conversation and last message id, so it never suppresses a line about a different burst.
export const SPEND_CEILING_BURST_WINDOW_MS = 10 * 60 * 1000;

export function spendCeilingOverKey(
  tenantId: bigint,
  source: UsageSource,
  occasion: string,
): string {
  return `spend_ceiling_over:${tenantId}:${source}:${occasion}`;
}

export function spendCeilingAnnouncement(
  result: SpendVerdict & { evaluatedAt?: Date },
  source: UsageSource,
  tenantId: bigint,
  occasion?: SpendCeilingOccasion,
): FlowEvent | null {
  if (result.state === "allowed") return null;
  // The verdict's own instant, so the window this claims belongs to the month the figures describe.
  const now = result.evaluatedAt ?? new Date();
  if (
    result.state === "warning" &&
    !claimContactAuthNotice(
      spendCeilingWarnKey(tenantId, source, now),
      SPEND_CEILING_WARN_COOLDOWN_MS,
    )
  ) {
    return null;
  }
  if (
    result.state === "over" &&
    occasion &&
    !claimContactAuthNotice(
      spendCeilingOverKey(tenantId, source, occasion.key),
      occasion.windowMs,
    )
  ) {
    return null;
  }
  return spendCeilingFlowEvent(result, source);
}

// THE ONE PLACE THE GATES ANNOUNCE FROM. Four callers ask the ceiling (the webhook, the nudge, the
// two vision entries and the playground through `assertPlaygroundSpendCeiling`), and a rule about
// how often a line is written is the shape that ends up applied in three of them.
export function announceSpendCeiling(
  flow: FlowContext | undefined,
  result: SpendVerdict & { evaluatedAt?: Date },
  source: UsageSource,
  tenantId: bigint,
  occasion?: SpendCeilingOccasion,
): void {
  // NOTE: the claim is spent only when there is somewhere to write, so a caller with no flow
  // context does not silently consume another caller's window.
  if (!flow) return;
  const ev = spendCeilingAnnouncement(result, source, tenantId, occasion);
  if (ev) emitFlowEvent(flow, ev);
}

// THE WARNING HALF ON ITS OWN, for vision, which runs BEFORE the gate that will refuse the same
// message: an `over` here would double the refusal row, and vision's own line already says
// `skipped`. The warning has no other trace, and on a message no gate reaches this is the only place
// that can say it. It cannot double-write: the window is claimed once, so a later gate writes nothing.
export function announceSpendCeilingWarning(
  flow: FlowContext | undefined,
  result: SpendVerdict & { evaluatedAt?: Date },
  source: UsageSource,
  tenantId: bigint,
): void {
  if (result.state !== "warning") return;
  announceSpendCeiling(flow, result, source, tenantId);
}

// The line the operator reads. `warning` is what makes this useful BEFORE the agent goes quiet,
// which is the whole point of the fraction: an `error` that only ever fires at the ceiling tells
// somebody their month already ended.
export function spendCeilingFlowEvent(
  result: SpendVerdict,
  source: UsageSource,
): FlowEvent {
  return {
    stage: "spend_ceiling",
    level: result.state === "over" ? "error" : "warn",
    status: result.state === "over" ? "skipped" : "ok",
    detail: {
      source,
      usedUsd: result.usedUsd,
      ceilingUsd: result.ceilingUsd ?? 0,
      state: result.state,
    },
  };
}

// THE PLAYGROUND'S REFUSAL, in one place because it is one sentence said in three (a text turn, a
// simulated follow-up, a file the operator uploads). A duplicated `throw` is how the third one ends
// up with a different status code, and the operator then sees the same wall described two ways.
//
// It throws instead of going quiet, unlike every customer-facing path: the operator is looking at
// the screen and a turn that produced nothing would read as a broken provider, not as a budget.
export async function assertPlaygroundSpendCeiling(params: {
  tenantId: bigint;
  base?: PrismaClient;
  flow?: FlowContext;
  now?: Date;
}): Promise<SpendCeilingResult> {
  const result = await spendCeilingVerdict({
    tenantId: params.tenantId,
    source: "playground",
    base: params.base,
    now: params.now,
  });
  announceSpendCeiling(params.flow, result, "playground", params.tenantId);
  if (result.state === "over") {
    throw new AppError(
      "the playground spend ceiling for this month has been reached",
      429,
      "errors.spendCeilingReached",
    );
  }
  return result;
}

export interface SpendCeilingUsageEntry {
  source: UsageSource;
  usedUsd: number;
  // null = no ceiling applies to this half (the block is off, or the number is 0).
  ceilingUsd: number | null;
  state: SpendVerdict["state"];
  // The figure's health, ISO instants: when it was last refreshed, and the last failure if the poll
  // is failing now. `stale` past three missed polls. With the ceiling off the figure is summed at
  // read time, so it is as fresh as the request.
  polledAt: string | null;
  pollError: string | null;
  pollFailedAt: string | null;
  stale: boolean;
  // Calls this month the ledger could not price, which the figure leaves out, and their models.
  unpricedCalls: number;
  unpricedModels: string[];
  // The month-end figure at the pace of the days elapsed (`projectMonthEnd`), from `usedUsd`.
  projectedUsd: number;
}

export interface SpendCeilingUsageDto {
  // Whether the ceiling is on. Off, the figures are still read and shown, and nothing is enforced
  // on them, so the console drops every line that speaks of enforcement.
  enabled: boolean;
  // Start of the calendar month the figures cover, in UTC. Sent so the console can label the period
  // instead of guessing it from the browser's own clock, which sits in another timezone often
  // enough that "this month" would silently mean a different window than the gate's.
  periodStart: string;
  // A ceiling this block was given in tokens before the unit changed, never enforced: see
  // `SpendCeilingConfig.legacyTokens`.
  legacyTokens: SpendCeilingConfig["legacyTokens"];
  // The poll cadence, so the console can say how old a figure may be at most.
  pollIntervalMs: number;
  entries: SpendCeilingUsageEntry[];
}

// WHAT THE CONSOLE SHOWS: both halves, always, with figures even when the block is off, so an
// operator picking a ceiling sees the month's shape. With the ceiling on the figure is the snapshot,
// because the bar shows what the gate decides on; off, it is the ledger summed now, since no poll
// runs. Takes the REQUEST's context, never an id lifted out of it, so a stale tenant selection is
// refused rather than read as an empty screen (see tests/modules/tenant-selector-entry-points.test.ts).
export async function spendCeilingUsage(params: {
  ctx: TenantContext;
  base?: PrismaClient;
  now?: Date;
  cfg?: SpendCeilingConfig;
}): Promise<SpendCeilingUsageDto> {
  const base = params.base ?? basePrisma;
  if (params.ctx.tenantId === null) {
    throw new TenantTargetRequiredError();
  }
  const tenantId = params.ctx.tenantId;
  const cfg = params.cfg ?? (await readTenantSpendCeiling(tenantId, base));
  // ONE INSTANT FOR BOTH HALVES AND FOR THE HEADER, so the two sources and the `periodStart` the
  // console prints above them can never name different months when the request straddles midnight.
  const at = params.now ?? new Date();
  const since = monthStart(at);
  const until = monthEnd(at);
  const sources: UsageSource[] = ["inbox", "playground"];
  const pollIntervalMs = spendPollIntervalMs();
  const entries = await runScopedOn(base, params.ctx, (db) =>
    Promise.all(
      sources.map(async (source): Promise<SpendCeilingUsageEntry> => {
        const month = {
          tenantId,
          source,
          createdAt: { gte: since, lt: until },
        };
        const unpriced = await db.llmUsage.groupBy({
          by: ["model"],
          where: { ...month, costUsd: null },
          _count: { _all: true },
        });
        const unpricedFields = {
          unpricedCalls: unpriced.reduce((n, g) => n + g._count._all, 0),
          unpricedModels: unpriced.map((g) => g.model).sort(),
        };
        if (!cfg.enabled) {
          const live = await db.llmUsage.aggregate({
            where: month,
            _sum: { costUsd: true },
          });
          const usedUsd = Number(live._sum.costUsd ?? 0);
          return {
            source,
            usedUsd,
            ceilingUsd: null,
            state: "allowed",
            polledAt: at.toISOString(),
            pollError: null,
            pollFailedAt: null,
            stale: false,
            ...unpricedFields,
            projectedUsd: projectMonthEnd(usedUsd, at),
          };
        }
        const row = await db.spendCostSnapshot.findUnique({
          where: {
            tenantId_source_monthStart: { tenantId, source, monthStart: since },
          },
        });
        const snapshot: SpendSnapshot | null = row
          ? {
              costUsd: Number(row.costUsd),
              polledAt: row.polledAt,
              pollError: row.pollError,
              pollFailedAt: row.pollFailedAt,
            }
          : null;
        const verdict = decideSpend({
          cfg,
          source,
          usedUsd: snapshot?.costUsd ?? 0,
        });
        const health = snapshot
          ? snapshotHealth(snapshot, at, 3 * pollIntervalMs)
          : null;
        return {
          source,
          usedUsd: snapshot?.costUsd ?? 0,
          ceilingUsd: verdict.ceilingUsd,
          // What the gate would answer, which is what the bar is for.
          state: verdict.state,
          polledAt: health?.polledAt?.toISOString() ?? null,
          pollError: health?.pollError ?? null,
          pollFailedAt: health?.pollFailedAt?.toISOString() ?? null,
          // Nothing read is nothing fresh: a month with no row is one the gate lets through.
          stale: health?.stale ?? true,
          ...unpricedFields,
          projectedUsd: projectMonthEnd(snapshot?.costUsd ?? 0, at),
        };
      }),
    ),
  );
  return {
    enabled: cfg.enabled,
    periodStart: since.toISOString(),
    legacyTokens: cfg.legacyTokens,
    pollIntervalMs,
    entries,
  };
}
