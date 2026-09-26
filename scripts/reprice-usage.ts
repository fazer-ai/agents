#!/usr/bin/env bun

// Re-prices ledger rows (`llm_usage.cost_usd`) with the price table in the tree now, for when the
// table that priced them was wrong (issue #867). Dry run unless `--apply`.
//
//   bun scripts/reprice-usage.ts --tenant <id|all> --provider <provider> --model <model>
//     [--from <ISO date>] [--to <ISO date>] [--price-table <litellm@…|none>] [--apply]
//
// `--provider` is required because the ledger does not record it and the table cannot infer it
// (see src/modules/pricing/reprice.ts). `--from` is inclusive and `--to` exclusive. Without
// `--price-table` the run covers every row something priced; `none` covers the rows written before
// the column, which no table priced. Each row is priced as the capture would price it now: the
// tenant's own price first, then what OpenRouter reported (never replaced by the table), then the
// table.

import { parseArgs } from "node:util";
import { PrismaPg } from "@prisma/adapter-pg";
import { PRICE_OVERRIDE_PROVIDERS } from "@/modules/pricing/overrides";
import { modelRates } from "@/modules/pricing/price";
import { type RepriceOptions, runReprice } from "@/modules/pricing/reprice";
import { PRICE_TABLE_VERSION } from "@/modules/pricing/version";
import { PrismaClient } from "../generated/prisma/client";

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
  if (!values.model) throw new UsageError("--model is required");
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

  // NOTE: the migration/superuser URL, like the other maintenance scripts. The runner enters the
  // fleet role per batch, so the runtime role's DATABASE_URL reaches every tenant too.
  const url = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is required");
    process.exit(1);
  }
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  try {
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
        ? `Wrote ${report.written} rows, stamped ${PRICE_TABLE_VERSION}.`
        : "Nothing written. Re-run with --apply to write.",
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (import.meta.main) await main();
