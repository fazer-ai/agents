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
import { assertRuntimeRoleIsNotSuperuser } from "@/lib/db-guard";
import { withSessionOptions } from "@/lib/session-zone";
import { asSuperAdminOn } from "@/lib/tenancy";
import { stepLedgerSums } from "@/modules/analytics/ledger-sums";
import { PRICE_OVERRIDE_PROVIDERS } from "@/modules/pricing/overrides";
import { modelRates } from "@/modules/pricing/price";
import {
  type RepriceOptions,
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
  // The last error a step threw, when one did: the step is retried until the budget runs out.
  stepError?: string;
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
  }: {
    now?: () => number;
    deadline?: number;
    step?: typeof stepLedgerSums;
  } = {},
): Promise<SettledTenant[]> {
  await assertRuntimeRoleIsNotSuperuser(db, { allow: false });
  const onQuarters = (tenantId: bigint) =>
    Prisma.sql`FROM ledger_sum_marks
         WHERE tenant_id = ${tenantId}
           AND quarter = ANY(${[...(written.get(tenantId) ?? [])].map((q) => new Date(q))}::timestamp[])`;
  // The marks to settle are the ones visible now, by id: an id is taken before its write commits, so
  // no cutoff on the id tells a mark seen now from one that becomes visible later.
  const ours = new Map<bigint, bigint[]>();
  for (const tenantId of written.keys()) {
    const rows = await asSuperAdminOn(db, (tx) =>
      tx.$queryRaw<{ id: bigint }[]>(
        Prisma.sql`SELECT id ${onQuarters(tenantId)}`,
      ),
    );
    ours.set(
      tenantId,
      rows.map((r) => r.id),
    );
  }
  const pending = async (tenantId: bigint) => {
    const [row] = await asSuperAdminOn(db, (tx) =>
      tx.$queryRaw<{ any: boolean }[]>(
        Prisma.sql`SELECT EXISTS (SELECT 1 FROM ledger_sum_marks
                    WHERE id = ANY(${ours.get(tenantId) ?? []}::bigint[])) AS any`,
      ),
    );
    return Boolean(row?.any);
  };
  // One step per tenant per round, so a tenant whose steps keep failing does not spend the others'
  // budget.
  const errors = new Map<bigint, string>();
  let open = [...written.keys()];
  while (open.length > 0 && now() < deadline) {
    const next: bigint[] = [];
    let failed = false;
    for (const tenantId of open) {
      if (now() >= deadline) {
        next.push(tenantId);
        continue;
      }
      if (!(await pending(tenantId))) continue;
      try {
        await step(db, tenantId);
      } catch (err) {
        // NOTE: the job's own step on the same tenant holds the state row, and a step that waits on it
        // past its transaction budget throws. The tenant is retried in the next round, since that
        // step may have settled its marks, while the budget lasts.
        errors.set(tenantId, err instanceof Error ? err.message : String(err));
        failed = true;
      }
      next.push(tenantId);
    }
    if (failed) await Bun.sleep(STEP_RETRY_MS);
    open = next;
  }
  const out: SettledTenant[] = [];
  for (const [tenantId, set] of written) {
    const quarters = [...set];
    const [row] = await asSuperAdminOn(db, (tx) =>
      tx.$queryRaw<{ left: number; remarked: number; mark: Date | null }[]>(
        Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE q.ours)::int AS left,
               COUNT(*) FILTER (WHERE NOT q.ours)::int AS remarked,
               (SELECT summed_until FROM ledger_sums_state WHERE tenant_id = ${tenantId}) AS mark
          FROM (SELECT quarter, bool_or(id = ANY(${ours.get(tenantId) ?? []}::bigint[])) AS ours
                  ${onQuarters(tenantId)}
                 GROUP BY quarter) q`,
      ),
    );
    const mark = row?.mark?.getTime() ?? Number.NEGATIVE_INFINITY;
    const stepError = errors.get(tenantId);
    out.push({
      tenantId,
      quarters: quarters.length,
      left: row?.left ?? 0,
      aboveMark: quarters.filter((q) => q >= mark).length,
      remarked: row?.remarked ?? 0,
      ...(stepError === undefined ? {} : { stepError }),
    });
  }
  return out;
}

// What the settle did for a tenant, as the script prints it.
export function settleReport(t: SettledTenant): string[] {
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
    lines.push(`  a settle step failed and was retried: ${t.stepError}`);
  return lines;
}

const usd = (d: { toFixed(n: number): string }) => `$${d.toFixed(6)}`;

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
  const prisma = new PrismaClient({
    adapter: new PrismaPg(withSessionOptions(url)),
  });
  try {
    if (opts.apply)
      await assertRuntimeRoleIsNotSuperuser(prisma, { allow: false });
    const report = await runReprice(prisma, opts);
    console.log(
      `${opts.apply ? "APPLY" : "DRY RUN"} · provider ${opts.provider} · table now ${PRICE_TABLE_VERSION}`,
    );
    if (modelRates(opts.provider, opts.model) === null)
      console.log(
        `The price table has no price for ${opts.provider} ${opts.model}: only rows a tenant's own price covers can change.`,
      );
    if (report.groups.length === 0) {
      console.log("No rows match.");
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
    if (opts.apply && report.written > 0) {
      const settled = await settleRepricedQuarters(
        prisma,
        report.writtenQuarters,
      );
      for (const t of settled) console.log(settleReport(t).join("\n"));
      if (settled.some((t) => t.left > 0)) process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) await main();
