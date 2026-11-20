#!/usr/bin/env bun

// Re-prices ledger rows (`llm_usage.cost_usd`) with the price table in the tree now, for when the
// table that priced them was wrong. Dry run unless `--apply`, which then settles the dashboard sums it
// changed (docs/dashboard.md, "Late changes").
//   bun scripts/reprice-usage.ts --tenant <id|all> --provider <provider> --model <model>
//     [--from <ISO date>] [--to <ISO date>] [--price-table <litellm@…|none>] [--apply]
// `--provider` is required because the ledger does not record it. `--from` is inclusive, `--to`
// exclusive; `--price-table none` selects rows no table priced. Pricing order: pricing/reprice.ts.

import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  connectTimeoutOption,
  lockTimeoutOption,
} from "@/api/lib/pool-options";
import {
  assertRuntimeRoleIsNotSuperuser,
  RuntimeIsolationError,
} from "@/lib/db-guard";
import { withSessionOptions } from "@/lib/session-zone";
import { asSuperAdminOn } from "@/lib/tenancy";
import { stepLedgerSums } from "@/modules/analytics/ledger-sums";
import { PRICE_OVERRIDE_PROVIDERS } from "@/modules/pricing/overrides";
import { modelRates } from "@/modules/pricing/price";
import {
  type RepriceOptions,
  type RepriceReport,
  runReprice,
  UNMETERED_PRICE_TABLE,
} from "@/modules/pricing/reprice";
import { PRICE_TABLE_VERSION } from "@/modules/pricing/version";
import { Prisma, PrismaClient } from "../generated/prisma/client";

export class UsageError extends Error {}

export function parseRepriceArgs(argv: string[]): RepriceOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      tenant: { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      "price-table": { type: "string" },
      apply: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (!values.tenant) throw new UsageError("--tenant <id|all> is required");
  if (!values.provider) throw new UsageError("--provider is required");
  // NOTE: an `openai-compatible` server that serves one model under no name writes `model: ""`, and
  // a tenant's own price can name that empty model, so an explicit empty value is a real target
  // there; everywhere else it is a typo.
  if (values.model === undefined) throw new UsageError("--model is required");
  if (values.model === "" && values.provider !== "openai-compatible")
    throw new UsageError(
      '--model "" is only an openai-compatible server that serves one model under no name',
    );
  let tenant: bigint | "all";
  if (values.tenant === "all") tenant = "all";
  else if (/^[1-9]\d*$/.test(values.tenant)) tenant = BigInt(values.tenant);
  else throw new UsageError(`--tenant must be an id or "all"`);
  const date = (flag: string, v: string | undefined) => {
    if (v === undefined) return undefined;
    const d = new Date(v);
    if (Number.isNaN(d.getTime()))
      throw new UsageError(`--${flag} is not an ISO date: ${v}`);
    return d;
  };
  const from = date("from", values.from);
  const to = date("to", values.to);
  if (from && to && from >= to)
    throw new UsageError("--from must be before --to");
  const table = values["price-table"];
  if (table === "") throw new UsageError("--price-table needs a value");
  if (table === UNMETERED_PRICE_TABLE)
    throw new UsageError(
      `--price-table ${UNMETERED_PRICE_TABLE}: those calls reported no tokens, so there is nothing to price`,
    );
  // Only the provider is checked here. Whether the model has a price is per row: a tenant's own
  // price can cover a model the table lacks (an `openai-compatible` server, say), and a row nothing
  // prices is left as it was and counted in the report, never refused up front.
  if (
    !(PRICE_OVERRIDE_PROVIDERS as readonly string[]).includes(values.provider)
  )
    throw new UsageError(
      `--provider must be one of ${PRICE_OVERRIDE_PROVIDERS.join(", ")}`,
    );
  return {
    tenant,
    provider: values.provider,
    model: values.model,
    from,
    to,
    priceTable:
      table === undefined ? undefined : table === "none" ? null : table,
    apply: values.apply ?? false,
  };
}

// How long the script settles what it marked before it gives up and exits non-zero. A repricing of two
// months on a tenant three times a large production one settles in about 70 s of steps.
const SETTLE_BUDGET_MS = 10 * 60 * 1000;
const STEP_RETRY_MS = 1000;
// How often a read of the marks before or after the steps is tried, a retry time apart.
const READ_ATTEMPTS = 3;

// A read tried up to READ_ATTEMPTS times: the error of the last attempt when none succeeds.
export async function readWithRetry<T>(
  read: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = Bun.sleep,
  fatal: (err: unknown) => boolean = () => false,
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let error = "";
  for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
    try {
      return { ok: true, value: await read() };
    } catch (err) {
      if (fatal(err)) throw err;
      error = err instanceof Error ? err.message : String(err);
      if (attempt < READ_ATTEMPTS) await sleep(STEP_RETRY_MS);
    }
  }
  return { ok: false, error };
}

export interface SettledTenant {
  tenantId: bigint;
  // Distinct quarters the repricing wrote rows in.
  quarters: number;
  // Of those, the quarters still holding a mark the settle found when it began, once the budget ran
  // out.
  left: number;
  // Of those, the quarters at or above the tenant's sums mark (all of them before its first sums):
  // a row inside the trigger's grace is never marked, and a step drops a mark there without a sum,
  // so they are read from the rows until the job sums up to them.
  aboveMark: number;
  // Of those, the quarters holding only marks that became visible after the settle began, when every
  // tenant was settled: read from the rows until the job settles them.
  remarked: number;
  // The last error a read of the marks or a step threw during the rounds, when one did.
  stepError?: string;
  // Why what is left could not be read, when it could not: the counts above then say nothing.
  unread?: string;
}

// Settles the quarters a repricing wrote, by running the LEDGER_SUMS job's own step until none of the
// marks visible on them when it begins is left: the step recounts a marked quarter and deletes only
// the marks it read, so a mark of concurrent traffic is never lost, and each step is one short
// transaction. The step relies on RLS for its tenant, so it runs on a role RLS binds and never on the
// superuser URL. What is left is read for every tenant at the end, after the last one is settled.
export async function settleRepricedQuarters(
  db: PrismaClient,
  written: ReadonlyMap<bigint, ReadonlySet<number>>,
  {
    now = Date.now,
    deadline = now() + SETTLE_BUDGET_MS,
    step = stepLedgerSums,
    sleep = Bun.sleep,
  }: {
    now?: () => number;
    deadline?: number;
    step?: typeof stepLedgerSums;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<SettledTenant[]> {
  // A role refusal ends the run, while a connection that fails is retried and then reported, since the
  // prices are already written by now.
  const guard = await readWithRetry(
    () => assertRuntimeRoleIsNotSuperuser(db, { allow: false }),
    sleep,
    (err) => err instanceof RuntimeIsolationError,
  );
  const unread = (error: string): SettledTenant[] =>
    [...written].map(([tenantId, set]) => ({
      tenantId,
      quarters: set.size,
      left: 0,
      aboveMark: 0,
      remarked: 0,
      unread: error,
    }));
  if (!guard.ok) return unread(guard.error);
  // The marks to settle are the ones visible now, by id, read for every tenant in one statement: an id
  // is taken before its write commits, so no cutoff on the id tells a mark seen now from one that
  // becomes visible later.
  const pairs = [...written].flatMap(([tenantId, set]) =>
    [...set].map((q) => [tenantId, new Date(q)] as const),
  );
  const seen = await readWithRetry(
    () =>
      asSuperAdminOn(db, (tx) =>
        tx.$queryRaw<{ tenant_id: bigint; id: bigint }[]>(Prisma.sql`
          SELECT m.tenant_id, m.id FROM ledger_sum_marks m
            JOIN unnest(${pairs.map(([t]) => t.toString())}::bigint[],
                        ${pairs.map(([, q]) => q)}::timestamp[]) AS w(tenant_id, quarter)
              ON m.tenant_id = w.tenant_id AND m.quarter = w.quarter`),
      ),
    sleep,
  );
  if (!seen.ok) return unread(seen.error);
  const ours = new Map<bigint, bigint[]>(
    [...written.keys()].map((t) => [t, []]),
  );
  for (const r of seen.value) ours.get(r.tenant_id)?.push(r.id);
  // The tenant's marks still there, which replace the list: it only shrinks.
  const pending = async (tenantId: bigint) => {
    const rows = await asSuperAdminOn(db, (tx) =>
      tx.$queryRaw<{ id: bigint }[]>(
        Prisma.sql`SELECT id FROM ledger_sum_marks
                    WHERE id = ANY(${ours.get(tenantId) ?? []}::bigint[])`,
      ),
    );
    ours.set(
      tenantId,
      rows.map((r) => r.id),
    );
    return rows.length > 0;
  };
  // One step per tenant per round, so a tenant whose steps keep failing does not spend the others'
  // budget, and a tenant whose step failed waits its own retry time while the others go on.
  const errors = new Map<bigint, string>();
  const retryAt = new Map<bigint, number>();
  let open = [...ours].filter(([, ids]) => ids.length > 0).map(([t]) => t);
  while (open.length > 0 && now() < deadline) {
    const next: bigint[] = [];
    let ran = false;
    for (const tenantId of open) {
      if (now() >= deadline) break;
      if ((retryAt.get(tenantId) ?? 0) > now()) {
        next.push(tenantId);
        continue;
      }
      try {
        if (!(await pending(tenantId))) continue;
        if (now() >= deadline) break;
        ran = true;
        await step(db, tenantId);
      } catch (err) {
        // NOTE: the job's own step on the same tenant holds the state row, and a step that waits on it
        // past the lock timeout throws, as can the read of the marks behind a lock. The job's step may
        // settle them, so they are read again after the tenant's retry time, while the budget lasts.
        errors.set(tenantId, err instanceof Error ? err.message : String(err));
        retryAt.set(tenantId, now() + STEP_RETRY_MS);
      }
      next.push(tenantId);
    }
    open = next;
    if (!ran && open.length > 0) {
      const at = Math.min(...open.map((t) => retryAt.get(t) ?? 0));
      await sleep(Math.max(0, Math.min(at, deadline) - now()));
    }
  }
  // What is left, for every tenant in one statement.
  const allOurs = [...ours.values()].flat();
  const final = await readWithRetry(
    () =>
      asSuperAdminOn(db, (tx) =>
        tx.$queryRaw<
          {
            tenant_id: bigint;
            left: number;
            remarked: number;
            mark: Date | null;
          }[]
        >(Prisma.sql`
          WITH q AS (
            SELECT m.tenant_id, m.quarter, bool_or(m.id = ANY(${allOurs}::bigint[])) AS ours
              FROM ledger_sum_marks m
              JOIN unnest(${pairs.map(([t]) => t.toString())}::bigint[],
                          ${pairs.map(([, q]) => q)}::timestamp[]) AS w(tenant_id, quarter)
                ON m.tenant_id = w.tenant_id AND m.quarter = w.quarter
             GROUP BY 1, 2)
          SELECT t.tenant_id,
                 COUNT(*) FILTER (WHERE q.ours)::int AS left,
                 COUNT(*) FILTER (WHERE NOT q.ours)::int AS remarked,
                 (SELECT summed_until FROM ledger_sums_state s WHERE s.tenant_id = t.tenant_id) AS mark
            FROM unnest(${[...written.keys()].map((t) => t.toString())}::bigint[]) AS t(tenant_id)
            LEFT JOIN q ON q.tenant_id = t.tenant_id
           GROUP BY t.tenant_id`),
      ),
    sleep,
  );
  return [...written].map(([tenantId, set]) => {
    const quarters = [...set];
    const stepError = errors.get(tenantId);
    const base = {
      tenantId,
      quarters: quarters.length,
      left: 0,
      aboveMark: 0,
      remarked: 0,
      ...(stepError === undefined ? {} : { stepError }),
    };
    if (!final.ok) return { ...base, unread: final.error };
    const row = final.value.find((r) => r.tenant_id === tenantId);
    const mark = row?.mark?.getTime() ?? Number.NEGATIVE_INFINITY;
    return {
      ...base,
      left: row?.left ?? 0,
      aboveMark: quarters.filter((q) => q >= mark).length,
      remarked: row?.remarked ?? 0,
    };
  });
}

// A write that failed after some batches committed, with what the settle made of those.
export class RepriceWriteError extends Error {
  constructor(
    cause: unknown,
    readonly settled: SettledTenant[],
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "RepriceWriteError";
  }
}

// The repricing, and with `apply` the settle of the quarters it wrote. When a batch fails, the
// batches already committed are settled before the error is thrown, since a run again skips their
// rows, now at their price, and would leave their quarters marked.
export async function repriceAndSettle(
  db: PrismaClient,
  opts: RepriceOptions,
): Promise<{ report: RepriceReport; settled: SettledTenant[] }> {
  // Before the first write: a role RLS does not bind could not settle what it writes.
  if (opts.apply) await assertRuntimeRoleIsNotSuperuser(db, { allow: false });
  const written = new Map<bigint, Set<number>>();
  let report: RepriceReport;
  try {
    report = await runReprice(db, { ...opts, writtenQuarters: written });
  } catch (err) {
    throw new RepriceWriteError(
      err,
      opts.apply && written.size > 0
        ? await settleRepricedQuarters(db, written)
        : [],
    );
  }
  return {
    report,
    settled:
      opts.apply && report.written > 0
        ? await settleRepricedQuarters(db, written)
        : [],
  };
}

// Whether the run exits 1: a mark found when the settle began is still there, or what is left could
// not be read. A quarter marked again during the settle does not count.
export function settleFailed(settled: readonly SettledTenant[]): boolean {
  return settled.some((t) => t.left > 0 || t.unread !== undefined);
}

// What the settle did for a tenant, as the script prints it.
export function settleReport(t: SettledTenant): string[] {
  if (t.unread !== undefined)
    return [
      `tenant ${t.tenantId} · what is still marked of ${t.quarters} repriced quarters could not be read (${t.unread}): the dashboard job settles them, read from the rows until then`,
    ];
  const lines =
    t.left > 0
      ? [
          `tenant ${t.tenantId} · ${t.left} of ${t.quarters} repriced quarters still marked: the dashboard job settles them, read from the rows until then`,
        ]
      : [
          `tenant ${t.tenantId} · dashboard sums settled for ${t.quarters} repriced quarters`,
        ];
  if (t.aboveMark > 0)
    lines.push(
      `  ${t.aboveMark} of them above the dashboard sums' mark: read from the rows until the job sums up to them`,
    );
  if (t.remarked > 0)
    lines.push(
      `  ${t.remarked} of them marked again by later writes: read from the rows until the job settles them`,
    );
  if (t.stepError !== undefined)
    lines.push(`  a settle read or step failed: ${t.stepError}`);
  return lines;
}

const usd = (d: { toFixed(n: number): string }) => `$${d.toFixed(6)}`;

// An applied run that changed no row marked no quarter, and says so rather than staying silent.
const NOTHING_SETTLED =
  "dashboard sums settled for 0 repriced quarters: no row changed";

async function main() {
  let opts: RepriceOptions;
  try {
    opts = parseRepriceArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(
      "Usage: bun scripts/reprice-usage.ts --tenant <id|all> --provider <p> --model <m> [--from <ISO>] [--to <ISO>] [--price-table <v|none>] [--apply]",
    );
    process.exit(2);
  }

  // The runtime role, for the writes and the settle alike: the runner enters the fleet role per
  // batch to reach every tenant, and the settle runs the dashboard job's step, which only RLS scopes
  // to its tenant. One connection, so the marks it settles are the ones its writes appended.
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL (the runtime role) is required");
    process.exit(1);
  }
  // The pool's lock timeout and connect bound, as the app's pool has them: a step queued behind the
  // job's own step on the same tenant gives up in seconds and is retried, and a server that accepts
  // the connection and never answers fails the run instead of holding it.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({
      ...withSessionOptions(url),
      ...lockTimeoutOption(),
      ...connectTimeoutOption(),
    }),
  });
  try {
    let report: RepriceReport;
    let settled: SettledTenant[];
    try {
      ({ report, settled } = await repriceAndSettle(prisma, opts));
    } catch (err) {
      if (!(err instanceof RepriceWriteError)) throw err;
      console.error(`The repricing stopped on an error: ${err.message}`);
      for (const t of err.settled) console.log(settleReport(t).join("\n"));
      process.exitCode = 1;
      return;
    }
    console.log(
      `${opts.apply ? "APPLY" : "DRY RUN"} · provider ${opts.provider} · table now ${PRICE_TABLE_VERSION}`,
    );
    if (modelRates(opts.provider, opts.model) === null)
      console.log(
        `The price table has no price for ${opts.provider} ${opts.model}: only rows a tenant's own price covers can change.`,
      );
    if (report.groups.length === 0) {
      console.log("No rows match.");
      if (opts.apply) console.log(NOTHING_SETTLED);
      return;
    }
    for (const g of report.groups) {
      console.log(
        [
          `tenant ${g.tenantId} · ${g.model}`,
          `  rows matched ${g.matched}, ${opts.apply ? "changed" : "would change"} ${g.changed}, unchanged ${g.unchanged}, no price now ${g.unpriceable} (left as they are)`,
          `  total before ${usd(g.beforeUsd)} (${g.unpricedBefore} unpriced), after ${usd(g.afterUsd)} (${g.unpricedAfter} unpriced)`,
        ].join("\n"),
      );
    }
    console.log(
      opts.apply
        ? `Wrote ${report.written} rows, each stamped with what priced it now (the tenant's own price, or ${PRICE_TABLE_VERSION}).`
        : "Nothing written. Re-run with --apply to write.",
    );
    if (opts.apply && settled.length === 0) console.log(NOTHING_SETTLED);
    for (const t of settled) console.log(settleReport(t).join("\n"));
    if (settleFailed(settled)) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) await main();
