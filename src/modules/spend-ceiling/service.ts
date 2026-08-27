import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import type { UsageSource } from "@/graph/usage";
import { AppError, TenantTargetRequiredError } from "@/lib/errors";
import { runScopedOn, type ScopedDb, type TenantContext } from "@/lib/tenancy";
import { claimContactAuthNotice } from "@/modules/contact-auth/state";
import {
  emitFlowEvent,
  type FlowContext,
  type FlowEvent,
} from "@/modules/flowlog/service";
import {
  ceilingFor,
  decideSpend,
  monthStart,
  type SpendVerdict,
} from "./decide";
import {
  readSpendCeilingConfig,
  SPEND_CEILING_DEFAULTS,
  type SpendCeilingConfig,
} from "./settings";

// Reading the ledger, and asking ./decide.ts. Nothing here decides anything.

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// WHAT THE PROVIDER BILLED, which is prompt + completion. Cached reads are NOT added: they are a
// discounted subset of `promptTokens` and adding them would count the same token twice, moving the
// ceiling by however much the provider cache happened to serve. On the window measured in the issue
// that was 43% of the prompt tokens, so the error would not have been small.
//
// Read on the index that already exists, `(tenant_id, created_at)`, which is why there is no counter
// table here: a ceiling that needed a second source of truth would have to keep it correct, and the
// ledger already is.
//
// Measured on PostgreSQL 17, 1M ledger rows over 200 tenants and 90 days: median 1.3ms, on
// `llm_usage_tenant_id_created_at_idx` (bitmap index scan, 1111 rows). The SHAPE is what makes that
// number mean anything — seeding the same million rows under a SINGLE tenant gives 40ms and a
// parallel seq scan, because an index that selects the whole table is worth nothing to the planner.
// That is a fixture, not a fleet, and it is the wrong bound to quote; it is recorded here so the
// next person to measure does not think the index stopped working.
export async function sumUsageSince(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  since: Date,
): Promise<number> {
  const rows = await db.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(prompt_tokens + completion_tokens)::bigint AS total
        FROM llm_usage
       WHERE tenant_id = ${tenantId}
         AND source = ${source}
         AND created_at >= ${since}`;
  const total = rows[0]?.total ?? null;
  return total === null ? 0 : Number(total);
}

// The same read for a caller holding an id it took from a row (the webhook, the nudge, vision).
export async function tokensUsedSince(
  tenantId: bigint,
  source: UsageSource,
  since: Date,
  base: PrismaClient = basePrisma,
): Promise<number> {
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    sumUsageSince(db, tenantId, source, since),
  );
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

export type SpendCeilingResult = SpendVerdict & { cfg: SpendCeilingConfig };

// THE ASK, and what an unreadable answer means.
//
// A ceiling that cannot be read ALLOWS the turn. That is the opposite direction from the durable
// turn claim (#203), and deliberately: there the false answer let a writer erase a customer's
// message, here the false answer refuses to answer a customer who is waiting because our own
// database hiccuped. Losing a turn to protect a budget the operator may not even have configured is
// the worse of the two, and the ledger keeps recording either way, so the next message re-asks with
// nothing lost but the tokens of one turn.
export async function spendCeilingVerdict(
  params: SpendCeilingParams,
): Promise<SpendCeilingResult> {
  const base = params.base ?? basePrisma;
  let cfg = SPEND_CEILING_DEFAULTS;
  try {
    cfg = params.cfg ?? (await readTenantSpendCeiling(params.tenantId, base));
    if (!cfg.enabled) {
      return { state: "allowed", usedTokens: 0, ceilingTokens: null, cfg };
    }
    // NO CEILING ON THIS HALF ⇒ NO READ. `0` is the operator saying this source is unbounded, and
    // the sum below could only ever be compared against a ceiling that is not there. Asked before
    // the aggregate rather than after, because the common configuration is exactly this one: a
    // tenant that bounds only its playground would otherwise pay the monthly aggregate on every
    // customer message to learn a fact `cfg` already contains. `usedTokens` is 0 here and unread:
    // `decideSpend` reports `allowed` for a null ceiling whatever the count, and the console's own
    // numbers come from `spendCeilingUsage`, which always reads both halves.
    if (ceilingFor(cfg, params.source) === null) {
      return { state: "allowed", usedTokens: 0, ceilingTokens: null, cfg };
    }
    const since = monthStart(params.now ?? new Date());
    const usedTokens = await tokensUsedSince(
      params.tenantId,
      params.source,
      since,
      base,
    );
    return { ...decideSpend({ cfg, source: params.source, usedTokens }), cfg };
  } catch (err) {
    // The fail-open above, carried out. The catch wraps BOTH reads on purpose: the settings row and
    // the ledger sum fail the same way (a pool with no free connection, a statement timeout) and a
    // caller cannot be asked to tell them apart to know whether it may answer its customer.
    logger.warn(
      { err, tenantId: String(params.tenantId), source: params.source },
      "spend ceiling: could not be read; letting the call through",
    );
    return { state: "allowed", usedTokens: 0, ceilingTokens: null, cfg };
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

// HOW OFTEN THE WARNING IS SAID, which is not "once per message".
//
// `over` is a per-message fact: each refused customer is one turn that did not run, and the Logs
// page is where an operator counts them, exactly as the contact-auth gate does. `warning` is not.
// It describes the MONTH, it stays true for every message from the fraction to the ceiling, and the
// alert bus coalesces only a burst — it bumps a PENDING delivery and inserts a fresh one as soon as
// the worker has sent the last, so a busy tenant sitting at 85% would page its channels for the
// rest of the month about one unchanging fact.
//
// Six hours, and not `noticeCooldownSeconds`: that field is a per-CONVERSATION cooldown on what a
// customer sees, with a default of five minutes, and a monthly budget crossing is not something to
// be told twelve times an hour. In-process, like every other notice claim here, so a restart or a
// second replica re-announces once. That is the right failure direction for a warning: the cost is
// one extra message, and the alternative is a durable row for a line nobody is required to receive.
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

// WHAT, IF ANYTHING, TO WRITE. Separate from the emit below so the frequency rule can be proved
// without a database: `emitFlowEvent` writes an `ExecutionLog` row and offers no seam, so a test
// that went through it would be measuring Postgres.
//
// CLAIMING IS THE DECISION, which is why this is not a predicate: asking twice would consume the
// window twice, and a caller that asked before deciding would silence the line it was about to
// write. So it returns the event, or null, having already spent the window it needed.
export function spendCeilingAnnouncement(
  result: SpendVerdict,
  source: UsageSource,
  tenantId: bigint,
  now: Date = new Date(),
): FlowEvent | null {
  if (result.state === "allowed") return null;
  if (
    result.state === "warning" &&
    !claimContactAuthNotice(
      spendCeilingWarnKey(tenantId, source, now),
      SPEND_CEILING_WARN_COOLDOWN_MS,
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
  result: SpendVerdict,
  source: UsageSource,
  tenantId: bigint,
  now?: Date,
): void {
  // NOTE: the claim is spent only when there is somewhere to write, so a caller with no flow
  // context does not silently consume another caller's window.
  if (!flow) return;
  const ev = spendCeilingAnnouncement(result, source, tenantId, now);
  if (ev) emitFlowEvent(flow, ev);
}

// THE WARNING HALF ON ITS OWN, for a caller that runs BEFORE the gate that will refuse the same
// message. Vision is the only one (docs/spend-ceiling.md): it reads the incoming attachment before
// any gate has decided anything, so an `over` written here would put a second refusal row and a
// second alert bump on the Logs page for one customer message, and what this step did is already on
// its own `vision` line as `skipped` with `spend_ceiling` as the reason.
//
// The WARNING is not symmetric with that, which is what made silence here wrong. It leaves no trace
// anywhere else: the call proceeds, the attachment is read, and nothing says the month crossed its
// fraction. And on a message no gate ever reaches — a human-owned conversation, a silenced agent, a
// redirect, an hour outside the schedule — this is the only place that could have said it. It
// cannot double-write either: the window is claimed once, so a gate that follows and asks the same
// question writes nothing.
export function announceSpendCeilingWarning(
  flow: FlowContext | undefined,
  result: SpendVerdict,
  source: UsageSource,
  tenantId: bigint,
  now?: Date,
): void {
  if (result.state !== "warning") return;
  announceSpendCeiling(flow, result, source, tenantId, now);
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
      usedTokens: result.usedTokens,
      ceilingTokens: result.ceilingTokens ?? 0,
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
      "the playground token ceiling for this month has been reached",
      429,
      "errors.spendCeilingReached",
    );
  }
  return result;
}

export interface SpendCeilingUsageEntry {
  source: UsageSource;
  usedTokens: number;
  // null = no ceiling applies to this half (the block is off, or the number is 0).
  ceilingTokens: number | null;
  state: SpendVerdict["state"];
}

export interface SpendCeilingUsageDto {
  // Start of the calendar month the counts cover, in UTC. Sent so the console can label the period
  // instead of guessing it from the browser's own clock, which sits in another timezone often
  // enough that "this month" would silently mean a different window than the gate's.
  periodStart: string;
  entries: SpendCeilingUsageEntry[];
}

// WHAT THE CONSOLE SHOWS. Both halves, always, and with the counts present even when the block is
// off: an operator deciding what to set the ceiling to needs last month's shape more than anyone,
// and a screen that shows nothing until a ceiling exists asks them to pick a number blind.
// Takes the REQUEST's context, never an id lifted out of it. Every other reader here is an internal
// caller holding an id it read from a row, which is the distinction the fence in
// tests/modules/tenant-selector-entry-points.test.ts draws: a controller that unwraps its context
// tells `runScopedOn` that a caller's stale selection was internal, and a dead tenant then comes
// back as an empty screen instead of a refusal naming the selection (#268).
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
  const since = monthStart(params.now ?? new Date());
  const sources: UsageSource[] = ["inbox", "playground"];
  const entries = await Promise.all(
    sources.map(async (source): Promise<SpendCeilingUsageEntry> => {
      const usedTokens = await runScopedOn(base, params.ctx, (db) =>
        sumUsageSince(db, tenantId, source, since),
      );
      const verdict = decideSpend({ cfg, source, usedTokens });
      return {
        source,
        usedTokens,
        ceilingTokens: verdict.ceilingTokens,
        state: verdict.state,
      };
    }),
  );
  return { periodStart: since.toISOString(), entries };
}
