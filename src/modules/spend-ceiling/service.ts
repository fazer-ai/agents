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
  monthEnd,
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
// THE MONTH IS THE ARGUMENT, not one edge of it. `at` is any instant inside the month being asked
// about and BOTH bounds are derived here, which is the only reason no caller can build a half-open
// window by accident. It used to take a `since` and no upper bound, and that was defensible while
// the instant was always "now" — a month with no future has nothing above it to exclude. It stopped
// being defensible when the verdict started carrying `evaluatedAt`: an instant captured at
// 23:59:59.9 and a query that runs at 00:00:00.1 would count the NEW month's rows against the OLD
// month's ceiling, and the tenant whose budget just reset would be refused on the strength of it.
// Rare by the clock and certain over a fleet, since every tenant crosses this boundary every month.
export async function sumUsageInMonth(
  db: ScopedDb,
  tenantId: bigint,
  source: UsageSource,
  at: Date,
): Promise<number> {
  const since = monthStart(at);
  const until = monthEnd(at);
  const rows = await db.$queryRaw<{ total: bigint | null }[]>`
      SELECT SUM(prompt_tokens + completion_tokens)::bigint AS total
        FROM llm_usage
       WHERE tenant_id = ${tenantId}
         AND source = ${source}
         AND created_at >= ${since}
         AND created_at < ${until}`;
  const total = rows[0]?.total ?? null;
  return total === null ? 0 : Number(total);
}

// The same read for a caller holding an id it took from a row (the webhook, the nudge, vision).
export async function tokensUsedInMonth(
  tenantId: bigint,
  source: UsageSource,
  at: Date,
  base: PrismaClient = basePrisma,
): Promise<number> {
  return runScopedOn(base, sysCtx(tenantId), (db) =>
    sumUsageInMonth(db, tenantId, source, at),
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

// THE VERDICT CARRIES THE INSTANT IT WAS EVALUATED AT, because everything downstream of it is about
// a MONTH and the answer to "which month" is this timestamp, not the one the reader happens to hold.
// A verdict read at 23:59:59.9 and announced at 00:00:00.1 would otherwise report the old month's
// figures under the new month's warning key, and burn the new month's first window on a sentence
// about the month that ended. Carried in the value rather than asked of every caller: five gates ask
// this question, and a `now` each of them has to remember to pass on is the one the sixth forgets.
export type SpendCeilingResult = SpendVerdict & {
  cfg: SpendCeilingConfig;
  evaluatedAt: Date;
};

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
  const evaluatedAt = params.now ?? new Date();
  let cfg = SPEND_CEILING_DEFAULTS;
  try {
    cfg = params.cfg ?? (await readTenantSpendCeiling(params.tenantId, base));
    if (!cfg.enabled) {
      return {
        state: "allowed",
        usedTokens: 0,
        ceilingTokens: null,
        cfg,
        evaluatedAt,
      };
    }
    // NO CEILING ON THIS HALF ⇒ NO READ. `0` is the operator saying this source is unbounded, and
    // the sum below could only ever be compared against a ceiling that is not there. Asked before
    // the aggregate rather than after, because the common configuration is exactly this one: a
    // tenant that bounds only its playground would otherwise pay the monthly aggregate on every
    // customer message to learn a fact `cfg` already contains. `usedTokens` is 0 here and unread:
    // `decideSpend` reports `allowed` for a null ceiling whatever the count, and the console's own
    // numbers come from `spendCeilingUsage`, which always reads both halves.
    if (ceilingFor(cfg, params.source) === null) {
      return {
        state: "allowed",
        usedTokens: 0,
        ceilingTokens: null,
        cfg,
        evaluatedAt,
      };
    }
    const usedTokens = await tokensUsedInMonth(
      params.tenantId,
      params.source,
      evaluatedAt,
      base,
    );
    return {
      ...decideSpend({ cfg, source: params.source, usedTokens }),
      cfg,
      evaluatedAt,
    };
  } catch (err) {
    // The fail-open above, carried out. The catch wraps BOTH reads on purpose: the settings row and
    // the ledger sum fail the same way (a pool with no free connection, a statement timeout) and a
    // caller cannot be asked to tell them apart to know whether it may answer its customer.
    logger.warn(
      { err, tenantId: String(params.tenantId), source: params.source },
      "spend ceiling: could not be read; letting the call through",
    );
    return {
      state: "allowed",
      usedTokens: 0,
      ceilingTokens: null,
      cfg,
      evaluatedAt,
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
// WHAT THE REFUSAL IS ABOUT, so the `over` line is one per refused OCCASION rather than one per ask.
// The docs promise one line per refused customer message, and the two ways that promise broke are
// both repetition the traffic does not explain:
//
//   - the same MESSAGE asked twice. Chatwoot fans one incoming message to the conversation's
//     assigned agent bot AND to the inbox's, which is two deliveries with two ids running
//     concurrently, so one refused customer produced two rows and two alert deliveries.
//   - the same OCCASION asked eight times. `over-ceiling` is a repairable nudge refusal, so the
//     caller reschedules it every fifteen minutes for two hours against a wall that is temporary by
//     construction; a tenant holding fifty pending jobs paged the channels four hundred times about
//     one unchanging fact.
//
// The caller names the occasion because only it knows what one is: a message id for a delivery, the
// conversation for a scheduled job whose ladder spans two hours. Same reasoning as the warning's own
// window, with the subject moved from the month to the thing being refused.
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

// THE SCHEDULER'S OWN LADDER, for the occasion a debounce flush refuses. A claimed job that throws
// after the refusal has been written — advancing the watermark is the last thing it does, and that
// is a database write — is re-pended with a backoff and runs again on the SAME burst, so without a
// window one refused burst writes one `error` line and pages the alert channels once per attempt.
//
// Sized off the scheduler rather than guessed: `MAX_ATTEMPTS` is 5 and `backoffMs` is full-jitter on
// a 2s base with the exponent clamped, so four retries are spaced at most 4s + 8s + 16s + 32s. Ten
// minutes covers that ladder several times over, which is the right direction to be wrong in — the
// key carries the burst's own conversation and last message id, so a window this long can never
// suppress a line about a DIFFERENT burst, and the next burst carries a later id by construction.
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
  // ONE INSTANT FOR BOTH HALVES AND FOR THE HEADER, so the two sources and the `periodStart` the
  // console prints above them can never name different months when the request straddles midnight.
  const at = params.now ?? new Date();
  const since = monthStart(at);
  const sources: UsageSource[] = ["inbox", "playground"];
  const entries = await Promise.all(
    sources.map(async (source): Promise<SpendCeilingUsageEntry> => {
      const usedTokens = await runScopedOn(base, params.ctx, (db) =>
        sumUsageInMonth(db, tenantId, source, at),
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
